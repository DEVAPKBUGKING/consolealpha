"use client";

// HP sebagai controller. Dua cara masuk:
//  - dari QR di layar: /join?c=KODE, langsung tersambung
//  - mengetik kode di formulir
// Tampilan controller mengikuti fase yang dikirim layar: lobi (host menekan MULAI),
// menu (tombol arah + OK), hitung mundur, lomba (ketuk cepat), hasil.

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LinkClient } from "../../lib/link";
import type { CloseReason, LinkStatus } from "../../lib/link";
import { MIN_PLAYERS } from "../../lib/party";
import type { PublicState, ToController, ToScreen } from "../../lib/party";
import { APP_NAME, RELAY_URL } from "../../lib/config";
import DPad from "../../components/DPad";
import PlayerBadge from "../../components/PlayerBadge";
import StatusBanner from "../../components/StatusBanner";

const NICK_KEY = "link:nick";
const ACTIVE_KEY = "link:active";
const tokenKey = (code: string) => `link:dt:${code}`;
const PING_EVERY_MS = 2000;

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
  const [pub, setPub] = useState<PublicState | null>(null);
  const [pos, setPos] = useState<Record<number, number>>({});
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
    setPub(null);
    setPos({});
    setRtts([]);
    setStatus("connecting");
    setReason(undefined);

    const sync = () => linkRef.current?.send(0, { k: "sync" } satisfies ToScreen);
    const link = new LinkClient({
      relayUrl: RELAY_URL,
      code: active,
      role: "controller",
      token: store("session")?.getItem(tokenKey(active)) ?? undefined,
      nickname: store("local")?.getItem(NICK_KEY) ?? "",
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
        sync(); // minta status terbaru dari layar
      },
      onJoined: (d) => {
        if (d.role === "screen") sync(); // layar baru tersambung (misalnya dimuat ulang)
      },
      onMessage: (_from, data) => {
        const m = data as ToController | null;
        if (!m || typeof m !== "object") return;
        if (m.k === "state") setPub(m);
        else if (m.k === "race") setPos(m.pos);
        else if (m.k === "pong" && typeof m.ts === "number") {
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

  // Ukur jeda bolak-balik ke layar secara berkala.
  useEffect(() => {
    if (status !== "open") return;
    const ping = () => linkRef.current?.send(0, { k: "ping", ts: performance.now() } satisfies ToScreen);
    ping();
    const t = setInterval(ping, PING_EVERY_MS);
    return () => clearInterval(t);
  }, [status]);

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

  const send = (data: ToScreen) => {
    const ok = linkRef.current?.send(0, data);
    if (ok) navigator.vibrate?.(8);
  };

  const join = (e: { preventDefault(): void }) => {
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
  const ready = status === "open";
  const ping = rtts.length > 0 ? Math.round(median(rtts)) : null;
  const isHost = pub !== null && myId !== null && pub.host === myId;
  const isRacer = pub !== null && myId !== null && pub.racers.includes(myId);
  const myPos = myId !== null ? Math.min(100, pos[myId] ?? 0) : 0;
  const myResult = pub && myId !== null ? pub.results.find((r) => r.id === myId) : undefined;

  let body: React.ReactNode;
  if (!pub) {
    body = <p className="muted">Menunggu layar…</p>;
  } else if (pub.phase === "lobby") {
    body = (
      <div className="stack ctl-center">
        <p className="title">{pub.players} pemain</p>
        {isHost ? (
          <>
            <button
              className="btn btn-primary btn-xl"
              disabled={!pub.canStart || !ready}
              onClick={() => send({ k: "start" })}
            >
              MULAI
            </button>
            <p className="muted small">
              {pub.canStart ? "Kamu host. Semua sudah siap? Tekan MULAI." : `Kamu host. Butuh minimal ${MIN_PLAYERS} pemain untuk mulai.`}
            </p>
          </>
        ) : (
          <p className="muted">Menunggu host memulai…</p>
        )}
      </div>
    );
  } else if (pub.phase === "menu") {
    body = isHost ? (
      <div className="stack ctl-center">
        <p className="muted small">Pilih game di layar besar.</p>
        <DPad disabled={!ready} onPress={(d) => send({ k: "nav", d })} />
        <button className="btn btn-ghost" disabled={!ready} onClick={() => send({ k: "nav", d: "back" })}>
          Kembali
        </button>
      </div>
    ) : (
      <p className="muted">Host sedang memilih game…</p>
    );
  } else if (pub.phase === "countdown") {
    body = (
      <div className="stack ctl-center">
        <p className="muted">{isRacer ? "Bersiap! Ketuk secepat mungkin setelah aba-aba." : "Ronde segera dimulai. Kamu ikut ronde berikutnya."}</p>
        <div className="countdown" aria-live="assertive">
          {pub.countdown ?? ""}
        </div>
      </div>
    );
  } else if (pub.phase === "race") {
    body = isRacer ? (
      <div className="race-ctl">
        <div
          className="progress"
          role="progressbar"
          aria-label="Jarak tempuh"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(myPos)}
        >
          <div className="progress-fill" style={{ width: `${myPos}%` }} />
        </div>
        <button
          className="pad"
          disabled={!ready}
          onPointerDown={(e) => {
            e.preventDefault();
            send({ k: "tap" });
          }}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              send({ k: "tap" });
            }
          }}
          aria-label="Lari"
        >
          LARI!
        </button>
      </div>
    ) : (
      <p className="muted">Ronde sedang berjalan. Kamu ikut ronde berikutnya.</p>
    );
  } else {
    body = (
      <div className="stack ctl-center">
        <p className="display">{myResult ? (myResult.place === 1 ? "Juara 1!" : `Urutan ${myResult.place}`) : "Selesai"}</p>
        <ol className="mini-results">
          {pub.results.map((r) => (
            <li key={r.id} className={r.id === myId ? "mine" : undefined}>
              <span>{r.place}.</span> <span>{r.name}</span>
            </li>
          ))}
        </ol>
        {isHost ? (
          <div className="stack-row">
            <button className="btn btn-primary btn-lg" disabled={!ready} onClick={() => send({ k: "nav", d: "ok" })}>
              Lanjut
            </button>
            <button className="btn btn-secondary btn-lg" disabled={!ready} onClick={() => send({ k: "nav", d: "back" })}>
              Ke lobi
            </button>
          </div>
        ) : (
          <p className="muted">Menunggu host…</p>
        )}
      </div>
    );
  }

  return (
    <main className="controller">
      <header className="controller-head">
        {myId !== null && myId > 0 ? <PlayerBadge id={myId} size={40} /> : <span className="badge-empty" aria-hidden="true" />}
        <div className="grow">
          <div className="player-name">{nick.trim() || "Pemain"}</div>
          <div className="muted small">Kode {active}{isHost ? " · Host" : ""}</div>
        </div>
        <button className="btn btn-ghost" onClick={leave}>
          Keluar
        </button>
      </header>

      <StatusBanner status={status} reason={reason} />
      {pub?.notice && (
        <div className="banner" role="status">
          {pub.notice}
        </div>
      )}

      <section className="ctl-main">{body}</section>

      <footer className="stats" aria-live="off">
        <span>Pemain: {pub ? pub.players : "–"}</span>
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
