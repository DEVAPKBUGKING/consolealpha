import type { CloseReason, LinkStatus } from "../lib/link";

const CLOSED_TEXT: Record<CloseReason, string | null> = {
  not_found: "Kode tidak ditemukan atau sesi sudah berakhir.",
  expired: "Sesi sudah berakhir.",
  full: "Sesi sudah penuh.",
  replaced: "Dibuka di tab atau perangkat lain.",
  not_allowed: "Tidak diizinkan masuk ke sesi ini.",
  bad_hello: "Sambungan gagal. Coba lagi.",
  stopped: null,
};

export default function StatusBanner({ status, reason }: { status: LinkStatus; reason?: CloseReason }) {
  if (status === "open") return null;
  let kind: "warn" | "bad" = "warn";
  let text: string | null = "Menyambung…";
  if (status === "reconnecting") text = "Koneksi terputus. Mencoba tersambung lagi…";
  if (status === "closed") {
    kind = "bad";
    text = reason ? CLOSED_TEXT[reason] : null;
  }
  if (!text) return null;
  return (
    <div className={`banner banner-${kind}`} role={kind === "bad" ? "alert" : "status"}>
      {text}
    </div>
  );
}
