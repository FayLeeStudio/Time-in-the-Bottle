// Time in the Bottle — authoritative room server (Stage 1, server-authoritative).
//
// The big invariant change (CLAUDE.md, 2026-06-21): physics runs HERE, on the
// server, once per room. The server holds the one true `grid`; clients only send
// input (their cumulative keystroke count) and render the grid we broadcast. No
// client runs authoritative physics, so everyone in a room sees the exact same
// thing. Privacy red line is intact: we only ever handle counts + grid pixels —
// never key contents, never text.
//
// Wire protocol (see also doc/backend.md):
//   client → server:
//     { type:"join",  name, color:"auto" }   // color assigned by server
//     { type:"input", ticks }                // cumulative keystroke count
//     { type:"leave" }                       // explicit exit (frees colour)
//   server → client:
//     { type:"snapshot", w, h, players, grid:<base64> }   // full state on join
//     { type:"patch",  c:[idx,val, idx,val, ...] }         // changed cells
//     { type:"players", players }                          // roster change
//     { type:"error",  reason:"room_full" }
//   playerId is carried in the URL: ws://host/r/<roomId>?_pk=<persistent-id>

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8090;
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- sim constants (shared contract with the client renderer; frontend.md) ---
const W = 80;             // grid columns
const H = 200;            // grid rows (authoritative; the client shows a window)
const ROOM_COLORS = ["amber", "teal", "violet", "rose"]; // slot 1..4 = grid value
const ROOM_CAP = 4;
const SPOUT_X = { 1: 40, 2: 15, 3: 57, 4: 72 };
const SPAWN_ROW = 2;          // top boundary for the pour source
const SPAWN_GAP = 26;         // pour this many rows above the pile's peak (source follows the surface)
const TICK_MS = 50;           // ~20fps physics
const MAX_SPAWN_PER_TICK = 4; // per player, so a burst doesn't dump all at once
const SAVE_MS = 5000;
const colorSlot = (c) => Math.max(1, ROOM_COLORS.indexOf(c) + 1);

class Room {
  constructor(id) {
    this.id = id;
    this.grid = new Uint8Array(W * H);
    this.prev = new Uint8Array(W * H); // last-broadcast grid, for diffing patches
    this.players = {};                 // playerId -> { name, color, ticks }
    this.queues = {};                  // playerId -> grains pending spawn
    this.conns = new Map();            // ws -> playerId
    this.frame = 0;
    this.dirty = false;                // grid/players changed since last save
    this.timer = null;
    this.saveTimer = null;
    this.load();
    this.ensureRunning();
  }

