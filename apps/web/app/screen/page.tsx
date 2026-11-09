"use client";

// Layar utama (TV atau laptop): membuat sesi, menampilkan kode dan QR, menunjukkan pemain.
// Vertical slice: setiap ketukan dari HP menaikkan penghitung, dan layar membalas "ack"
// supaya HP bisa mengukur waktu bolak-balik (ping).

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { LinkClient } from "../../lib/link";
import type { CloseReason, Device, LinkStatus } from "../../lib/link";
import { APP_NAME, RELAY_URL } from "../../lib/config";
import PlayerBadge from "../../components/PlayerBadge";
import StatusBanner from "../../components/StatusBanner";

type Saved = { code: string; hostToken: string };
const KEY = "link:screen";

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
  if (!r.ok) throw new Error(r.status === 429 ? "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi." : "Relay tidak bisa dihubungi.");
  const j = (await r.json()) as { code: string; host_token: string };
  return { code: j.code, hostToken: j.host_token };
}

export default function ScreenPage() {
  const [epoch, setEpoch] = useState(0);
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<LinkStatus>("connecting");
  const [reason, setReason] = useState<CloseReason | undefined>();
  const [players, setPlayers] = useState<Device[]>([]);
  const [taps, setTaps] = useState<Record<number, number>>({});
  const [qr, setQr] = useState("");
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const linkRef = useRef<LinkClient | null>(null);

  useEffect(() => {
    document.documentElement.dataset.surface = "tv";
    setOrigin(window.location.origin);
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, []);

  useEffect(() => {
    if (!RELAY_URL) {
      setError("Alamat relay belum diatur (NEXT_PUBLIC_RELAY_URL).");
      return;
    }
    let cancelled = false;
    let link: LinkClient | null = null;
    setError(null);
    setStatus("connecting");
    setReason(undefined);
    setPlayers([]);
    setTaps({});

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
        link = new LinkClient({
          relayUrl: RELAY_URL,
          code: s.code,
          role: "screen",
          token: s.hostToken,
          onStatus: (st, r) => {
            setStatus(st);
            setReason(r);
          },
          onWelcome: (w) => setPlayers(w.devices.filter((d) => d.role === "controller")),
          onJoined: (d) => {
            if (d.role !== "controller") return;
            setPlayers((p) => [...p.filter((x) => x.id !== d.id), d].sort((a, b) => a.id - b.id));
          },
          onLeft: (id) => setPlayers((p) => p.filter((x) => x.id !== id)),
          onMessage: (from, data) => {
            const m = data as { k?: string; ts?: number } | null;
            if (m && m.k === "tap") {
              setTaps((t) => ({ ...t, [from]: (t[from] ?? 0) + 1 }));
              link?.send(from, { k: "ack", ts: m.ts });
            }
          },
        });
        linkRef.current = link;
        link.start();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Terjadi kesalahan.");
      }
    })();

    return () => {
      cancelled = true;
      link?.stop();
      linkRef.current = null;
    };
  }, [epoch]);

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

  const total = Object.values(taps).reduce((a, b) => a + b, 0);
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
    <main className="tv">
      <section className="stack" aria-label="Cara bergabung">
        <h1 className="title">Gabung dari HP</h1>
        <ol className="steps">
          <li>
            Buka <strong>{origin ? origin.replace(/^https?:\/\//, "") : "…"}/join</strong> di HP
          </li>
          <li>Masukkan kode ini, atau pindai QR</li>
        </ol>
        <div className="code" role="img" aria-label={code ? `Kode sesi: ${code.split("").join(" ")}` : "Kode sesi sedang dibuat"}>
          {code ?? "·····"}
        </div>
        {qr && (
          <div className="qr" role="img" aria-label="QR untuk bergabung" dangerouslySetInnerHTML={{ __html: qr }} />
        )}
      </section>

      <section className="stack" aria-label="Pemain">
        <StatusBanner status={status} reason={reason} />
        {ended && (
          <button className="btn btn-primary btn-lg" onClick={newSession}>
            Buat sesi baru
          </button>
        )}
        <h2 className="title">Pemain ({players.length})</h2>
        {players.length === 0 ? (
          <p className="muted">Belum ada yang bergabung. Buka {APP_NAME} di HP lalu masukkan kodenya.</p>
        ) : (
          <ul className="players" aria-live="polite">
            {players.map((p) => (
              <li key={p.id} className="player">
                <PlayerBadge id={p.id} size={48} />
                <span className="player-name">{p.nickname}</span>
                <span className="count" aria-label={`${taps[p.id] ?? 0} ketukan`}>
                  {taps[p.id] ?? 0}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">Total ketukan: {total}</p>
      </section>
    </main>
  );
}
