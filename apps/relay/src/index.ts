// Relay realtime: Worker (pintu masuk HTTP) + Durable Object "Room" (satu per kode sesi).
// Seluruh logika ada di core.ts; file ini hanya menyambungkannya ke Cloudflare.
import { DurableObject } from "cloudflare:workers";
import { LIMITS, RoomCore, generateCode, normalizeCode, originAllowed } from "./core.ts";
import type { Attachment, Conn, Store } from "./core.ts";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
}

// ------------------------------------------------------------ Durable Object

export class Room extends DurableObject<Env> {
  core: RoomCore;
  wrapped = new WeakMap<WebSocket, Conn>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const store: Store = {
      get: <T>(k: string) => ctx.storage.get<T>(k),
      put: (k, v) => ctx.storage.put(k, v),
      deleteAll: () => ctx.storage.deleteAll(),
    };
    this.core = new RoomCore(store, {
      conns: () => ctx.getWebSockets().map((ws) => this.wrap(ws)),
      now: () => Date.now(),
    });
    // "ping" dari klien dijawab "pong" oleh runtime TANPA membangunkan objek ini.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Satu pembungkus per WebSocket, supaya perbandingan identitas (===) di core.ts benar.
  wrap(ws: WebSocket): Conn {
    let c = this.wrapped.get(ws);
    if (c) return c;
    c = {
      send: (d) => {
        try {
          ws.send(d);
        } catch {}
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {}
      },
      getAttachment: () => ws.deserializeAttachment() as Attachment | null,
      setAttachment: (a) => ws.serializeAttachment(a),
      isOpen: () => ws.readyState === 1,
    };
    this.wrapped.set(ws, c);
    return c;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      const { code } = (await request.json()) as { code: string };
      const r = await this.core.create(code);
      if (!r.ok) return new Response("taken", { status: 409 });
      await this.ctx.storage.setAlarm(Date.now() + LIMITS.sweepMs);
      return Response.json({ host_token: r.hostToken });
    }

    if (url.pathname === "/info") return Response.json(await this.core.info());

    if (url.pathname.startsWith("/v1/ws/") && request.headers.get("Upgrade") === "websocket") {
      const info = await this.core.info();
      if (!info.exists) return new Response("not found", { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.core.onOpen(this.wrap(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.core.onMessage(this.wrap(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "bye");
    } catch {}
    await this.core.onClose(this.wrap(ws));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.core.onClose(this.wrap(ws));
  }

  async alarm(): Promise<void> {
    const r = await this.core.sweep();
    if (r === "keep") await this.ctx.storage.setAlarm(Date.now() + LIMITS.sweepMs);
  }
}

// -------------------------------------------------------------------- Worker

// Pembatas laju sederhana per isolate Worker. Ini "usaha terbaik": setiap isolate punya
// hitungan sendiri. Pembatas sungguhan (aturan rate limiting Cloudflare) butuh domain
// terdaftar di Cloudflare dan ditambahkan setelah pindah DNS.
const hits = new Map<string, { n: number; reset: number }>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const h = hits.get(key);
  if (!h || now > h.reset) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  h.n += 1;
  return h.n > max;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function corsFor(request: Request, env: Env): Record<string, string> | null {
  const origin = request.headers.get("Origin");
  if (!originAllowed(origin, env.ALLOWED_ORIGINS)) return null;
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsFor(request, env);
    if (cors === null) return new Response("origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const room = (code: string) => env.ROOM.get(env.ROOM.idFromName(code));

    if (url.pathname === "/health") return json({ ok: true }, 200, cors);

    // Buat sesi baru
    if (url.pathname === "/v1/sessions" && request.method === "POST") {
      if (limited("create:" + ip, 10, 60_000)) return json({ error: "rate_limited" }, 429, cors);
      for (let i = 0; i < 8; i++) {
        const code = generateCode();
        const r = await room(code).fetch("https://room/init", { method: "POST", body: JSON.stringify({ code }) });
        if (r.status === 200) {
          const { host_token } = (await r.json()) as { host_token: string };
          return json({ code, host_token }, 200, cors);
        }
        if (r.status !== 409) break; // 409 = kode sudah dipakai: coba kode lain
      }
      return json({ error: "unavailable" }, 503, cors);
    }

    // Cek apakah kode ada
    const info = url.pathname.match(/^\/v1\/sessions\/([A-Za-z]+)$/);
    if (info && request.method === "GET") {
      if (limited("info:" + ip, 120, 60_000)) return json({ error: "rate_limited" }, 429, cors);
      const code = normalizeCode(info[1]);
      if (!code) return json({ exists: false }, 200, cors);
      const r = await room(code).fetch("https://room/info");
      return json(await r.json(), 200, cors);
    }

    // Sambungan WebSocket
    const ws = url.pathname.match(/^\/v1\/ws\/([A-Za-z]+)$/);
    if (ws && request.headers.get("Upgrade") === "websocket") {
      if (limited("ws:" + ip, 120, 60_000)) return new Response("rate limited", { status: 429 });
      const code = normalizeCode(ws[1]);
      if (!code) return new Response("not found", { status: 404 });
      return room(code).fetch(request);
    }

    return json({ error: "not_found" }, 404, cors);
  },
};
