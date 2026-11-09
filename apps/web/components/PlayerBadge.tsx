// Penanda pemain: warna + nomor + bentuk, jadi tetap terbedakan untuk pemain buta warna.
import type { ReactNode } from "react";

function starPoints(): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = ((-90 + i * 36) * Math.PI) / 180;
    const r = i % 2 === 0 ? 19 : 8.5;
    pts.push(`${(20 + r * Math.cos(a)).toFixed(1)},${(20 + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

// Urutan bentuk mengikuti nomor pemain 1..8.
const SHAPES: ReactNode[] = [
  <circle key="1" cx="20" cy="20" r="18" />,
  <rect key="2" x="3" y="3" width="34" height="34" rx="6" />,
  <polygon key="3" points="20,3 38,36 2,36" />,
  <polygon key="4" points="20,1 39,20 20,39 1,20" />,
  <polygon key="5" points={starPoints()} />,
  <polygon key="6" points="14,2 26,2 26,14 38,14 38,26 26,26 26,38 14,38 14,26 2,26 2,14 14,14" />,
  <path key="7" d="M20 36 C4 24 2 14 8 8 C13 3 19 6 20 10 C21 6 27 3 32 8 C38 14 36 24 20 36 Z" />,
  <polygon key="8" points="20,2 36,11 36,29 20,38 4,29 4,11" />,
];

export function playerNumber(deviceId: number): number {
  return ((Math.max(1, deviceId) - 1) % 8) + 1;
}

export default function PlayerBadge({ id, size = 40 }: { id: number; size?: number }) {
  const n = playerNumber(id);
  return (
    <svg role="img" aria-label={`Pemain ${n}`} width={size} height={size} viewBox="0 0 40 40">
      <g style={{ fill: `var(--color-player-${n})` }}>{SHAPES[n - 1]}</g>
      <text
        x="20"
        y="26"
        textAnchor="middle"
        fontSize="18"
        fontWeight="700"
        style={{ fill: "var(--color-on-player)" }}
      >
        {n}
      </text>
    </svg>
  );
}
