// Sand Together — authoritative room server (Stage 1, server-authoritative).
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
//     { type:"input", ticks }                // cumulative keystroke count → faucet flow
//     { type:"leave" }                       // explicit exit (frees colour)
//     { type:"reset" }                       // empty the room's canvas + archive
//     { type:"spout", size }                 // pour brush size 1..5 (N×N square)
//     { type:"pour",  on }                   // debug: keep the spout saturated (see the brush)
//     { type:"flood", on }                   // debug: fast bottom-fill (archive testing)
//     { type:"ping",  t }                    // RTT probe → pong
//   server → client:
//     { type:"snapshot", w, h, players, grid:<base64>, bands:[...] }  // full state on join
//     { type:"patch",  c:[idx,val, idx,val, ...] }         // changed cells
//     { type:"band",   rows, n, cells:<base64 rows*W bytes> } // Stage 3: a new archived layer (lossless)
//     { type:"players", players }                          // roster change
//     { type:"error",  reason:"room_full" }
//     { type:"pong",   t }                                 // echo of ping t (RTT)
//   playerId is carried in the URL: ws://host/r/<roomId>?_pk=<persistent-id>
//
// Stage 3 (archive, infinite stacking): when the settled pile crowds the top of the
// active grid, the server moves the bottom rows VERBATIM into a "band" (lossless — the
// exact pixels), shifts the active grid down to free room, and broadcasts a `band`. The
// client mirrors the same deterministic shift + archives the band, and renders it below
// the active grid at full resolution (scroll down for the complete history). Size-
// compression (RLE/gzip) is a later optimization. Privacy red line holds: a band stores
// only colour slots + grain counts — never key contents.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// numEnv: positive-integer env override or default. The sim sizes/rates are
// overridable ONLY so the smoke tests can spin up a tiny, fast room; production
// MUST keep the defaults below (W/H are a shared contract with the client).
const numEnv = (k, d) => { const v = parseInt(process.env[k], 10); return Number.isFinite(v) && v > 0 ? v : d; };

const PORT = process.env.PORT || 8090;
const DATA_DIR = process.env.SAND_DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- sim constants (shared contract with the client renderer; frontend.md) ---
const W = 80;             // grid columns
const H = numEnv("SAND_H", 300); // grid rows (authoritative; the client shows a window). 300 → a taller bottle — must match the client's H
const ROOM_COLORS = ["amber", "teal", "violet", "rose"]; // slot 1..4 = grid value
const ROOM_CAP = 4;
const SPOUT_X = { 1: 30, 2: 50, 3: 10, 4: 70 }; // evenly spaced across W=80, centre-out (must match client)
const SURFACE_MIN_CELLS = 6;  // a row needs this many grains to count as the settled surface
const SPAWN_ROW = 2;          // top boundary for the pour source
const SPAWN_GAP = 135;        // pour above the peak; tuned with the client's 0.618 anchor + viewRows=250 so the spout sits near the top of the view
const TICK_MS = 50;           // ~20fps physics
const SAVE_MS = numEnv("SAND_SAVE_MS", 5000);
// The pour source is an N×N square "brush" centred on the spout: each tick it refills
// its N×N footprint from the player's queue. Because the brush is N rows TALL and gravity
// drops 2 rows/tick, consecutive stamps connect for N≥2 (a continuous N-wide stream);
// N=1 leaves a 1-row gap (the old one-at-a-time dashed look). Width is capped at SPOUT_MAX.
const SPOUT_MAX = 5;
const DEFAULT_SPOUT = numEnv("SAND_SPOUT", 1); // brush size out of the box (1 = one-at-a-time; 2+ = continuous)
const FLOOD_ROWS_PER_TICK = 6; // debug {type:"flood"}: directly fill this many bottom rows/tick (fast archive test)

// --- Stage 3: archive compression (infinite stacking; see doc/stage3-compression.md) ---
// When the settled surface crowds within COMPRESS_MARGIN rows of the top, fold the
// bottom COMPRESS_ROWS rows into one band and shift the active grid down by that
// much. Bands stack below the active grid; the client renders them as thin strips.
const COMPRESS_ROWS   = numEnv("SAND_COMPRESS_ROWS", 64);   // rows folded into one band
const COMPRESS_MARGIN = numEnv("SAND_COMPRESS_MARGIN", 40); // trigger when the surface reaches this near row 0

const colorSlot = (c) => Math.max(1, ROOM_COLORS.indexOf(c) + 1);
// A band archives COMPRESS_ROWS real rows LOSSLESSLY: `cells` = rows*W bytes (the exact
// pixels, slot 0..4) + `rows` + `n` (grain count). No size-compression yet — that's a
// later optimization (RLE/gzip); step 1 is just a faithful, complete history.
const b64enc = (u8) => Buffer.from(u8).toString("base64");
function b64dec(s, len) { const buf = Buffer.from(String(s || ""), "base64"); const a = new Uint8Array(len); a.set(buf.subarray(0, len)); return a; }

