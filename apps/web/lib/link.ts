// Klien relay untuk browser: dipakai halaman layar dan halaman controller.
// Mengurus: sambung, hello, ping/pong, sambung ulang dengan backoff, dan pemeriksaan
// bahwa sesinya masih ada. Tidak bergantung pada React.

export type Role = "screen" | "controller";
export type Device = { id: number; role: Role; nickname: string };
export type LinkStatus = "connecting" | "open" | "reconnecting" | "closed";
export type CloseReason =
  | "not_found"
  | "not_allowed"
  | "full"
  | "expired"
  | "replaced"
  | "bad_hello"
  | "stopped";

export type Welcome = { deviceId: number; deviceToken?: string; code: string; devices: Device[] };

export type LinkOptions = {
  relayUrl: string; // contoh: https://game-relay.akun-anda.workers.dev
  code: string;
  role: Role;
  token?: string; // layar: host_token. controller: device_token bila sambung ulang.
  nickname?: string;
  onStatus?: (status: LinkStatus, reason?: CloseReason) => void;
  onWelcome?: (w: Welcome) => void;
  onJoined?: (d: Device) => void;
  onLeft?: (id: number) => void;
  onMessage?: (from: number, data: unknown) => void;
  onError?: (code: string) => void;
  // Hanya untuk pengujian:
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  backoffBaseMs?: number;
  pingMs?: number;
};

const TERMINAL: Record<number, CloseReason> = {
  4000: "replaced",
  4003: "not_allowed",
  4009: "full",
  4010: "expired",
  4011: "bad_hello",
};

export function wsUrlFor(relayUrl: string, code: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = `/v1/ws/${code}`;
  u.search = "";
  return u.toString();
}

export class LinkClient {
  opts: LinkOptions;
  status: LinkStatus = "connecting";
  deviceId: number | null = null;
  devices = new Map<number, Device>();

  private ws: WebSocket | null = null;
  private stopped = true;
  private everOpened = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPong = 0;
  private connecting = false;

  constructor(opts: LinkOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.attempts = 0;
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "bye");
    } catch {}
    this.setStatus("closed", "stopped");
  }

  // Mengembalikan false bila belum tersambung (pesan tidak terkirim).
  send(to: number | "all", data: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.deviceId === null) return false;
    ws.send(JSON.stringify({ t: "msg", to, data }));
    return true;
  }

  // ---------------------------------------------------------- internal

  private setStatus(s: LinkStatus, reason?: CloseReason): void {
    this.status = s;
    this.opts.onStatus?.(s, reason);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = this.probeTimer = null;
    this.pingTimer = null;
  }

  private terminate(reason: CloseReason): void {
    this.stopped = true;
    this.clearTimers();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "bye");
    } catch {}
    this.setStatus("closed", reason);
  }

  private async checkExists(): Promise<boolean | undefined> {
    try {
      const f = this.opts.fetchImpl ?? fetch;
      const r = await f(`${this.opts.relayUrl}/v1/sessions/${this.opts.code}`);
      if (!r.ok) return undefined; // batas laju atau gangguan: coba lagi nanti
      const j = (await r.json()) as { exists?: boolean };
      return j.exists === true;
    } catch {
      return undefined; // tidak ada jaringan: coba lagi nanti
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.ws) return;
    this.connecting = true;
    let exists: boolean | undefined;
    try {
      this.setStatus(this.everOpened ? "reconnecting" : "connecting");
      exists = await this.checkExists();
    } finally {
      this.connecting = false;
    }
    if (this.stopped || this.ws) return;
    if (exists === false) return this.terminate("not_found");
    if (exists === undefined) return this.scheduleRetry();

    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new WS(wsUrlFor(this.opts.relayUrl, this.opts.code));
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(
        JSON.stringify({
          t: "hello",
          v: 1,
          role: this.opts.role,
          token: this.opts.token,
          nickname: this.opts.nickname,
        }),
      );
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws === ws) this.onRaw(e.data);
    };
    ws.onclose = (e: CloseEvent) => this.drop(ws, e.code);
    ws.onerror = () => {}; // onclose menyusul dan ditangani di sana
  }

  private onRaw(data: unknown): void {
    if (data === "pong") {
      this.lastPong = Date.now();
      return;
    }
    if (typeof data !== "string") return;
    let m: any;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    switch (m.t) {
      case "welcome": {
        this.deviceId = m.device_id;
        if (typeof m.device_token === "string") this.opts.token = m.device_token;
        this.devices = new Map((m.devices as Device[]).map((d) => [d.id, d]));
        this.attempts = 0;
        this.everOpened = true;
        this.startPing();
        this.setStatus("open");
        this.opts.onWelcome?.({
          deviceId: m.device_id,
          deviceToken: m.device_token,
          code: m.code,
          devices: Array.from(this.devices.values()),
        });
        break;
      }
      case "joined":
        this.devices.set(m.device.id, m.device);
        this.opts.onJoined?.(m.device);
        break;
      case "left":
        this.devices.delete(m.device_id);
        this.opts.onLeft?.(m.device_id);
        break;
      case "msg":
        this.opts.onMessage?.(m.from, m.data);
        break;
      case "error":
        this.opts.onError?.(m.code);
        break;
    }
  }

  // Koneksi ini berakhir (ditutup atau terdeteksi mati). Terminal atau coba lagi.
  private drop(ws: WebSocket, code: number): void {
    if (this.ws !== ws) return; // koneksi lama yang sudah digantikan
    this.ws = null;
    this.deviceId = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      ws.close();
    } catch {}
    if (this.stopped) return;
    const terminal = TERMINAL[code];
    if (terminal) return this.terminate(terminal);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    const base = this.opts.backoffBaseMs ?? 500;
    const delay = Math.min(5000, base * 2 ** this.attempts) * (0.5 + Math.random() / 2);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const every = this.opts.pingMs ?? 20_000;
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - this.lastPong > every * 2 + Math.min(5000, every)) return this.drop(ws, 1006); // tidak ada jawaban: anggap mati
      ws.send("ping");
    }, every);
  }

  // Saat tab kembali terlihat (misalnya HP dibuka dari kunci layar), pastikan koneksi masih hidup.
  private onVisible = (): void => {
    if (this.stopped || document.visibilityState !== "visible") return;
    const ws = this.ws;
    if (ws && ws.readyState === 1) {
      const sentAt = Date.now();
      ws.send("ping");
      if (this.probeTimer) clearTimeout(this.probeTimer);
      this.probeTimer = setTimeout(() => {
        if (this.ws === ws && this.lastPong < sentAt) this.drop(ws, 1006);
      }, 3000);
    } else if (!ws) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.attempts = 0;
      void this.connect();
    }
  };
}
