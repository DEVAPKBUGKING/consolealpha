// Inti relay: protokol + logika satu ruangan (sesi).
// Sengaja TIDAK mengimpor apa pun dari Cloudflare, supaya bisa diuji di Node.
// Adaptor Durable Object ada di index.ts.

// ---------------------------------------------------------------- konstanta

export const PROTOCOL_VERSION = 1;

// Kode sesi: 5 huruf konsonan saja. Tanpa vokal berarti tidak bisa membentuk kata
// (tidak ada kode yang tak sengaja jadi kata kasar), dan tanpa I/O/0/1 tidak ambigu.
export const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const CODE_LENGTH = 5;

export const LIMITS = {
  maxMessageChars: 4096,
  maxControllers: 12, // controller yang tersambung bersamaan
  maxRegistered: 64, // total perangkat yang pernah mendaftar dalam satu sesi
  ratePerSec: 100,
  burst: 200,
  strikesToKick: 200,
  nicknameMax: 20,
  screenGraceMs: 10 * 60_000, // layar putus lebih dari ini: sesi dihapus
  idleMs: 2 * 60 * 60_000, // tidak ada pesan selama ini: sesi dihapus
  sweepMs: 5 * 60_000, // seberapa sering alarm memeriksa
  unjoinedMs: 30_000, // koneksi yang tidak kunjung hello ditutup
  touchPersistMs: 60_000,
} as const;

// Kode penutupan WebSocket (4000-4999 bebas dipakai aplikasi).
export const CLOSE = {
  replaced: 4000,
  notAllowed: 4003,
  rateLimited: 4008,
  full: 4009,
  expired: 4010,
  badHello: 4011,
} as const;

// ------------------------------------------------------------------ tipe

export type Role = "screen" | "controller";
export type DeviceInfo = { id: number; role: Role; nickname: string };

export type ClientHello = { t: "hello"; v?: number; role: Role; token?: string; nickname?: string };
export type ClientMsg = { t: "msg"; to: number | "all"; data: unknown };
export type ClientMessage = ClientHello | ClientMsg;

export type ServerMessage =
  | { t: "welcome"; v: number; device_id: number; device_token?: string; code: string; devices: DeviceInfo[] }
  | { t: "joined"; device: DeviceInfo }
  | { t: "left"; device_id: number }
  | { t: "msg"; from: number; data: unknown }
  | { t: "error"; code: string };

// ------------------------------------------------------------- utilitas

export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Memilih huruf tanpa bias: byte >= 240 dibuang (240 = 12 x 20).
export function generateCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = "";
  while (out.length < CODE_LENGTH) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const c = input.toUpperCase().replace(/[^A-Z]/g, "");
  if (c.length !== CODE_LENGTH) return null;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return null;
  return c;
}

// Membuang karakter kontrol dan karakter pengacak arah teks (dipakai untuk menyamar).
export function sanitizeNickname(input: unknown, fallback = "Pemain"): string {
  if (typeof input !== "string") return fallback;
  const cleaned = input
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = Array.from(cleaned).slice(0, LIMITS.nicknameMax).join("").trim();
  return cut.length > 0 ? cut : fallback;
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Daftar dipisah koma. Mendukung satu bintang untuk subdomain: https://*.vercel.app
export function originAllowed(origin: string | null, list: string): boolean {
  if (origin === null) return true; // bukan browser (curl, alat uji): CORS tidak berlaku
  for (const raw of list.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === "*") return true;
    const re = new RegExp("^" + entry.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^./]+") + "$");
    if (re.test(origin)) return true;
  }
  return false;
}

export class TokenBucket {
  tokens: number;
  last: number;
  strikes = 0;
  rate: number;
  burst: number;
  constructor(rate: number, burst: number, now: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      if (this.tokens > this.burst / 2) this.strikes = 0;
      return true;
    }
    this.strikes += 1;
    return false;
  }
}

export function parseClientMessage(raw: unknown): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "bad_message" };
  if (raw.length > LIMITS.maxMessageChars) return { ok: false, error: "too_large" };
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bad_message" };
  }
  if (typeof m !== "object" || m === null) return { ok: false, error: "bad_message" };
  const o = m as Record<string, unknown>;
  if (o.t === "hello") {
    if (o.role !== "screen" && o.role !== "controller") return { ok: false, error: "bad_message" };
    return {
      ok: true,
      msg: {
        t: "hello",
        v: typeof o.v === "number" ? o.v : undefined,
        role: o.role,
        token: typeof o.token === "string" ? o.token : undefined,
        nickname: typeof o.nickname === "string" ? o.nickname : undefined,
      },
    };
  }
  if (o.t === "msg") {
    const to = o.to;
    if (to !== "all" && !(typeof to === "number" && Number.isInteger(to) && to >= 0)) {
      return { ok: false, error: "bad_message" };
    }
    return { ok: true, msg: { t: "msg", to, data: o.data === undefined ? null : o.data } };
  }
  return { ok: false, error: "unknown_type" };
}

