// Phase 2b lockstep-client test over the REAL wire. A node client builds authSim from
// the snapshot (the exact fields the browser parses) and advances it by the `frame` log
// (incl. mirroring the server's archive); then a SECOND fresh client's snapshot at server
// frame F must equal authSim's grid at frame F. Proves snapshot-field parsing + frame
// consumption + archive mirroring reproduce the server's grid end to end.
//   node server/lockstep.test.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SandSim, W } = require("../sim.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "index.js");
const PORT = Number(process.env.SMOKE_PORT || 8096);
const ROOM = "L" + Date.now().toString(36).slice(-5);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sand-lock-"));
const ENV = { ...process.env, SAND_EMIT_FRAMES: "1", SAND_SAVE_MS: "60000", SAND_DATA_DIR: DATA_DIR, PORT: String(PORT) };

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ok  " : " FAIL ") + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s || "", "base64");

function startServer() {
  const child = spawn(process.execPath, [SERVER], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((res) => { const on = (x) => { if (String(x).includes("authoritative server on")) { child.stdout.off("data", on); res(); } }; child.stdout.on("data", on); });
  child.stderr.on("data", (x) => process.stderr.write("[srv] " + x));
  return { child, ready };
}
function open(pk) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/r/${ROOM}?_pk=${pk}`);
  const o = { ws, ready: new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }) };
  ws.addEventListener("message", (e) => o.onmsg && o.onmsg(JSON.parse(e.data)));
  return o;
}
const send = (o, m) => o.ws.send(JSON.stringify(m));

// --- mirror of the browser client's lockstep logic (index.html) ---
function applyFrameEvents(s, evs) {
  for (const ev of evs || []) {
    if (ev.op === "input") s.enqueue(ev.id, ev.delta);
    else if (ev.op === "join") s.addMember(ev.id, ev.color);
    else if (ev.op === "leave") s.removeMember(ev.id);
    else if (ev.op === "spout") s.setSpout(ev.id, ev.size);
    else if (ev.op === "pour") s.setPour(ev.id, ev.on);
    else if (ev.op === "flood") s.setFlood(ev.id, ev.on);
    else if (ev.op === "reset") s.reset();
  }
}
function buildAuthSim(msg) {
  const s = new SandSim({ H: msg.h, rngState: msg.rng >>> 0 }); // defaults match the server (COMPRESS_ROWS=64 etc.)
  if (msg.grid) s.grid.set(b64(msg.grid).subarray(0, W * msg.h));
  s.bands = Array.isArray(msg.bands) ? msg.bands.map((b) => { const r = b.rows | 0; const c = new Uint8Array(r * W); c.set(b64(b.cells).subarray(0, r * W)); return { rows: r, n: b.n | 0, cells: c }; }) : [];
  s.frame = msg.frame | 0;
  if (msg.queues) s.queues = { ...msg.queues };
  if (msg.spout) s.spoutSize = { ...msg.spout };
  if (msg.pour) s.pouring = { ...msg.pour };
  if (msg.flood) s.flooding = { ...msg.flood };
  s.members = {};
  if (msg.players) for (const id in msg.players) s.addMember(id, msg.players[id].color);
  return s;
}

async function main() {
  const srv = startServer(); await srv.ready;

  const a = open("a"); await a.ready;
  let authSim = null; const chkByFrame = new Map();
  a.onmsg = (m) => {
    if (m.type === "snapshot") { authSim = buildAuthSim(m); chkByFrame.set(authSim.frame, authSim.checksum()); }
    else if (m.type === "frame" && authSim) {
      applyFrameEvents(authSim, m.events); authSim.step(); authSim.maybeArchive(); // mirror server tick
      chkByFrame.set(authSim.frame, authSim.checksum());
    }
  };
  send(a, { type: "join", name: "A" });
  await sleep(200);
  send(a, { type: "spout", size: 4 });
  send(a, { type: "input", ticks: 300 });          // pour
  await sleep(400);
  send(a, { type: "flood", on: true });            // fill fast → trigger an archive
  for (let i = 0; i < 120 && (!authSim || authSim.bands.length < 1); i++) await sleep(100); // poll until archived (robust to machine load)
  send(a, { type: "flood", on: false });
  await sleep(300);

  // fresh client B → its snapshot at server frame F must match authSim's grid at F
  const b = open("b"); await b.ready;
  let bSnap = null; b.onmsg = (m) => { if (m.type === "snapshot" && !bSnap) bSnap = m; };
  send(b, { type: "join", name: "B" });
  let bChk = null, matched = null;
  for (let i = 0; i < 200 && matched === null; i++) {
    await sleep(25);
    if (bSnap && bChk === null) bChk = buildAuthSim(bSnap).checksum();
    if (bSnap && chkByFrame.has(bSnap.frame)) matched = (chkByFrame.get(bSnap.frame) === bChk);
  }

  ok(authSim && authSim.frame > 30, "authSim advanced by the frame stream (" + (authSim ? authSim.frame : 0) + " ticks)");
  ok(authSim && authSim.bands.length >= 1, "authSim archived a band from the frame stream (archive mirrored)");
  ok(bSnap != null, "fresh client B received a snapshot (carrying rng/frame/queues)");
  ok(matched === true, "authSim grid at frame F == client B's snapshot grid at F (client mirrors the server)");

  srv.child.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed (room ${ROOM})`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(2); });
