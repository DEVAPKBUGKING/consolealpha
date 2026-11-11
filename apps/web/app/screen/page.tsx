"use client";

// Layar utama (TV atau laptop): membuat sesi, menampilkan kode dan QR, lalu menjalankan
// pesta: lobi -> menu -> hitung mundur -> lomba -> hasil. Logikanya ada di lib/party.ts;
// halaman ini hanya menyambungkan relay, jam, papan ketik, dan tampilan.

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { LinkClient } from "../../lib/link";
import type { CloseReason, LinkStatus } from "../../lib/link";
import { Party, flushOut } from "../../lib/party";
import type { Dir, View } from "../../lib/party";
import { RELAY_URL } from "../../lib/config";
import StatusBanner from "../../components/StatusBanner";
import { CountdownScene, LobbyScene, MenuScene, RaceScene, ResultsScene } from "../../components/ScreenScenes";

type Saved = { code: string; hostToken: string };
const KEY = "link:screen";
const TICK_MS = 50;

const KEY_TO_DIR: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "ok",
  Escape: "back",
  Backspace: "back",
};

function readSaved(): Saved | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return v ? (JSON.parse(v) as Saved) : null;
  } catch {
    return null;
  }
}
function writeSaved(s: Saved | null): void {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {}
}

async function stillExists(code: string): Promise<boolean> {
  try {
    const r = await fetch(`${RELAY_URL}/v1/sessions/${code}`);
    if (!r.ok) return true; // tidak yakin: biarkan LinkClient yang memutuskan
    return ((await r.json()) as { exists?: boolean }).exists === true;
  } catch {
    return true;
  }
}

async function createSession(): Promise<Saved> {
  const r = await fetch(`${RELAY_URL}/v1/sessions`, { method: "POST" });
  if (!r.ok) {
    throw new Error(r.status === 429 ? "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi." : "Relay tidak bisa dihubungi.");
  }
  const j = (await r.json()) as { code: string; host_token: string };
  return { code: j.code, hostToken: j.host_token };
}

export default function ScreenPage() {
  const [epoch, setEpoch] = useState(0);
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<LinkStatus>("connecting");
  const [reason, setReason] = useState<CloseReason | undefined>();
  const [view, setView] = useState<View>(() => new Party().view());
  const [qr, setQr] = useState("");
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const partyRef = useRef<Party | null>(null);

  useEffect(() => {
    document.documentElement.dataset.surface = "tv";
    setOrigin(window.location.origin);
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, []);

  // Sesi, sambungan relay, dan jam permainan.
  useEffect(() => {
    if (!RELAY_URL) {
      setError("Alamat relay belum diatur (NEXT_PUBLIC_RELAY_URL).");
      return;
    }
    let cancelled = false;
    let link: LinkClient | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const party = new Party();
    partyRef.current = party;
    setError(null);
    setStatus("connecting");
    setReason(undefined);
    setView(party.view());

    (async () => {
      try {
        let s = readSaved();
        if (s && !(await stillExists(s.code))) s = null; // sesi lama sudah hilang
        if (!s) {
          s = await createSession();
          writeSaved(s);
        }
        if (cancelled) return;
        setCode(s.code);

        const flush = () => {
          if (link) flushOut(party, link);
        };
        link = new LinkClient({
          relayUrl: RELAY_URL,
          code: s.code,
          role: "screen",
          token: s.hostToken,
          onStatus: (st, r) => {
            setStatus(st);
            setReason(r);
          },
          onWelcome: (w) => {
            // Samakan dengan daftar dari relay: yang keluar saat layar terputus dihapus, yang ada ditambahkan.
            const present = new Set(w.devices.filter((d) => d.role === "controller").map((d) => d.id));
            for (const p of party.view().players) if (!present.has(p.id)) party.leave(p.id, Date.now());
            for (const d of w.devices) if (d.role === "controller") party.join(d.id, d.nickname, Date.now());
            flush();
          },
          onJoined: (d) => {
            if (d.role !== "controller") return;
            party.join(d.id, d.nickname, Date.now());
            flush();
          },
          onLeft: (id) => {
            party.leave(id, Date.now());
            flush();
          },
          onMessage: (from, data) => {
            party.message(from, data, Date.now());
            flush();
          },
        });
        link.start();

        // Jam permainan: hitung mundur, lomba, pemberitahuan. Menggambar ulang hanya bila ada perubahan.
        let seen = -1;
        timer = setInterval(() => {
          party.tick(Date.now());
          flush();
          if (party.version !== seen) {
            seen = party.version;
            setView(party.view());
          }
        }, TICK_MS);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Terjadi kesalahan.");
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      link?.stop();
      partyRef.current = null;
    };
  }, [epoch]);

  // Papan ketik di layar bertindak sebagai host (berguna untuk uji di laptop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = KEY_TO_DIR[e.key];
      if (!d || e.repeat) return;
      e.preventDefault();
      partyRef.current?.navAsHost(d, Date.now());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // QR berisi alamat gabung langsung dengan kode, supaya HP tidak perlu mengetik.
  useEffect(() => {
    if (!code || !origin) return;
    let cancelled = false;
    QRCode.toString(`${origin}/join?c=${code}`, { type: "svg", margin: 1 })
      .then((svg) => {
        if (!cancelled) setQr(svg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, origin]);

  const newSession = () => {
    writeSaved(null);
    setCode(null);
    setQr("");
    setEpoch((e) => e + 1);
  };

  const ended = status === "closed" && reason !== "stopped";

  if (error) {
    return (
      <main className="page center stack">
        <div className="banner banner-bad" role="alert">
          {error}
        </div>
        <button className="btn btn-primary btn-lg" onClick={newSession}>
          Coba lagi
        </button>
      </main>
    );
  }

  return (
    <main className="screen-root">
      <StatusBanner status={status} reason={reason} />
      {ended && (
        <button className="btn btn-primary btn-lg" onClick={newSession}>
          Buat sesi baru
        </button>
      )}

      {view.phase === "lobby" && <LobbyScene view={view} code={code} qr={qr} origin={origin} />}
      {view.phase === "menu" && <MenuScene view={view} />}
      {view.phase === "countdown" && <CountdownScene view={view} />}
      {view.phase === "race" && <RaceScene view={view} />}
      {view.phase === "results" && <ResultsScene view={view} />}

      {view.phase !== "lobby" && code && <div className="corner-code">Kode {code}</div>}
    </main>
  );
}
