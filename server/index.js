// Sand Together — authoritative room server (Stage 1, server-authoritative).
//
// The big invariant change (CLAUDE.md, 2026-06-21): physics runs HERE, on the
// server, once per room. The server holds the one true `grid`; clients only send
// input (their cumulative keystroke count) and render the grid we broadcast. No
// client runs authoritative physics, so everyone in a room sees the exact same
// thing. Privacy red line is intact: we only ever handle counts + grid pixels —
// never key contents, never text.
//
// Saves are DECOUPLED (ARK-style): a WORLD save per room (grid + bands + member roster)
// and a global PLAYER profile per playerId (name + skills + lifetime + worlds joined).
// The wire protocol below is UNCHANGED — the server synthesizes the old { id:{name,color,
// ticks} } roster from members + profiles (rosterForWire), so the client needs no edits.
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
// Saves are split in two (decoupled, ARK-style): a WORLD save per room (grid + bands +
// member roster) and a global PLAYER profile per playerId (name + skills + lifetime +
// which worlds they've joined). The world no longer stores player names — those live on
// the profile, so one player has a single global identity across every world.
const WORLDS_DIR = path.join(DATA_DIR, "worlds");
const PLAYERS_DIR = path.join(DATA_DIR, "players");
fs.mkdirSync(WORLDS_DIR, { recursive: true });
fs.mkdirSync(PLAYERS_DIR, { recursive: true });

// --- sim constants (shared contract with the client renderer; frontend.md) ---
const W = 80;             // grid columns
const H = numEnv("SAND_H", 300); // grid rows (authoritative; the client shows a window). 300 → a taller bottle — must match the client's H
const ROOM_COLORS = ["amber", "teal", "violet", "rose"]; // slot 1..4 = grid value
const ROOM_CAP = 4;
const SPOUT_X = { 1: 30, 2: 50, 3: 10, 4: 70 }; // evenly spaced across W=80, centre-out (must match client)
const SURFACE_MIN_CELLS = 6;  // a row needs this many grains to count as the settled surface
const SPAWN_ROW = 2;          // top boundary for the pour source
const SPAWN_GAP = 75;         // pour this far above the settled surface (matches the client's spout offset); keeps the spout near the top while sand fills ~0.618
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

// --- global player profiles (decoupled from worlds) -------------------------
// One file per playerId: data/players/<id>.json. A profile is the player's GLOBAL
// identity — name + skills/talents (reserved for the gamification phase) + lifetime
// accumulation + the list of worlds they've joined. It is process-global (shared by
// every Room), cached in memory, and flushed on a timer. Privacy red line holds:
// counts + name only, never key contents.
const freshProfile = (id) => ({ id, name: "Player", createdAt: Date.now(), lastSeen: 0, skills: {}, lifetime: { ticks: 0 }, worlds: [] });
class PlayerStore {
  constructor() { this.cache = new Map(); this.dirty = new Set(); setInterval(() => this.flush(), SAVE_MS); }
  file(id) { return path.join(PLAYERS_DIR, String(id).replace(/[^A-Za-z0-9_-]/g, "_") + ".json"); }
  // Normalize a parsed/blank profile so partial or back-compat files always have every field.
  norm(id, p) {
    if (!p || typeof p !== "object") p = freshProfile(id);
    p.id = id;
    if (typeof p.name !== "string") p.name = "Player";
    if (!p.skills || typeof p.skills !== "object") p.skills = {};
    if (!p.lifetime || typeof p.lifetime !== "object") p.lifetime = { ticks: 0 };
    if (typeof p.lifetime.ticks !== "number") p.lifetime.ticks = 0;
    if (!Array.isArray(p.worlds)) p.worlds = [];
    if (!p.createdAt) p.createdAt = Date.now();
    if (!p.lastSeen) p.lastSeen = 0;
    return p;
  }
  // get: load-or-create + cache (used on the live path). peek: read-only, never creates.
  get(id) {
    let p = this.cache.get(id);
    if (p) return p;
    try { p = this.norm(id, JSON.parse(fs.readFileSync(this.file(id), "utf8"))); }
    catch (_) { p = freshProfile(id); }
    this.cache.set(id, p);
    return p;
  }
  peek(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try { return this.norm(id, JSON.parse(fs.readFileSync(this.file(id), "utf8"))); } catch (_) { return null; }
  }
  touch(id, name) { const p = this.get(id); if (name) p.name = String(name); p.lastSeen = Date.now(); this.dirty.add(id); return p; }
  addWorld(id, roomId) { const p = this.get(id); if (!p.worlds.includes(roomId)) { p.worlds.push(roomId); this.dirty.add(id); } }
  // lifetime is the device-level monotonic counter's high-water mark — NOT a sum of
  // per-room deltas (joining a fresh room would replay the whole device history as one
  // delta and over-count). max() is monotonic + correct for one device; refine to
  // "max per device, summed" when accounts/multi-device land.
  bumpLifetime(id, reported) { const p = this.get(id); reported = Number(reported) || 0; if (reported > p.lifetime.ticks) p.lifetime.ticks = reported; p.lastSeen = Date.now(); this.dirty.add(id); }
  flush() {
    if (!this.dirty.size) return;
    const ids = [...this.dirty]; this.dirty.clear();
    for (const id of ids) { const p = this.cache.get(id); if (p) fs.writeFile(this.file(id), JSON.stringify(p), () => {}); }
  }
}
const playerStore = new PlayerStore();