// ------------------------------------------------------ logika ruangan

export type Attachment = { deviceId: number | null; role: Role | null; openedAt: number };

export interface Conn {
  send(data: string): void;
  close(code: number, reason: string): void;
  getAttachment(): Attachment | null;
  setAttachment(a: Attachment): void;
  isOpen(): boolean;
}
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
}
export interface Host {
  conns(): Conn[];
  now(): number;
}

type Meta = {
  code: string;
  hostToken: string;
  createdAt: number;
  nextDeviceId: number;
  screenLeftAt: number | null;
  lastActive: number;
};
type Devices = Record<string, { token: string; nickname: string }>;
type Online = { conn: Conn; id: number; role: Role };

export class RoomCore {
  store: Store;
  host: Host;
  buckets = new Map<number, TokenBucket>();
  lastWarn = new Map<number, number>();
  lastActiveMem = 0;
  lastPersist = 0;

  constructor(store: Store, host: Host) {
    this.store = store;
    this.host = host;
  }

  async create(code: string): Promise<{ ok: true; hostToken: string } | { ok: false }> {
    if (await this.store.get<Meta>("meta")) return { ok: false };
    const now = this.host.now();
    const meta: Meta = {
      code,
      hostToken: randomHex(16),
      createdAt: now,
      nextDeviceId: 1,
      screenLeftAt: now, // layar belum pernah tersambung: hitung sebagai "baru putus"
      lastActive: now,
    };
    await this.store.put("meta", meta);
    await this.store.put("devices", {});
    this.lastActiveMem = now;
    this.lastPersist = now;
    return { ok: true, hostToken: meta.hostToken };
  }

  async info(): Promise<{ exists: boolean; screen?: boolean; controllers?: number }> {
    const meta = await this.store.get<Meta>("meta");
    if (!meta) return { exists: false };
    const on = this.online();
    return {
      exists: true,
      screen: on.some((d) => d.id === 0),
      controllers: on.filter((d) => d.role === "controller").length,
    };
  }

  onOpen(conn: Conn): void {
    conn.setAttachment({ deviceId: null, role: null, openedAt: this.host.now() });
  }

  async onMessage(conn: Conn, raw: unknown): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return this.error(conn, parsed.error);
    const m = parsed.msg;
    if (m.t === "hello") return this.hello(conn, m);

    const att = conn.getAttachment();
    if (!att || att.deviceId === null) return this.error(conn, "not_joined");
    const id = att.deviceId;
    if (!this.allow(conn, id)) return;

