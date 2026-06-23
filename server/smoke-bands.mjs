// Stage 3 band-compression smoke test. Self-contained: it spawns its OWN tiny,
// fast server (env-tuned small grid so the pile reaches the top in a couple of
// seconds), floods input, and asserts the archive works end to end.
//   node server/smoke-bands.mjs
// Verifies: heavy pouring folds the bottom into a `band` (rows/n/cols), the active
// grid shifts down and keeps accepting new sand, a late joiner's snapshot carries
// the bands, and bands survive a server restart (disk persistence).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "index.js");
const PORT_A = Number(process.env.SMOKE_PORT || 8097);
const PORT_B = PORT_A + 1;                       // restart on a fresh port → no port-reuse race
const ROOM = "B" + Date.now().toString(36).slice(-5);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sand-bands-"));

// A tiny, fast room so compression triggers in seconds. Production keeps the
// defaults in index.js; these env overrides exist only for this test.
const ENV = {
  ...process.env,
  SAND_H: "80",
  SAND_COMPRESS_ROWS: "24",
  SAND_COMPRESS_MARGIN: "30",
  SAND_MAX_SPAWN: "60",
  SAND_SAVE_MS: "400",
  SAND_DATA_DIR: DATA_DIR,
};

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ok  " : " FAIL ") + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gridNonZero = (b64) => { const b = Buffer.from(b64 || "", "base64"); let n = 0; for (const v of b) if (v) n++; return n; };

function startServer(port) {
  const child = spawn(process.execPath, [SERVER], { env: { ...ENV, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((res) => {
    const onData = (b) => { if (String(b).includes("authoritative server on")) { child.stdout.off("data", onData); res(); } };
    child.stdout.on("data", onData);
  });
  child.stderr.on("data", (b) => process.stderr.write("[srv] " + b));
  return { child, ready };
}

function open(pk, port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/r/${ROOM}?_pk=${pk}`);
  const msgs = [];
  ws.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
  return Object.assign(ws, {
    msgs,
    ready: new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }),
    until: (pred, ms = 25000) => new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => { const h = msgs.find(pred); if (h || Date.now() - t0 > ms) { clearInterval(iv); res(h); } }, 25);
    }),
  });
}
const join = (ws, name) => ws.send(JSON.stringify({ type: "join", name, color: "auto" }));

// keep a player's spawn queue topped so the pile actually reaches the top
function flood(ws) {
  let t = 0;
  const iv = setInterval(() => { if (ws.readyState === 1) { t += 1000; ws.send(JSON.stringify({ type: "input", ticks: t })); } }, 120);
  return () => clearInterval(iv);
}

async function main() {
  let srv = startServer(PORT_A);
  await srv.ready;

  const ps = [open("p1", PORT_A), open("p2", PORT_A), open("p3", PORT_A)];
  for (const p of ps) await p.ready;
  ps.forEach((p, i) => join(p, "P" + (i + 1)));
  for (const p of ps) await p.until((m) => m.type === "snapshot");

  const stops = ps.map(flood);

  // 1) pouring eventually folds the bottom into a band
  const band = await ps[0].until((m) => m.type === "band", 25000);
  ok(!!band, "heavy pour triggers a band (bottom folded into the archive)");
  ok(band && band.rows === 24, "band.rows = COMPRESS_ROWS (24)");
  const cols = band ? Buffer.from(band.cols, "base64") : Buffer.alloc(0);
  ok(cols.length === 80 && [...cols].some((v) => v > 0), "band.cols decodes to W bytes with colour");
  ok(band && band.n > 0, "band.n counts the grains it archived");

  // 2) after the shift the active grid keeps accepting sand
  const before = ps[0].msgs.length;
  const morePatch = await ps[0].until((m, i) => i >= before && m.type === "patch", 3000);
  ok(!!morePatch, "active grid keeps receiving sand after the shift");

  // 3) a late joiner's snapshot carries the archive (in-memory persistence)
  const p4 = open("p4", PORT_A); await p4.ready; join(p4, "P4");
  const s4 = await p4.until((m) => m.type === "snapshot");
  ok(s4 && Array.isArray(s4.bands) && s4.bands.length >= 1, "late joiner's snapshot includes bands");
  ok(s4 && gridNonZero(s4.grid) > 0, "late joiner's snapshot carries the active grid too");

  stops.forEach((s) => s());
  [...ps, p4].forEach((w) => { try { w.close(); } catch (_) {} });

  // 4) bands survive a server restart (disk persistence)
  await sleep(700);                 // let the dirty room flush (SAVE_MS=400)
  srv.child.kill(); await sleep(300);
  srv = startServer(PORT_B); await srv.ready;     // same DATA_DIR, fresh port
  // reconnect as an EXISTING player (the room reloaded all 4, so a new id would be
  // room_full); a returning player gets the persisted snapshot.
  const p5 = open("p1", PORT_B); await p5.ready; join(p5, "P1");
  const s5 = await p5.until((m) => m.type === "snapshot");
  ok(s5 && Array.isArray(s5.bands) && s5.bands.length >= 1, "bands reload from disk after restart");
  ok(s5 && gridNonZero(s5.grid) > 0, "active grid reloads from disk after restart");
  try { p5.close(); } catch (_) {}

  srv.child.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed (room ${ROOM})`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(2); });