class Room {
  constructor(id) {
    this.id = id;
    this.grid = new Uint8Array(W * H);
    this.prev = new Uint8Array(W * H); // last-broadcast grid, for diffing patches
    this.bands = [];                   // Stage 3 archive: [{ rows, n, cells:Uint8Array(rows*W) }], index 0 = oldest/deepest
    this.createdAt = Date.now();       // world birth (load() overrides for existing worlds)
    this.members = {};                 // playerId -> { color, ticks, contributionTicks, joinedAt } (name lives on the global profile)
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
    this.save(); playerStore.flush();
    clearInterval(this.timer); clearInterval(this.saveTimer);
    this.timer = this.saveTimer = null; // idle room: stop burning CPU, keep grid in RAM + on disk
  }

  takeColor() {
    const used = new Set(Object.values(this.members).map((m) => m.color));
    for (const c of ROOM_COLORS) if (!used.has(c)) return c;
    return ROOM_COLORS[0];
  }

  // ---- persistence (the server is the single source of truth) ----
  safeId() { return this.id.replace(/[^A-Za-z0-9_-]/g, "_"); }
  file() { return path.join(WORLDS_DIR, this.safeId() + ".json"); }
  // Bands for the wire/disk: cells → base64. Old saves have no `bands` → [] (back-compat).
  serializeBands() { return this.bands.map((b) => ({ rows: b.rows, n: b.n, cells: b64enc(b.cells) })); }
  load() {
    // Preferred: the new world file under worlds/. Fallback: a legacy top-level
    // data/<id>.json in the old { players:{pid:{name,color,ticks}} } shape — convert it
    // in place (a safety net; the normal upgrade path is server/migrate.mjs).
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file(), "utf8")); } catch (_) {}
    if (!d) { try { d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, this.safeId() + ".json"), "utf8")); } catch (_) {} }
    if (!d) return; // fresh room
    if (d.createdAt) this.createdAt = d.createdAt;
    if (d.grid) { const buf = Buffer.from(d.grid, "base64"); this.grid.set(buf.subarray(0, W * H)); }
    if (Array.isArray(d.bands)) this.bands = d.bands.map((b) => { const rows = b.rows | 0; return { rows, n: b.n | 0, cells: b64dec(b.cells, rows * W) }; });
    if (d.members && typeof d.members === "object") {
      for (const id in d.members) { const m = d.members[id] || {}; this.members[id] = { color: m.color || ROOM_COLORS[0], ticks: m.ticks | 0, contributionTicks: m.contributionTicks | 0, joinedAt: m.joinedAt || 0 }; }
    } else if (d.players && typeof d.players === "object") {
      // legacy shape: lift each player's name into the global profile, keep color/ticks as a member.
      for (const id in d.players) {
        const p = d.players[id] || {};
        this.members[id] = { color: p.color || ROOM_COLORS[0], ticks: p.ticks | 0, contributionTicks: 0, joinedAt: 0 };
        playerStore.touch(id, p.name); playerStore.addWorld(id, this.id); playerStore.bumpLifetime(id, p.ticks | 0);
      }
      this.dirty = true; // re-persist under the new worlds/ path + shape on the next save
    }
    this.prev.set(this.grid);
  }
  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = { id: this.id, createdAt: this.createdAt, members: this.members, grid: Buffer.from(this.grid).toString("base64"), bands: this.serializeBands() };
    fs.writeFile(this.file(), JSON.stringify(data), () => {});
  }

  // ---- connection lifecycle ----
  join(ws, playerId, name) {
    // Reject a full room BEFORE creating any profile/member (don't leave a profile behind
    // for someone who couldn't get in).
    if (!this.members[playerId] && Object.keys(this.members).length >= ROOM_CAP) {
      try { ws.send(JSON.stringify({ type: "error", reason: "room_full" })); ws.close(); } catch (_) {}
      return false;
    }
    playerStore.touch(playerId, name);     // global profile: identity/name/lastSeen
    if (!this.members[playerId]) {
      this.members[playerId] = { color: this.takeColor(), ticks: 0, contributionTicks: 0, joinedAt: Date.now() };
      this.dirty = true;
    }
    playerStore.addWorld(playerId, this.id); // bidirectional membership: profile ↔ world
    this.conns.set(ws, playerId);
    this.ensureRunning();
    this.snapshotTo(ws);     // full state to the newcomer
    this.broadcastPlayers(); // everyone learns the roster change
    return true;
  }
  onInput(playerId, ticks) {
    const m = this.members[playerId];
    if (!m) return;
    ticks = Number(ticks) || 0;
    const delta = ticks - m.ticks;
    if (delta > 0) this.queues[playerId] = Math.min((this.queues[playerId] || 0) + delta, 600);
    m.ticks = ticks;
    playerStore.bumpLifetime(playerId, ticks); // global lifetime = high-water mark of the device counter
  }
  setSpout(playerId, size) { if (this.members[playerId]) this.spoutSize[playerId] = Math.max(1, Math.min(SPOUT_MAX, size | 0)); }
  setFirehose(playerId, on) { if (this.members[playerId]) this.flooding[playerId] = !!on; } // debug fast bottom-fill
  setPour(playerId, on) { if (this.members[playerId]) this.pouring[playerId] = !!on; }       // debug keep spout saturated
  leave(playerId) {
    if (!this.members[playerId]) return;
    delete this.members[playerId]; delete this.queues[playerId];
    delete this.spoutSize[playerId]; delete this.flooding[playerId]; delete this.pouring[playerId];
    // NOTE: we keep roomId in the profile's `worlds` — "has joined" is a history record.
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
    for (const id in this.members) {
      const slot = colorSlot(this.members[id].color);
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
      if (!this.flooding[id] || !this.members[id]) continue;
      const slot = colorSlot(this.members[id].color);
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
  // Synthesize the wire roster from world members (color/ticks) + global profiles (name),
  // back into the old { id:{name,color,ticks} } shape — so the wire protocol is UNCHANGED
  // and the client needs no edits despite the player/world save split.
  rosterForWire() {
    const out = {};
    for (const id in this.members) {
      const m = this.members[id], prof = playerStore.get(id);
      out[id] = { name: (prof && prof.name) || "Player", color: m.color, ticks: m.ticks };
    }
    return out;
  }
  snapshotTo(ws) {
    try {
      ws.send(JSON.stringify({
        type: "snapshot", w: W, h: H,
        players: this.rosterForWire(),
        grid: Buffer.from(this.grid).toString("base64"),
        bands: this.serializeBands(),
      }));
    } catch (_) {}
  }
  broadcastPlayers() { this.broadcast({ type: "players", players: this.rosterForWire() }); }
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
  // Read-only player profile (name / lifetime / which worlds joined). Lets "my worlds"
  // be queryable later; privacy-safe (counts + name only, no key contents). 404 if unknown.
  const apiM = p.match(/^\/api\/player\/([^/]+)$/);
  if (apiM) {
    const prof = playerStore.peek(decodeURIComponent(apiM[1]));
    if (!prof) { res.writeHead(404, { "content-type": "application/json; charset=utf-8" }); res.end('{"error":"not_found"}'); return; }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify({ id: prof.id, name: prof.name, lifetime: prof.lifetime, worlds: prof.worlds, createdAt: prof.createdAt, lastSeen: prof.lastSeen }));
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