  ensureRunning() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.saveTimer = setInterval(() => this.save(), SAVE_MS);
  }
  maybeStop() {
    if (this.conns.size > 0) return;
    this.save();
    clearInterval(this.timer); clearInterval(this.saveTimer);
    this.timer = this.saveTimer = null; // idle room: stop burning CPU, keep grid in RAM + on disk
  }

  takeColor() {
    const used = new Set(Object.values(this.players).map((p) => p.color));
    for (const c of ROOM_COLORS) if (!used.has(c)) return c;
    return ROOM_COLORS[0];
  }

  // ---- persistence (the server is the single source of truth) ----
  file() { return path.join(DATA_DIR, this.id.replace(/[^A-Za-z0-9_-]/g, "_") + ".json"); }
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      if (d.players) this.players = d.players;
      if (d.grid) { const buf = Buffer.from(d.grid, "base64"); this.grid.set(buf.subarray(0, W * H)); }
      this.prev.set(this.grid);
    } catch (_) { /* fresh room */ }
  }
  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = { players: this.players, grid: Buffer.from(this.grid).toString("base64") };
    fs.writeFile(this.file(), JSON.stringify(data), () => {});
  }

  // ---- connection lifecycle ----
  join(ws, playerId, name) {
    if (!this.players[playerId]) {
      if (Object.keys(this.players).length >= ROOM_CAP) {
        try { ws.send(JSON.stringify({ type: "error", reason: "room_full" })); ws.close(); } catch (_) {}
        return false;
      }
      this.players[playerId] = { name: String(name || "Player"), color: this.takeColor(), ticks: 0 };
      this.dirty = true;
    } else if (name) {
      this.players[playerId].name = String(name);
    }
    this.conns.set(ws, playerId);
    this.ensureRunning();
    this.snapshotTo(ws);     // full state to the newcomer
    this.broadcastPlayers(); // everyone learns the roster change
    return true;
  }
  onInput(playerId, ticks) {
    const p = this.players[playerId];
    if (!p) return;
    ticks = Number(ticks) || 0;
    const delta = ticks - p.ticks;
    if (delta > 0) this.queues[playerId] = Math.min((this.queues[playerId] || 0) + delta, 600);
    p.ticks = ticks;
  }
  leave(playerId) {
    if (!this.players[playerId]) return;
    delete this.players[playerId]; delete this.queues[playerId];
    this.dirty = true; this.broadcastPlayers();
  }
  drop(ws) { this.conns.delete(ws); this.maybeStop(); } // keep player (offline ≠ exit)
  reset() { // empty the room's shared canvas (Stage 1: anyone may; prototype)
    this.grid.fill(0); this.prev.fill(0); this.dirty = true;
    for (const ws of this.conns.keys()) this.snapshotTo(ws);
  }

  // ---- physics (ported from the old client engine; now authoritative) ----
  surface() { // highest occupied row across all columns (smaller = higher)
    let peak = H;
    for (let x = 0; x < W; x++) { let y = H - 1; while (y >= 0 && this.grid[y * W + x]) y--; const top = y + 1; if (top < peak) peak = top; }
    return peak;
  }
  spawn() {
    const offs = [0, -1, 1, -2, 2];
    const sr = Math.max(SPAWN_ROW, this.surface() - SPAWN_GAP); // source rides just above the peak
    const base = sr * W;
    for (const id in this.players) {
      let q = this.queues[id] || 0;
      if (q <= 0) continue;
      const slot = colorSlot(this.players[id].color);
      const x0 = SPOUT_X[slot] || 40;
      let release = Math.min(q, MAX_SPAWN_PER_TICK);
      while (release > 0) {
        let placed = false;
        for (const o of offs) {
          const xx = x0 + o;
          if (xx < 0 || xx >= W) continue;
          if (this.grid[base + xx] === 0) { this.grid[base + xx] = slot; placed = true; break; }
        }
        if (!placed) break;
        q--; release--;
      }
      this.queues[id] = q;
    }
  }
  physics() {
    const ltr = (this.frame & 1) === 0;
    for (let y = H - 2; y >= 0; y--) {
      if (ltr) { for (let x = 0; x < W; x++) this.fall(x, y); }
      else { for (let x = W - 1; x >= 0; x--) this.fall(x, y); }
    }
  }
  fall(x, y) {
    const g = this.grid, i = y * W + x, c = g[i];
    if (!c) return;
    const below = i + W;
    if (g[below] === 0) { g[below] = c; g[i] = 0; return; }
    const dl = x > 0 && g[below - 1] === 0;
    const dr = x < W - 1 && g[below + 1] === 0;
    if (dl && dr) { if (Math.random() < 0.5) g[below - 1] = c; else g[below + 1] = c; g[i] = 0; }
    else if (dl) { g[below - 1] = c; g[i] = 0; }
    else if (dr) { g[below + 1] = c; g[i] = 0; }
  }

  // ---- loop + broadcast ----
  tick() {
    this.frame++;
    this.spawn();
    this.physics();
    const cells = [], g = this.grid, pv = this.prev;
    for (let i = 0; i < g.length; i++) if (g[i] !== pv[i]) { cells.push(i, g[i]); pv[i] = g[i]; }
    if (cells.length) { this.dirty = true; this.broadcast({ type: "patch", c: cells }); }
  }
  snapshotTo(ws) {
    try {
      ws.send(JSON.stringify({
        type: "snapshot", w: W, h: H,
        players: this.players,
        grid: Buffer.from(this.grid).toString("base64"),
      }));
    } catch (_) {}
  }
  broadcastPlayers() { this.broadcast({ type: "players", players: this.players }); }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.conns.keys()) { try { ws.send(s); } catch (_) {} }
  }
}

const rooms = new Map();
const getRoom = (id) => { let r = rooms.get(id); if (!r) { r = new Room(id); rooms.set(id, r); } return r; };

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Time in the Bottle authoritative server\n");
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://x");
  const m = u.pathname.match(/^\/r\/([^/]+)/);
  const roomId = m ? decodeURIComponent(m[1]) : "default";
  const playerId = u.searchParams.get("_pk") || crypto.randomUUID();
  const room = getRoom(roomId);
  ws.on("message", (raw) => {
    let d; try { d = JSON.parse(raw.toString()); } catch (_) { return; }
    if (d.type === "join") room.join(ws, playerId, d.name);
    else if (d.type === "input") room.onInput(playerId, d.ticks);
    else if (d.type === "leave") room.leave(playerId);
    else if (d.type === "reset") room.reset();
  });
  ws.on("close", () => room.drop(ws));
  ws.on("error", () => room.drop(ws));
});
server.listen(PORT, () => console.log(`[titb] authoritative server on :${PORT}`));
