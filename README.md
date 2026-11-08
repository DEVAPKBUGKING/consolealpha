# Main Bareng (nama sementara)

Layar besar (TV atau laptop) jadi konsol, HP jadi controller. Tanpa instal, langsung dari browser.
Ini klon gratis konsep AirConsole, dengan game orisinal. Nama dan tampilan masih placeholder.

## Isi repo

| folder | isi | di-deploy ke |
| --- | --- | --- |
| `apps/relay` | relay realtime: Cloudflare Worker + Durable Object (satu objek per kode sesi) | Cloudflare |
| `apps/web` | situs: halaman layar (`/screen`), halaman controller (`/join`) | Vercel |
| `replica/` | dokumen perencanaan (recon, arsitektur, desain), jika Anda menyalinnya | |

## Status

Vertical slice: layar menampilkan kode dan QR, HP bergabung, satu tombol mengetuk dan menampilkan
jeda bolak-balik. Belum ada game, katalog, akun, atau platform developer (lihat `replica/architecture.md`).

## Cara kerja singkat

1. Layar memanggil `POST /v1/sessions` di relay dan mendapat `code` (5 huruf konsonan) dan `host_token`.
2. Layar membuka WebSocket ke `/v1/ws/KODE` dan mengirim `hello` dengan `host_token`.
3. HP membuka `/join`, memasukkan kode (atau memindai QR), lalu `hello` sebagai controller.
4. Pesan antar perangkat lewat relay: `{t:"msg", to: <id|"all">, data: ...}`. Layar selalu `id 0`.

## Perintah (di laptop, bila ada)

```
cd apps/relay && npm install && npm test     # 33 tes: logika relay dan kontrak klien-relay
cd apps/relay && npm run dev                 # relay lokal (wrangler dev)
cd apps/web   && npm install && npm run dev  # situs lokal di http://localhost:3000
```

Di `apps/web`, buat `.env.local` berisi `NEXT_PUBLIC_RELAY_URL=http://localhost:8787` untuk uji lokal.
