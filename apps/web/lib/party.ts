// Logika "pesta" di sisi layar: siapa host, fase (lobi, menu, hitung mundur, lomba, hasil),
// dan game percobaan Lomba Lari. Kode murni: tidak memakai React, jaringan, atau jam sistem
// (waktu selalu dikirim sebagai argumen `now`), jadi bisa diuji penuh tanpa browser.
//
// Cara pakai (di halaman layar):
//   party.join/leave/message(...)  lalu  flushOut(party, link)   // kirim pesan keluar
//   setInterval: party.tick(now);  flushOut(party, link);  party.view() untuk digambar

export const MIN_PLAYERS = 2;
export const COUNTDOWN_MS = 3000;
export const NOTICE_MS = 2500;
export const MENU_COLS = 2;

export type MenuItem = { id: string; title: string; available: boolean };
export const MENU: MenuItem[] = [
  { id: "race", title: "Lomba Lari", available: true },
  { id: "soon-1", title: "Segera hadir", available: false },
  { id: "soon-2", title: "Segera hadir", available: false },
  { id: "soon-3", title: "Segera hadir", available: false },
];

export type Phase = "lobby" | "menu" | "countdown" | "race" | "results";
export type Dir = "up" | "down" | "left" | "right" | "ok" | "back";
const DIRS: Dir[] = ["up", "down", "left", "right", "ok", "back"];

// ------------------------------------------------------------ pesan aplikasi
// Isi `data` pada pesan relay. Controller -> layar:
export type ToScreen =
  | { k: "sync" } // minta status terbaru
  | { k: "start" } // host: mulai (dari lobi)
  | { k: "nav"; d: Dir } // host: tombol arah / OK / kembali
  | { k: "tap" } // lomba: satu langkah
  | { k: "ping"; ts: number };

// Layar -> controller:
export type ResultRow = { id: number; name: string; place: number; finished: boolean; time: number | null };
export type PublicState = {
  k: "state";
  phase: Phase;
  host: number | null;
  players: number;
  canStart: boolean;
  racers: number[]; // yang ikut ronde ini (terisi sejak hitung mundur)
  countdown: number | null; // detik tersisa saat hitung mundur
  notice: string | null;
  menuIndex: number;
  results: ResultRow[];
};
export type RaceSnapshot = { k: "race"; pos: Record<number, number> };
export type ToController = PublicState | RaceSnapshot | { k: "pong"; ts: number };

export type Out = { to: number | "all"; data: ToController };

export interface Sender {
  send(to: number | "all", data: unknown): boolean;
}
export function flushOut(party: Party, link: Sender): void {
  for (const o of party.drain()) link.send(o.to, o.data);
}

// ------------------------------------------------------------------- lomba

export const TRACK = 100;
export const STEP = 1.25; // jarak per ketukan: ~80 ketukan sampai finis
export const MIN_TAP_GAP_MS = 55; // batas ~18 ketukan per detik per pemain
export const FINISH_GRACE_MS = 5000; // sisa waktu bagi yang lain setelah ada yang finis
export const RACE_TIMEOUT_MS = 60_000;

export type RaceState = {
  startedAt: number;
  racers: number[];
  pos: Record<number, number>;
  lastTap: Record<number, number>;
  finishedAt: Record<number, number>; // id -> ms sejak start
  firstFinishAt: number | null;
};

export function startRace(racers: number[], now: number): RaceState {
  const pos: Record<number, number> = {};
  for (const id of racers) pos[id] = 0;
  return { startedAt: now, racers: [...racers], pos, lastTap: {}, finishedAt: {}, firstFinishAt: null };
}

// Mengubah `r` langsung. Mengembalikan true bila ketukan dihitung.
export function applyTap(r: RaceState, id: number, now: number): boolean {
  if (!r.racers.includes(id)) return false;
  if (r.finishedAt[id] !== undefined) return false;
  const last = r.lastTap[id];
  if (last !== undefined && now - last < MIN_TAP_GAP_MS) return false;
  r.lastTap[id] = now;
  r.pos[id] = Math.min(TRACK, (r.pos[id] ?? 0) + STEP);
  if (r.pos[id] >= TRACK) {
    r.finishedAt[id] = now - r.startedAt;
    if (r.firstFinishAt === null) r.firstFinishAt = now;
  }
  return true;
}

export function raceOver(r: RaceState, now: number, connected: number[]): boolean {
  const active = r.racers.filter((id) => connected.includes(id));
  if (active.length === 0) return true;
  if (active.every((id) => r.finishedAt[id] !== undefined)) return true;
  if (r.firstFinishAt !== null && now - r.firstFinishAt >= FINISH_GRACE_MS) return true;
  return now - r.startedAt >= RACE_TIMEOUT_MS;
}

