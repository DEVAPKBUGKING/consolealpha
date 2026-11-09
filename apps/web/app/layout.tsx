import type { Metadata, Viewport } from "next";
import { APP_NAME } from "../lib/config";
import "./tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Layar besar jadi konsol, HP jadi controller. Tanpa instal.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d1017",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
