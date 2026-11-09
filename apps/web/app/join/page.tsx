"use client";

// HP sebagai controller. Dua cara masuk:
//  - dari QR di layar: /join?c=KODE, langsung tersambung (1 aksi: pindai)
//  - mengetik kode di formulir (2 aksi: buka situs, ketik kode)
// Vertical slice: satu tombol besar. Setiap ketukan dikirim ke layar, layar membalas "ack",
// dan HP menampilkan waktu bolak-balik (ping).

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LinkClient } from "../../lib/link";
import type { CloseReason, LinkStatus } from "../../lib/link";
import { APP_NAME, RELAY_URL } from "../../lib/config";
import PlayerBadge from "../../components/PlayerBadge";
import StatusBanner from "../../components/StatusBanner";

const NICK_KEY = "link:nick";
const ACTIVE_KEY = "link:active";
const tokenKey = (code: string) => `link:dt:${code}`;

function cleanCode(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
}
function store(kind: "local" | "session") {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function Controller() {
  const params = useSearchParams();
  const [code, setCode] = useState(cleanCode(params.get("c")));
  const [nick, setNick] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<LinkStatus>("connecting");
  const [reason, setReason] = useState<CloseReason | undefined>();
  const [myId, setMyId] = useState<number | null>(null);
  const [myTaps, setMyTaps] = useState(0);
  const [rtts, setRtts] = useState<number[]>([]);
  const linkRef = useRef<LinkClient | null>(null);

  // Saat dibuka: ambil nama tersimpan; masuk otomatis bila ada kode di URL atau sesi sebelumnya.
  useEffect(() => {
    setNick(store("local")?.getItem(NICK_KEY) ?? "");
    const fromUrl = cleanCode(params.get("c"));
    const fromTab = cleanCode(store("session")?.getItem(ACTIVE_KEY));
    const start = fromUrl.length === 5 ? fromUrl : fromTab.length === 5 ? fromTab : null;
    if (start) {
      setCode(start);
      setActive(start);
    }
  }, []);

  // Sambungan ke relay, selama ada kode aktif.
  useEffect(() => {
    if (!active) return;
    if (!RELAY_URL) {
      setNotice("Alamat relay belum diatur (NEXT_PUBLIC_RELAY_URL).");
      setActive(null);
      return;
    }
    store("session")?.setItem(ACTIVE_KEY, active);
    setNotice(null);
    setMyTaps(0);
    setRtts([]);
    setStatus("connecting");
    setReason(undefined);

    const nickname = store("local")?.getItem(NICK_KEY) ?? "";
    const link = new LinkClient({
      relayUrl: RELAY_URL,
      code: active,
      role: "controller",
      token: store("session")?.getItem(tokenKey(active)) ?? undefined,
      nickname,
      onStatus: (s, r) => {
        setStatus(s);
        setReason(r);
        if (s === "closed" && r && r !== "stopped") {
          // Sesi hilang atau ditolak: kembali ke formulir dengan penjelasan.
          store("session")?.removeItem(ACTIVE_KEY);
          if (r !== "replaced") store("session")?.removeItem(tokenKey(active));
          setActive(null);
          setMyId(null);
          setNotice(
            r === "not_found" || r === "expired"
              ? "Kode tidak ditemukan atau sesi sudah berakhir."
              : r === "full"
                ? "Sesi sudah penuh."
                : r === "replaced"
                  ? "Controller ini dibuka di tab atau perangkat lain."
                  : "Tidak bisa bergabung. Coba lagi.",
          );
        }
      },
      onWelcome: (w) => {
        setMyId(w.deviceId);
        if (w.deviceToken) store("session")?.setItem(tokenKey(active), w.deviceToken);
      },
      onMessage: (_from, data) => {
        const m = data as { k?: string; ts?: number } | null;
        if (m && m.k === "ack" && typeof m.ts === "number") {
          const rtt = performance.now() - m.ts;
          setRtts((r) => [...r.slice(-9), rtt]);
        }
      },
    });
    linkRef.current = link;
    link.start();
    return () => {
      link.stop();
      linkRef.current = null;
    };
  }, [active]);

  // Jaga layar HP tetap menyala selama bermain.
  useEffect(() => {
    if (status !== "open") return;
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        if ("wakeLock" in navigator && document.visibilityState === "visible") {
          lock = await navigator.wakeLock.request("screen");
        }
      } catch {}
    };
    void acquire();
    const onVis = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, [status]);

  const tap = () => {
    const ok = linkRef.current?.send(0, { k: "tap", ts: performance.now() });
    if (ok) {
      setMyTaps((n) => n + 1);
      navigator.vibrate?.(10);
    }
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 5) return;
    const name = nick.trim();
    if (name) store("local")?.setItem(NICK_KEY, name);
    else store("local")?.removeItem(NICK_KEY);
    setActive(code);
  };

  const leave = () => {
    if (active) store("session")?.removeItem(tokenKey(active));
    store("session")?.removeItem(ACTIVE_KEY);
    setActive(null);
    setMyId(null);
    setNotice(null);
  };

  // ------------------------------------------------------------- formulir
  if (!active) {
    return (
      <main className="page center stack">
        <h1 className="display">{APP_NAME}</h1>
        <p className="muted">Masukkan kode yang tampil di layar besar.</p>
        {notice && (
          <div className="banner banner-bad" role="alert">
            {notice}
          </div>
        )}
        <form className="stack field-group" onSubmit={join}>
          <label className="field">
            <span className="label">Kode</span>
            <input
              className="input input-code"
              value={code}
              onChange={(e) => setCode(cleanCode(e.target.value))}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={5}
              placeholder="·····"
              aria-describedby={notice ? undefined : "kode-bantuan"}
            />
          </label>
          <label className="field">
            <span className="label">Nama (boleh dikosongkan)</span>
            <input
              className="input"
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              maxLength={20}
              autoComplete="nickname"
              placeholder="Pemain"
            />
          </label>
          <button className="btn btn-primary btn-lg" type="submit" disabled={code.length !== 5}>
            Gabung
          </button>
        </form>
        <p id="kode-bantuan" className="muted small">
          Kode terdiri dari 5 huruf konsonan.
        </p>
      </main>
    );
  }

  // ----------------------------------------------------------- controller
  const ping = rtts.length > 0 ? Math.round(median(rtts)) : null;
  const ready = status === "open";
  return (
    <main className="controller">
      <header className="controller-head">
        {myId !== null && myId > 0 ? <PlayerBadge id={myId} size={40} /> : <span className="badge-empty" aria-hidden="true" />}
        <div className="grow">
          <div className="player-name">{nick.trim() || "Pemain"}</div>
          <div className="muted small">Kode {active}</div>
        </div>
        <button className="btn btn-ghost" onClick={leave}>
          Keluar
        </button>
      </header>

      <StatusBanner status={status} reason={reason} />

      <button
        className="pad"
        disabled={!ready}
        onPointerDown={(e) => {
          e.preventDefault();
          tap();
        }}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            tap();
          }
        }}
        aria-label="Ketuk"
      >
        {ready ? "KETUK" : "Menunggu sambungan…"}
      </button>

      <footer className="stats" aria-live="off">
        <span>Ketukanmu: {myTaps}</span>
        <span>{ping === null ? "Jeda: –" : `Jeda: ${ping} ms`}</span>
      </footer>
    </main>
  );
}

export default function JoinPage() {
  return (
    <Suspense fallback={<main className="page center">Memuat…</main>}>
      <Controller />
    </Suspense>
  );
}
