import Link from "next/link";
import { APP_NAME } from "../lib/config";

export default function Home() {
  return (
    <main className="page center stack">
      <h1 className="display">{APP_NAME}</h1>
      <p className="muted">Layar besar jadi konsol, HP jadi controller. Tanpa instal.</p>
      <div className="stack-row">
        <Link className="btn btn-primary btn-lg" href="/screen">
          Jadikan layar ini konsol
        </Link>
        <Link className="btn btn-secondary btn-lg" href="/join">
          Gabung dengan kode
        </Link>
      </div>
    </main>
  );
}