export type Place = { id: number; place: number; finished: boolean; time: number | null; distance: number };

// Yang finis diurutkan menurut waktu, sisanya menurut jarak tempuh.
export function ranking(r: RaceState): Place[] {
  const rows = r.racers.map((id) => ({
    id,
    finished: r.finishedAt[id] !== undefined,
    time: r.finishedAt[id] ?? null,
    distance: r.pos[id] ?? 0,
  }));
  rows.sort((a, b) => {
    if (a.finished && b.finished) return (a.time as number) - (b.time as number) || a.id - b.id;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.distance - a.distance || a.id - b.id;
  });
  return rows.map((x, i) => ({ ...x, place: i + 1 }));
}

// ------------------------------------------------------------------- pesta

export type View = {
  phase: Phase;
  players: { id: number; name: string }[];
  hostId: number | null;
  canStart: boolean;
  menuIndex: number;
  countdown: number | null;
  notice: string | null;
  racers: number[];
  pos: Record<number, number>;
  names: Record<number, string>; // termasuk yang sudah keluar, untuk papan hasil
  results: ResultRow[];
};

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export class Party {
  phase: Phase = "lobby";
  version = 0; // naik setiap ada perubahan; dipakai UI untuk tahu kapan perlu menggambar ulang

  private names = new Map<number, string>(); // controller yang sedang tersambung
  private known = new Map<number, string>(); // semua yang pernah ikut
  private menuIndex = 0;
  private notice: string | null = null;
  private noticeUntil = 0;
  private countdownEnd = 0;
  private lastCountdown: number | null = null;
  private racers: number[] = [];
  private race: RaceState | null = null;
  private results: ResultRow[] = [];
  private lastSnap = 0;
  private out: Out[] = [];

  // ------------------------------------------------------------- tampilan

  get host(): number | null {
    let h: number | null = null;
    for (const id of this.names.keys()) if (h === null || id < h) h = id;
    return h;
  }

  get canStart(): boolean {
    return this.phase === "lobby" && this.names.size >= MIN_PLAYERS;
  }

  view(): View {
    const pos: Record<number, number> = {};
    if (this.race) for (const id of this.race.racers) pos[id] = this.race.pos[id] ?? 0;
    return {
      phase: this.phase,
      players: [...this.names.entries()].sort((a, b) => a[0] - b[0]).map(([id, name]) => ({ id, name })),
      hostId: this.host,
      canStart: this.canStart,
      menuIndex: this.menuIndex,
      countdown: this.phase === "countdown" ? this.lastCountdown : null,
      notice: this.notice,
      racers: [...this.racers],
      pos,
      names: Object.fromEntries(this.known),
      results: this.results,
    };
  }

  drain(): Out[] {
    const o = this.out;
    this.out = [];
    return o;
  }

  // ----------------------------------------------------------- peristiwa

  join(id: number, nickname: string, now: number): void {
    const name = this.uniqueName(nickname || "Pemain", id);
    this.names.set(id, name);
    this.known.set(id, name);
    this.changed();
    void now;
  }

  leave(id: number, now: number): void {
    if (!this.names.delete(id)) return;
    // Lomba yang sudah berjalan tetap lanjut untuk yang tersisa; menu dan hitung mundur batal.
    if ((this.phase === "menu" || this.phase === "countdown") && this.names.size < MIN_PLAYERS) {
      this.toLobby("Pemain kurang dari 2. Kembali ke lobi.", now);
      return;
    }
    this.changed();
  }

  message(from: number, data: unknown, now: number): void {
    if (from === 0 || !this.names.has(from) || !isObj(data)) return;
    switch (data.k) {
      case "sync":
        this.out.push({ to: from, data: this.state() });
        break;
      case "ping":
        if (typeof data.ts === "number") this.out.push({ to: from, data: { k: "pong", ts: data.ts } });
        break;
      case "start":
        if (from === this.host) this.start(now);
        break;
      case "nav":
        if (from === this.host && typeof data.d === "string" && DIRS.includes(data.d as Dir)) {
          this.nav(data.d as Dir, now);
        }
        break;
      case "tap":
        if (this.phase === "race" && this.race && applyTap(this.race, from, now)) this.version++;
        break;
    }
  }

  // Dipakai papan ketik di layar (untuk uji di laptop): bertindak seperti host.
  navAsHost(d: Dir, now: number): void {
    this.nav(d, now);
  }

  tick(now: number): void {
    if (this.notice && now >= this.noticeUntil) {
      this.notice = null;
      this.changed();
    }
    if (this.phase === "countdown") {
      if (now >= this.countdownEnd) {
        this.beginRace(now);
      } else {
        const secs = Math.max(1, Math.ceil((this.countdownEnd - now) / 1000));
        if (secs !== this.lastCountdown) {
          this.lastCountdown = secs;
          this.changed();
        }
      }
    } else if (this.phase === "race" && this.race) {
      if (raceOver(this.race, now, [...this.names.keys()])) {
        this.finishRace();
      } else if (now - this.lastSnap >= 200) {
        this.lastSnap = now;
        const pos: Record<number, number> = {};
        for (const id of this.race.racers) pos[id] = Math.round((this.race.pos[id] ?? 0) * 10) / 10;
        this.out.push({ to: "all", data: { k: "race", pos } });
      }
    }
  }

  state(): PublicState {
    return {
      k: "state",
      phase: this.phase,
      host: this.host,
      players: this.names.size,
      canStart: this.canStart,
      racers: [...this.racers],
      countdown: this.phase === "countdown" ? this.lastCountdown : null,
      notice: this.notice,
      menuIndex: this.menuIndex,
      results: this.results,
    };
  }

  // ------------------------------------------------------------- privat

  private changed(): void {
    this.version++;
    this.out.push({ to: "all", data: this.state() });
  }

  private setNotice(text: string, now: number): void {
    this.notice = text;
    this.noticeUntil = now + NOTICE_MS;
    this.changed();
  }

  private toLobby(text: string | null, now: number): void {
    this.phase = "lobby";
    this.race = null;
    this.racers = [];
    this.results = [];
    this.lastCountdown = null;
    if (text) this.setNotice(text, now);
    else this.changed();
  }

  private start(now: number): void {
    if (this.phase !== "lobby") return;
    if (this.names.size < MIN_PLAYERS) return this.setNotice("Butuh minimal 2 pemain.", now);
    this.phase = "menu";
    this.menuIndex = 0;
    this.changed();
  }

  private nav(d: Dir, now: number): void {
    if (this.phase === "lobby") {
      if (d === "ok") this.start(now);
      return;
    }
    if (this.phase === "menu") {
      const n = MENU.length;
      const i = this.menuIndex;
      if (d === "up" && i - MENU_COLS >= 0) this.menuIndex = i - MENU_COLS;
      else if (d === "down" && i + MENU_COLS < n) this.menuIndex = i + MENU_COLS;
      else if (d === "left" && i % MENU_COLS > 0) this.menuIndex = i - 1;
      else if (d === "right" && i % MENU_COLS < MENU_COLS - 1 && i + 1 < n) this.menuIndex = i + 1;
      else if (d === "ok") {
        if (!MENU[i].available) return this.setNotice("Belum tersedia. Segera hadir!", now);
        return this.beginCountdown(now);
      } else if (d === "back") return this.toLobby(null, now);
      this.changed();
      return;
    }
    if (this.phase === "results") {
      if (d === "ok") {
        if (this.names.size < MIN_PLAYERS) return this.toLobby("Pemain kurang dari 2. Kembali ke lobi.", now);
        this.phase = "menu";
        this.results = [];
        this.racers = [];
        this.changed();
      } else if (d === "back") this.toLobby(null, now);
    }
  }

  private beginCountdown(now: number): void {
    this.racers = [...this.names.keys()].sort((a, b) => a - b);
    this.phase = "countdown";
    this.countdownEnd = now + COUNTDOWN_MS;
    this.lastCountdown = Math.ceil(COUNTDOWN_MS / 1000);
    this.changed();
  }

  private beginRace(now: number): void {
    const present = this.racers.filter((id) => this.names.has(id));
    this.race = startRace(present, now);
    this.racers = present;
    this.phase = "race";
    this.lastCountdown = null;
    this.lastSnap = 0;
    this.changed();
  }

  private finishRace(): void {
    const r = this.race as RaceState;
    this.results = ranking(r).map((p) => ({
      id: p.id,
      name: this.known.get(p.id) ?? "Pemain",
      place: p.place,
      finished: p.finished,
      time: p.time,
    }));
    this.race = null;
    this.phase = "results";
    this.changed();
  }

  // Nama kembar diberi nomor supaya di layar bisa dibedakan.
  private uniqueName(base: string, id: number): string {
    const taken = new Set<string>();
    for (const [other, name] of this.names) if (other !== id) taken.add(name);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
