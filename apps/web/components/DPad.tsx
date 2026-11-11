// Tombol arah + OK untuk menavigasi menu di layar besar.
// Memakai pointerdown (bukan click) supaya terasa langsung di HP.
import type { Dir } from "../lib/party";

const ROTATION = { up: 0, right: 90, down: 180, left: 270 } as const;

function Arrow({ dir }: { dir: keyof typeof ROTATION }) {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ transform: `rotate(${ROTATION[dir]}deg)`, fill: "currentColor" }}
    >
      <polygon points="12,5 20,18 4,18" />
    </svg>
  );
}

export default function DPad({ onPress, disabled = false }: { onPress: (d: Dir) => void; disabled?: boolean }) {
  return (
    <div className="dpad" role="group" aria-label="Tombol arah">
      <button
        type="button"
        className="dpad-btn dp-up"
        aria-label="Atas"
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          onPress("up");
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            onPress("up");
          }
        }}
      >
        <Arrow dir="up" />
      </button>
      <button
        type="button"
        className="dpad-btn dp-left"
        aria-label="Kiri"
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          onPress("left");
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            onPress("left");
          }
        }}
      >
        <Arrow dir="left" />
      </button>
      <button
        type="button"
        className="dpad-btn dp-ok"
        aria-label="Pilih"
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          onPress("ok");
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            onPress("ok");
          }
        }}
      >
        OK
      </button>
      <button
        type="button"
        className="dpad-btn dp-right"
        aria-label="Kanan"
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          onPress("right");
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            onPress("right");
          }
        }}
      >
        <Arrow dir="right" />
      </button>
      <button
        type="button"
        className="dpad-btn dp-down"
        aria-label="Bawah"
        disabled={disabled}
        onPointerDown={(e) => {
          e.preventDefault();
          onPress("down");
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            onPress("down");
          }
        }}
      >
        <Arrow dir="down" />
      </button>
    </div>
  );
}