class Room {
  constructor(id) {
    this.id = id;
    this.grid = new Uint8Array(W * H);
    this.prev = new Uint8Array(W * H); // last-broadcast grid, for diffing patches
    this.bands = [];                   // Stage 3 archive: [{ rows, n, cells:Uint8Array(rows*W) }], index 0 = oldest/deepest
    this.players = {};                 // playerId -> { name, color, ticks }
    this.queues = {};                  // playerId -> grains pending spawn
    this.spoutSize = {};               // playerId -> N (pour brush size 1..SPOUT_MAX)
    this.flooding = {};                // playerId -> bool (debug fast bottom-fill)
    this.pouring = {};                 // playerId -> bool (debug: keep the spout saturated)
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
  // Bands for the wire/disk: cells → base64. Old saves have no `bands` → [] (back-compat).
  serializeBands() { return this.bands.map((b) => ({ rows: b.rows, n: b.n, cells: b64enc(b.cells) })); }
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      if (d.players) this.players = d.players;
      if (d.grid) { const buf = Buffer.from(d.grid, "base64"); this.grid.set(buf.subarray(0, W * H)); }
      if (Array.isArray(d.bands)) this.bands = d.bands.map((b) => { const rows = b.rows | 0; return { rows, n: b.n | 0, cells: b64dec(b.cells, rows * W) }; });
      this.prev.set(this.grid);
    } catch (_) { /* fresh room */ }
  }
  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = { players: this.players, grid: Buffer.from(this.grid).toString("base64"), bands: this.serializeBands() };
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
  setSpout(playerId, size) { if (this.players[playerId]) this.spoutSize[playerId] = Math.max(1, Math.min(SPOUT_MAX, size | 0)); }
  setFirehose(playerId, on) { if (this.players[playerId]) this.flooding[playerId] = !!on; } // debug fast bottom-fill
  setPour(playerId, on) { if (this.players[playerId]) this.pouring[playerId] = !!on; }       // debug keep spout saturated
  leave(playerId) {
    if (!this.players[playerId]) return;
    delete this.players[playerId]; delete this.queues[playerId];
    delete this.spoutSize[playerId]; delete this.flooding[playerId]; delete this.pouring[playerId];
    this.dirty = true; this.broadcastPlayers();
  }
  drop(ws) { // keep player (offline ≠ exit), but stop debug pours so they can't run forever
    const pid = this.conns.get(ws);
    this.conns.delete(ws);
    if (pid) { this.flooding[pid] = false; this.pouring[pid] = false; }
    this.maybeStop();
  }
  reset() { // empty the room's shared canvas + archive (Stage 1: anyone may; prototype)
    this.grid.fill(0); this.prev.fill(0); this.bands = []; this.dirty = true;
    for (const ws of this.conns.keys()) this.snapshotTo(ws);
  }

  // ---- physics (ported from the old client engine; now authoritative) ----
  surface() { // settled pile top: first row (top→down) with enough sand to be a real
    // surface, not the few grains still falling — keeps the pour source from chasing
    // its own stream (matches the client's camera anchor).
    for (let y = 0; y < H; y++) {
      const b = y * W; let n = 0;
      for (let x = 0; x < W; x++) if (this.grid[b + x] && ++n >= SURFACE_MIN_CELLS) return y;
    }
    return H;
  }
  packedTop() { // first row (top→down) that is at least HALF full — a genuinely packed
    // layer. The thin pour stream never fills half a row, so this won't fire the archive
    // trigger prematurely while the bottle fills.
    const need = W >> 1;
    for (let y = 0; y < H; y++) {
      const b = y * W; let n = 0;
      for (let x = 0; x < W; x++) if (this.grid[b + x] && ++n >= need) return y;
    }
    return H;
  }
  // Refill the N×N brush footprint at (sr, x0-centred) from `max` available grains;
  // returns how many were placed. The brush is N tall so the stream stays continuous.
  brush(slot, x0, sr, N, max) {
    let placed = 0; const half = (N - 1) >> 1;
    for (let r = 0; r < N && placed < max; r++) {
      const rb = (sr + r) * W;
      if (rb < 0 || rb + W > W * H) continue;
      for (let c = 0; c < N && placed < max; c++) {
        const xx = x0 - half + c;
        if (xx < 0 || xx >= W) continue;
        if (this.grid[rb + xx] === 0) { this.grid[rb + xx] = slot; placed++; }
      }
    }
    return placed;
  }
  spawn() {
    const sr = Math.max(SPAWN_ROW, this.surface() - SPAWN_GAP); // source rides just above the peak
    for (const id in this.players) {
      const slot = colorSlot(this.players[id].color);
      const x0 = SPOUT_X[slot] || 40;
      const N = this.spoutSize[id] || DEFAULT_SPOUT;
      if (this.pouring[id]) { this.brush(slot, x0, sr, N, N * N); continue; } // debug: tap full open
      const q = this.queues[id] || 0;
      if (q <= 0) continue;
      this.queues[id] = q - this.brush(slot, x0, sr, N, q); // pour from your keystroke queue
    }
  }
  // debug fast-fill: directly pack the lowest empty cells with the player's colour (no
  // pour/physics), so testing the archive doesn't require minutes of typing.
  floodFill() {
    for (const id in this.flooding) {
      if (!this.flooding[id] || !this.players[id]) continue;
      const slot = colorSlot(this.players[id].color);
      let budget = FLOOD_ROWS_PER_TICK * W;
      for (let y = H - 1; y >= 0 && budget > 0; y--) {
        const b = y * W;
        for (let x = 0; x < W && budget > 0; x++) if (this.grid[b + x] === 0) { this.grid[b + x] = slot; budget--; }
      }
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

  // ---- Stage 3: move the bottom into the archive, free room at the top ----
  // Copy the bottom COMPRESS_ROWS rows VERBATIM into a band (lossless — the exact
  // pixels), append it, then shift the whole active grid DOWN by that many rows so the
  // top frees up for new sand. The active grid stays bounded (physics cost capped) while
  // history is preserved exactly. The diff baseline is resynced to the post-shift grid
  // (no giant patch) and a `band` is broadcast; clients apply the identical shift.
  archiveBottom() {
    const K = COMPRESS_ROWS, g = this.grid;
    const cells = g.slice((H - K) * W, H * W); // exact bottom K rows (K*W bytes), lossless
    let n = 0; for (let i = 0; i < cells.length; i++) if (cells[i]) n++;
    if (n === 0) return; // nothing settled down there yet — don't archive an empty band
    this.bands.push({ rows: K, n, cells });
    g.copyWithin(K * W, 0, (H - K) * W); // row y -> y+K (memmove handles the overlap)
    g.fill(0, 0, K * W);                  // free the top K rows
    this.prev.set(g);                     // diff baseline = post-shift grid
    this.dirty = true;
    this.broadcast({ type: "band", rows: K, n, cells: b64enc(cells) });
  }

  // ---- loop + broadcast ----
  tick() {
    this.frame++;
    this.spawn();
    this.floodFill();               // debug fast-fill (no-op unless a player toggled flood)
    this.physics(); this.physics(); // 2 gravity sub-steps/tick (gentler, slower fall)
    const cells = [], g = this.grid, pv = this.prev;
    for (let i = 0; i < g.length; i++) if (g[i] !== pv[i]) { cells.push(i, g[i]); pv[i] = g[i]; }
    if (cells.length) { this.dirty = true; this.broadcast({ type: "patch", c: cells }); }
    // archive AFTER the patch broadcast so clients reach the pre-shift grid first,
    // then apply the same shift on the `band` message. Trigger on a packed layer
    // (not the falling curtain) so we only fold a genuinely full bottom.
    if (H > COMPRESS_ROWS && this.packedTop() <= COMPRESS_MARGIN) this.archiveBottom();
  }
  snapshotTo(ws) {
    try {
      ws.send(JSON.stringify({
        type: "snapshot", w: W, h: H,
        players: this.players,
        grid: Buffer.from(this.grid).toString("base64"),
        bands: this.serializeBands(),
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

const INDEX_HTML = path.join(__dirname, "..", "index.html");
const server = http.createServer((req, res) => {
  const p = (req.url || "/").split("?")[0];
  if (p === "/" || p === "/index.html") {
    // Serve the client itself over http (testing convenience: no domain/cert
    // needed — page and ws share this origin, so the browser uses ws:// happily).
    fs.readFile(INDEX_HTML, (err, buf) => {
      if (err) { res.writeHead(404); res.end("index.html not found"); return; }
      // no-cache → clients revalidate, so a deploy (git pull + restart) takes effect on
      // the next load instead of the webview/browser serving a stale cached page.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(buf);
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Sand Together authoritative server\n");
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
    else if (d.type === "spout") room.setSpout(playerId, d.size);  // pour brush size 1..5
    else if (d.type === "pour") room.setPour(playerId, d.on);      // debug: keep spout saturated
    else if (d.type === "flood") room.setFirehose(playerId, d.on); // debug: fast bottom-fill
    else if (d.type === "ping") { try { ws.send(JSON.stringify({ type: "pong", t: d.t })); } catch (_) {} } // RTT probe / health
  });
  ws.on("close", () => room.drop(ws));
  ws.on("error", () => room.drop(ws));
});
server.listen(PORT, () => console.log(`[sand] authoritative server on :${PORT}`));