    await this.touch();
    const out = JSON.stringify({ t: "msg", from: id, data: m.data } satisfies ServerMessage);
    if (m.to === "all") {
      for (const d of this.online()) if (d.conn !== conn) d.conn.send(out);
      return;
    }
    const target = this.online().find((d) => d.id === m.to && d.conn !== conn);
    if (!target) return this.error(conn, "not_found");
    target.conn.send(out);
  }

  async onClose(conn: Conn): Promise<void> {
    const att = conn.getAttachment();
    if (!att || att.deviceId === null) return;
    const id = att.deviceId;
    // Sudah digantikan koneksi baru dengan id yang sama: bukan "keluar" sungguhan.
    if (this.online().some((d) => d.conn !== conn && d.id === id)) return;
    this.broadcast({ t: "left", device_id: id }, conn);
    if (id === 0) {
      const meta = await this.store.get<Meta>("meta");
      if (meta) {
        meta.screenLeftAt = this.host.now();
        await this.store.put("meta", meta);
      }
    }
  }

  // Dipanggil alarm secara berkala. "expired" berarti seluruh data sudah dihapus.
  async sweep(): Promise<"keep" | "expired"> {
    const meta = await this.store.get<Meta>("meta");
    const now = this.host.now();
    if (!meta) return "expired";
    const screenOn = this.online().some((d) => d.id === 0);
    const lastActive = Math.max(meta.lastActive, this.lastActiveMem);
    const noScreen = !screenOn && meta.screenLeftAt !== null && now - meta.screenLeftAt > LIMITS.screenGraceMs;
    const idle = now - lastActive > LIMITS.idleMs;
    if (noScreen || idle) {
      for (const c of this.host.conns()) c.close(CLOSE.expired, "expired");
      await this.store.deleteAll();
      return "expired";
    }
    for (const c of this.host.conns()) {
      const a = c.getAttachment();
      if (a && a.deviceId === null && now - a.openedAt > LIMITS.unjoinedMs) c.close(CLOSE.badHello, "no_hello");
    }
    return "keep";
  }

  // ------------------------------------------------------------ privat

  private async hello(conn: Conn, m: ClientHello): Promise<void> {
    const att = conn.getAttachment();
    if (att && att.deviceId !== null) return this.error(conn, "already_joined");
    const meta = await this.store.get<Meta>("meta");
    if (!meta) {
      this.error(conn, "not_found");
      conn.close(CLOSE.expired, "expired");
      return;
    }
    const devices = (await this.store.get<Devices>("devices")) ?? {};
    const nickname = sanitizeNickname(m.nickname);
    let id: number;
    let token: string | undefined;

    if (m.role === "screen") {
      if (typeof m.token !== "string" || !safeEqual(m.token, meta.hostToken)) {
        this.error(conn, "not_allowed");
        conn.close(CLOSE.notAllowed, "not_allowed");
        return;
      }
      id = 0;
      meta.screenLeftAt = null;
    } else {
      let existing: string | undefined;
      if (typeof m.token === "string") {
        const given = m.token;
        existing = Object.keys(devices).find((k) => safeEqual(devices[k].token, given));
      }
      if (existing !== undefined) {
        id = Number(existing);
        token = m.token;
      } else {
        const online = this.online().filter((d) => d.conn !== conn && d.role === "controller").length;
        if (online >= LIMITS.maxControllers || Object.keys(devices).length >= LIMITS.maxRegistered) {
          this.error(conn, "full");
          conn.close(CLOSE.full, "full");
          return;
        }
        id = meta.nextDeviceId;
        meta.nextDeviceId += 1;
        token = randomHex(16);
      }
      devices[String(id)] = { token: token as string, nickname };
    }

    for (const d of this.online()) if (d.conn !== conn && d.id === id) d.conn.close(CLOSE.replaced, "replaced");
    conn.setAttachment({ deviceId: id, role: m.role, openedAt: att ? att.openedAt : this.host.now() });

    meta.lastActive = this.host.now();
    this.lastActiveMem = meta.lastActive;
    this.lastPersist = meta.lastActive;
    await this.store.put("meta", meta);
    if (m.role === "controller") await this.store.put("devices", devices);

    const list = new Map<number, DeviceInfo>();
    for (const d of this.online()) {
      list.set(d.id, { id: d.id, role: d.role, nickname: d.id === 0 ? "" : devices[String(d.id)]?.nickname ?? "" });
    }
    this.send(conn, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      device_id: id,
      device_token: token,
      code: meta.code,
      devices: Array.from(list.values()),
    });
    this.broadcast({ t: "joined", device: list.get(id) as DeviceInfo }, conn);
  }

  private online(): Online[] {
    const out: Online[] = [];
    for (const conn of this.host.conns()) {
      if (!conn.isOpen()) continue;
      const a = conn.getAttachment();
      if (a && a.deviceId !== null && a.role) out.push({ conn, id: a.deviceId, role: a.role });
    }
    return out;
  }

  private allow(conn: Conn, id: number): boolean {
    const now = this.host.now();
    let b = this.buckets.get(id);
    if (!b) {
      b = new TokenBucket(LIMITS.ratePerSec, LIMITS.burst, now);
      this.buckets.set(id, b);
    }
    if (b.take(now)) return true;
    if (b.strikes >= LIMITS.strikesToKick) {
      this.error(conn, "rate_limited");
      conn.close(CLOSE.rateLimited, "rate_limited");
      return false;
    }
    const lw = this.lastWarn.get(id) ?? 0;
    if (now - lw > 1000) {
      this.lastWarn.set(id, now);
      this.error(conn, "rate_limited");
    }
    return false;
  }

  // Catat aktivitas di memori; tulis ke penyimpanan paling sering sekali per menit.
  private async touch(): Promise<void> {
    const now = this.host.now();
    this.lastActiveMem = now;
    if (now - this.lastPersist < LIMITS.touchPersistMs) return;
    this.lastPersist = now;
    const meta = await this.store.get<Meta>("meta");
    if (meta) {
      meta.lastActive = now;
      await this.store.put("meta", meta);
    }
  }

  private send(conn: Conn, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
  }

  private error(conn: Conn, code: string): void {
    this.send(conn, { t: "error", code });
  }

  private broadcast(msg: ServerMessage, except: Conn): void {
    const out = JSON.stringify(msg);
    for (const d of this.online()) if (d.conn !== except) d.conn.send(out);
  }
}
