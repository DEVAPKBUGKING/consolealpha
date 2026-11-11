// Adegan-adegan di layar besar. Murni tampilan: semua data datang dari View (lib/party.ts).
import { MENU, MIN_PLAYERS, TRACK } from "../lib/party";
import type { View } from "../lib/party";
import PlayerBadge from "./PlayerBadge";

function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="banner" role="status">
      {text}
    </div>
  );
}

function formatTime(ms: number | null): string {
  if (ms === null) return "belum finis";
  return `${(ms / 1000).toFixed(1).replace(".", ",")} dtk`;
}

// ------------------------------------------------------------------- lobi

export function LobbyScene({ view, code, qr, origin }: { view: View; code: string | null; qr: string; origin: string }) {
  const host = view.players.find((p) => p.id === view.hostId);
  const hint =
    view.players.length < MIN_PLAYERS
      ? `Menunggu pemain. Butuh minimal ${MIN_PLAYERS} orang untuk mulai.`
      : `${host?.name ?? "Host"} bisa menekan MULAI di HP-nya.`;
  return (
    <div className="tv">
      <section className="stack" aria-label="Cara bergabung">
        <h1 className="title">Gabung dari HP</h1>
        <ol className="steps">
          <li>
            Buka <strong>{origin ? origin.replace(/^https?:\/\//, "") : "…"}/join</strong> di HP
          </li>
          <li>Masukkan kode ini, atau pindai QR</li>
        </ol>
        <div
          className="code"
          role="img"
          aria-label={code ? `Kode sesi: ${code.split("").join(" ")}` : "Kode sesi sedang dibuat"}
        >
          {code ?? "·····"}
        </div>
        {qr && <div className="qr" role="img" aria-label="QR untuk bergabung" dangerouslySetInnerHTML={{ __html: qr }} />}
      </section>

      <section className="stack" aria-label="Pemain">
        <h2 className="title">Pemain ({view.players.length})</h2>
        {view.players.length === 0 ? (
          <p className="muted">Belum ada yang bergabung.</p>
        ) : (
          <ul className="players" aria-live="polite">
            {view.players.map((p) => (
              <li key={p.id} className="player">
                <PlayerBadge id={p.id} size={48} />
                <span className="player-name">{p.name}</span>
                {p.id === view.hostId && <span className="tag">Host</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">{hint}</p>
        <Notice text={view.notice} />
      </section>
    </div>
  );
}

// ------------------------------------------------------------------- menu

export function MenuScene({ view }: { view: View }) {
  const host = view.players.find((p) => p.id === view.hostId);
  return (
    <div className="scene stack">
      <h1 className="title">Pilih game</h1>
      <ul className="tiles" role="listbox" aria-label="Daftar game">
        {MENU.map((m, i) => {
          const focused = i === view.menuIndex;
          return (
            <li
              key={m.id}
              role="option"
              aria-selected={focused}
              aria-disabled={!m.available}
              className={`tile${focused ? " tile-focus" : ""}${m.available ? "" : " tile-off"}`}
            >
              <span className="tile-title">{m.title}</span>
              <span className="muted small">
                {m.available ? "Ketuk secepat mungkin sampai garis finis." : "Belum tersedia"}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="muted">
        {host ? `${host.name} memilih` : "Host memilih"} dengan tombol panah dan OK di HP (atau panah dan Enter di
        keyboard).
      </p>
      <Notice text={view.notice} />
    </div>
  );
}

// ------------------------------------------------------------- hitung mundur

export function CountdownScene({ view }: { view: View }) {
  return (
    <div className="scene center-scene">
      <p className="title muted">Bersiap…</p>
      <div className="countdown" aria-live="assertive">
        {view.countdown ?? ""}
      </div>
      <p className="muted">Ketuk tombol di HP secepat mungkin setelah aba-aba.</p>
    </div>
  );
}

// ------------------------------------------------------------------- lomba

export function RaceScene({ view }: { view: View }) {
  return (
    <div className="scene stack">
      <h1 className="title">Lomba Lari</h1>
      <ul className="lanes" aria-label="Lintasan">
        {view.racers.map((id) => {
          const pct = Math.max(0, Math.min(100, ((view.pos[id] ?? 0) / TRACK) * 100));
          const done = pct >= 100;
          return (
            <li key={id} className="lane" aria-label={`${view.names[id] ?? "Pemain"}: ${Math.round(pct)} persen`}>
              <span className="lane-name">{view.names[id] ?? "Pemain"}</span>
              <div className="track">
                <div className="finish-line" aria-hidden="true" />
                <div
                  className={`runner${done ? "" : " running"}`}
                  style={{ left: `${pct}%`, transform: `translateX(-${pct}%)` }}
                >
                  <PlayerBadge id={id} size={44} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------- hasil

export function ResultsScene({ view }: { view: View }) {
  const host = view.players.find((p) => p.id === view.hostId);
  return (
    <div className="scene stack">
      <h1 className="title">Hasil lomba</h1>
      <ol className="results">
        {view.results.map((r) => (
          <li key={r.id} className="player">
            <span className="place" aria-label={`Urutan ${r.place}`}>
              {r.place}
            </span>
            <PlayerBadge id={r.id} size={48} />
            <span className="player-name">{r.name}</span>
            <span className="muted">{formatTime(r.time)}</span>
          </li>
        ))}
      </ol>
      <p className="muted">
        {host ? `${host.name}: ` : ""}tekan OK untuk kembali ke menu, atau Kembali untuk ke lobi.
      </p>
      <Notice text={view.notice} />
    </div>
  );
}
