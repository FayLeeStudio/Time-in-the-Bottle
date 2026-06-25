// Sand Together — authoritative room server.
//
// The room is the AUTHORITY: it runs the falling-sand sim (the shared CA in ../sim.js),
// holds the one true `grid`, arbitrates input order, persists, and broadcasts. Clients
// send input (their cumulative keystroke count) + render. The sim is being migrated to
// deterministic lockstep (clients will also run ../sim.js locally) — see doc/architecture.md
// 「同步模型」. Privacy red line: we only ever handle counts + grid pixels — never key
// contents, never text.
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
//     { type:"frame",  tick, events:[{op,...},...] }       // lockstep: ordered per-tick event log (OFF unless SAND_EMIT_FRAMES)
//     { type:"players", players }                          // roster change
//     { type:"error",  reason:"room_full" }
//     { type:"pong",   t }                                 // echo of ping t (RTT)
//   playerId is carried in the URL: ws://host/r/<roomId>?_pk=<persistent-id>
//
// Stage 3 (archive, infinite stacking): when the settled pile crowds the top of the
// active grid, the sim moves the bottom rows VERBATIM into a "band" (lossless — the exact
// pixels) and shifts the active grid down; the server broadcasts a `band`. The client
// mirrors the same deterministic shift + archives the band, and renders it below the
// active grid at full resolution (scroll down for the complete history). Size-compression
// (RLE/gzip) is a later optimization. Privacy red line holds: a band stores only colour
// slots + grain counts — never key contents.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { W, ROOM_COLORS, SandSim } = require("../sim.js"); // the shared deterministic CA

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

// --- per-room sim config (the CA itself lives in ../sim.js). W is fixed in sim.js; H and
// the Stage-3 rates are env-overridable here ONLY for the smoke tests — production keeps
// the defaults, which are a shared contract with the client renderer (frontend.md). ---
const H = numEnv("SAND_H", 300); // grid rows (authoritative; the client shows a window). must match the client's H
const ROOM_CAP = 4;
const TICK_MS = 50;              // ~20fps physics
const SAVE_MS = numEnv("SAND_SAVE_MS", 5000);
const DEFAULT_SPOUT = numEnv("SAND_SPOUT", 1);              // brush size out of the box (1 = one-at-a-time; 2+ = continuous)
const FLOOD_ROWS_PER_TICK = 6;                             // debug {type:"flood"}: bottom rows filled/tick
const COMPRESS_ROWS   = numEnv("SAND_COMPRESS_ROWS", 64);   // Stage 3: rows folded into one band
const COMPRESS_MARGIN = numEnv("SAND_COMPRESS_MARGIN", 40); // Stage 3: trigger when a packed layer reaches this near row 0
const CHECKSUM_LOG    = numEnv("SAND_CHECKSUM_LOG", 0);     // >0: log a grid checksum every N ticks (divergence watch; off in prod)
const EMIT_FRAMES     = !!process.env.SAND_EMIT_FRAMES;     // emit the lockstep `frame` event log each tick (OFF in prod → zero wire change; on for replay.test + Phase 2)
// What the sim needs to construct a room. Bundled so every Room (and headless tests) builds
// the same shape; a fresh room gets a crypto seed (load() overrides for an existing world).
const simConfig = () => ({ H, COMPRESS_ROWS, COMPRESS_MARGIN, FLOOD_ROWS_PER_TICK, DEFAULT_SPOUT, rngState: crypto.randomBytes(4).readUInt32LE(0) });

// A band archives COMPRESS_ROWS real rows LOSSLESSLY: `cells` = rows*W bytes (the exact
// pixels, slot 0..4). On the wire/disk those bytes are base64.
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

// A Room WRAPS a SandSim (the authoritative grid) and owns everything the sim does NOT:
// the WebSocket connections, persistence, the player-NAME roster (via profiles), the diff
// baseline `prev` for per-cell patches, and broadcasting. The sim state (grid/bands/rng/
// frame/queues/...) lives entirely on this.sim, so a client running the same sim.js can
// reproduce it from the snapshot + the inputs.
class Room {
  constructor(id, opts = {}) {
    this.id = id;
    this.sim = new SandSim(simConfig());
    this.prev = new Uint8Array(W * H); // last-broadcast grid, for diffing patches
    this.createdAt = Date.now();       // world birth (load() overrides for existing worlds)
    this.members = {};                 // playerId -> { color, ticks, contributionTicks, joinedAt } (name lives on the global profile)
    this.conns = new Map();            // ws -> playerId
    this.pendingEvents = [];           // sim-affecting events this tick → broadcast as a `frame` (lockstep)
    this.dirty = false;                // grid/players changed since last save
    this.timer = null;
    this.saveTimer = null;
    if (!opts.noLoad) this.load();          // opts.noLoad/noAutoRun: headless construction (tests)
    if (!opts.noAutoRun) this.ensureRunning();
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
  serializeBands() { return this.sim.bands.map((b) => ({ rows: b.rows, n: b.n, cells: b64enc(b.cells) })); }
  load() {
    // Preferred: the new world file under worlds/. Fallback: a legacy top-level
    // data/<id>.json in the old { players:{pid:{name,color,ticks}} } shape — convert it
    // in place (a safety net; the normal upgrade path is server/migrate.mjs).
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file(), "utf8")); } catch (_) {}
    if (!d) { try { d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, this.safeId() + ".json"), "utf8")); } catch (_) {} }
    if (!d) return; // fresh room
    if (d.createdAt) this.createdAt = d.createdAt;
    if (typeof d.rng === "number") this.sim.rngState = d.rng >>> 0; // resume the deterministic stream
    if (d.grid) { const buf = Buffer.from(d.grid, "base64"); this.sim.grid.set(buf.subarray(0, W * H)); }
    if (Array.isArray(d.bands)) this.sim.bands = d.bands.map((b) => { const rows = b.rows | 0; return { rows, n: b.n | 0, cells: b64dec(b.cells, rows * W) }; });
    if (d.members && typeof d.members === "object") {
      for (const id in d.members) { const m = d.members[id] || {}; this.addMemberLocal(id, m.color || ROOM_COLORS[0], { ticks: m.ticks | 0, contributionTicks: m.contributionTicks | 0, joinedAt: m.joinedAt || 0 }); }
    } else if (d.players && typeof d.players === "object") {
      // legacy shape: lift each player's name into the global profile, keep color/ticks as a member.
      for (const id in d.players) {
        const p = d.players[id] || {};
        this.addMemberLocal(id, p.color || ROOM_COLORS[0], { ticks: p.ticks | 0, contributionTicks: 0, joinedAt: 0 });
        playerStore.touch(id, p.name); playerStore.addWorld(id, this.id); playerStore.bumpLifetime(id, p.ticks | 0);
      }
      this.dirty = true; // re-persist under the new worlds/ path + shape on the next save
    }
    this.prev.set(this.sim.grid);
  }
  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = { id: this.id, createdAt: this.createdAt, rng: this.sim.rngState, members: this.members, grid: Buffer.from(this.sim.grid).toString("base64"), bands: this.serializeBands() };
    fs.writeFile(this.file(), JSON.stringify(data), () => {});
  }

  // Add a member to BOTH the rich persistence roster (this.members) and the slim sim
  // roster (this.sim.members) in one place, so they never drift apart.
  addMemberLocal(id, color, extra) { this.members[id] = Object.assign({ color }, extra || {}); this.sim.addMember(id, color); }

  // Record a sim-affecting event for this tick's `frame` log (lockstep). Only when
  // SAND_EMIT_FRAMES is on (off in prod → zero overhead, no wire change). Payload is
  // counts/colours/sizes/bools only — never key contents. The deterministic frame stream
  // lets a client running ../sim.js reproduce the grid from input alone.
  recordEvent(ev) { if (EMIT_FRAMES) this.pendingEvents.push(ev); }

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
      const color = this.takeColor();
      this.addMemberLocal(playerId, color, { ticks: 0, contributionTicks: 0, joinedAt: Date.now() });
      this.recordEvent({ op: "join", id: playerId, color });
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
    this.sim.enqueue(playerId, delta);           // delta grains → pour queue (sim caps it)
    if (delta > 0) this.recordEvent({ op: "input", id: playerId, delta });
    m.ticks = ticks;
    playerStore.bumpLifetime(playerId, ticks); // global lifetime = high-water mark of the device counter
  }
  setSpout(playerId, size) { if (this.members[playerId]) { this.sim.setSpout(playerId, size); this.recordEvent({ op: "spout", id: playerId, size: size | 0 }); } } // pour brush 1..5
  setFirehose(playerId, on) { if (this.members[playerId]) { this.sim.setFlood(playerId, on); this.recordEvent({ op: "flood", id: playerId, on: !!on }); } } // debug fast bottom-fill
  setPour(playerId, on) { if (this.members[playerId]) { this.sim.setPour(playerId, on); this.recordEvent({ op: "pour", id: playerId, on: !!on }); } }        // debug keep spout saturated
  leave(playerId) {
    if (!this.members[playerId]) return;
    delete this.members[playerId]; this.sim.removeMember(playerId);
    this.recordEvent({ op: "leave", id: playerId });
    // NOTE: we keep roomId in the profile's `worlds` — "has joined" is a history record.
    this.dirty = true; this.broadcastPlayers();
  }
  drop(ws) { // keep player (offline ≠ exit), but stop debug pours so they can't run forever
    const pid = this.conns.get(ws);
    this.conns.delete(ws);
    if (pid) { this.sim.setFlood(pid, false); this.sim.setPour(pid, false); this.recordEvent({ op: "flood", id: pid, on: false }); this.recordEvent({ op: "pour", id: pid, on: false }); }
    this.maybeStop();
  }
  reset() { // empty the room's shared canvas + archive (Stage 1: anyone may; prototype)
    this.sim.reset(); this.prev.fill(0); this.dirty = true;
    this.recordEvent({ op: "reset" });
    for (const ws of this.conns.keys()) this.snapshotTo(ws);
  }

  // ---- loop + broadcast ----
  tick() {
    this.sim.step();
    const g = this.sim.grid, pv = this.prev, cells = [];
    for (let i = 0; i < g.length; i++) if (g[i] !== pv[i]) { cells.push(i, g[i]); pv[i] = g[i]; }
    if (cells.length) { this.dirty = true; this.broadcast({ type: "patch", c: cells }); }
    // Archive AFTER the patch broadcast so clients reach the pre-shift grid first, then
    // apply the same shift on the `band` message. maybeArchive() folds a genuinely packed
    // bottom (not the falling curtain) and returns the new band, or null.
    const band = this.sim.maybeArchive();
    if (band) {
      this.prev.set(this.sim.grid); // diff baseline = post-shift grid (no giant patch)
      this.dirty = true;
      this.broadcast({ type: "band", rows: band.rows, n: band.n, cells: b64enc(band.cells) });
    }
    // Lockstep: broadcast this tick's ordered event log (the events applied since the last
    // tick, then this step). A client running ../sim.js applies them + steps to reproduce
    // the grid — patch-free. Tick number lets the client align its local clock. Off in prod.
    if (EMIT_FRAMES) { this.broadcast({ type: "frame", tick: this.sim.frame, events: this.pendingEvents }); this.pendingEvents = []; }
    if (CHECKSUM_LOG && this.sim.frame % CHECKSUM_LOG === 0) console.log(`[sand] ${this.id} f${this.sim.frame} chk ${this.sim.checksum().toString(16)}`);
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
        grid: Buffer.from(this.sim.grid).toString("base64"),
        bands: this.serializeBands(),
        // Full sim state so a client running /sim.js resumes deterministically (lockstep
        // hot-join): PRNG stream position + tick + pour queues + brush/debug toggles.
        // Additive — old clients ignore these. Privacy: counts/sizes/bools only, no text.
        rng: this.sim.rngState, frame: this.sim.frame,
        queues: this.sim.queues, spout: this.sim.spoutSize,
        pour: this.sim.pouring, flood: this.sim.flooding,
        lockstep: EMIT_FRAMES, // tell the client whether to expect the `frame` stream (run lockstep) vs render patches
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
const SIM_JS = path.join(__dirname, "..", "sim.js");
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
  if (p === "/sim.js") {
    // The shared deterministic CA, same-origin for the page's <script src="/sim.js">.
    // no-cache so a deploy takes effect on the next load (same as index.html).
    fs.readFile(SIM_JS, (err, buf) => {
      if (err) { res.writeHead(404); res.end("sim.js not found"); return; }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
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
if (require.main === module) {
  server.listen(PORT, () => console.log(`[sand] authoritative server on :${PORT}`));
}

// Exported for headless tests (determinism.test.mjs): import Room without opening a port.
module.exports = { Room, getRoom, rooms, playerStore };
