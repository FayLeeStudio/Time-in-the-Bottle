// Authoritative-server smoke test. Run the server first (`npm run server`; for fast disk
// checks: `SAND_SAVE_MS=400 npm run server`), then `node server/smoke.mjs`. Verifies:
// join → snapshot + objective colour, input → server broadcasts grid patches, a NEW joiner
// sees the already-poured canvas (server is the single source of truth), the 4-player cap,
// AND the decoupled saves (world file with a member roster + a GLOBAL player profile on
// disk; lifetime is a high-water mark across rooms; GET /api/player/<id>).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.SMOKE_HOST || "127.0.0.1:8090";
const WSP = /workers\.dev|:443/.test(HOST) ? "wss" : "ws";
const HTTP = WSP === "wss" ? "https" : "http";
const LOCAL = /^(127\.0\.0\.1|localhost)/.test(HOST); // disk checks only when we share the server's fs
const DATA_DIR = process.env.SAND_DATA_DIR || path.join(__dirname, "data");
const ROOM = "S1" + Date.now().toString(36).slice(-5); // fresh room each run
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ok  " : " FAIL ") + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
// Poll a JSON file until it parses and satisfies `pred` (saves are flushed on a timer).
const waitJSON = async (f, pred = () => true, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const d = JSON.parse(fs.readFileSync(f, "utf8")); if (pred(d)) return d; } catch (_) {} await sleep(150); }
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; }
};

function open(pk, room = ROOM) {
  const ws = new WebSocket(`${WSP}://${HOST}/r/${room}?_pk=${pk}`);
  const msgs = [];
  ws.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
  return Object.assign(ws, {
    msgs,
    ready: new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }),
    until: (pred, ms = 2500) => new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => { const h = msgs.find(pred); if (h || Date.now() - t0 > ms) { clearInterval(iv); res(h); } }, 25);
    }),
  });
}
const join = (ws, name) => ws.send(JSON.stringify({ type: "join", name, color: "auto" }));
const colorOf = (snap, pk) => snap && snap.players && snap.players[pk] && snap.players[pk].color;
const gridNonZero = (b64) => { const buf = Buffer.from(b64, "base64"); let n = 0; for (const v of buf) if (v) n++; return n; };

const main = async () => {
  const p1 = open("p1"); await p1.ready; join(p1, "P1");
  const s1 = await p1.until((m) => m.type === "snapshot");
  ok(s1 && colorOf(s1, "p1") === "amber", "p1 joins → snapshot, colour amber");
  ok(s1 && gridNonZero(s1.grid) === 0, "fresh room grid is empty");

  p1.send(JSON.stringify({ type: "input", ticks: 120 }));   // p1 pours
  await p1.until((m) => m.type === "patch");
  await sleep(800);                                          // let grains spawn + fall
  ok(p1.msgs.some((m) => m.type === "patch"), "input → server broadcasts grid patches");

  // p2 joins the SAME room → must see p1's already-poured sand (authoritative canvas)
  const p2 = open("p2"); await p2.ready; join(p2, "P2");
  const s2 = await p2.until((m) => m.type === "snapshot");
  ok(s2 && colorOf(s2, "p2") === "teal", "p2 → teal (distinct objective colour)");
  ok(s2 && colorOf(s2, "p1") === "amber", "p2's snapshot includes p1");
  ok(s2 && gridNonZero(s2.grid) > 0, "new joiner's snapshot carries the existing canvas (server-authoritative)");

  // 4-player cap
  const p3 = open("p3"); await p3.ready; join(p3, "P3"); await p3.until((m) => m.type === "snapshot");
  const p4 = open("p4"); await p4.ready; join(p4, "P4"); await p4.until((m) => m.type === "snapshot");
  const p5 = open("p5"); await p5.ready; join(p5, "P5");
  const e5 = await p5.until((m) => m.type === "error");
  ok(e5 && e5.reason === "room_full", "5th new player → room_full");

  // --- decoupled saves: world roster on disk + global player profile ---
  const RUN = Date.now().toString(36).slice(-5);
  const PA = "pa_" + RUN;                                   // a FRESH player (no cross-run pollution)
  const RA = "S3" + RUN.toUpperCase(), RB = "S2" + RUN.toUpperCase(); // two FRESH, distinct worlds (not the full cap-test room)
  const a1 = open(PA, RA); await a1.ready; join(a1, "Alice"); await a1.until((m) => m.type === "snapshot");
  a1.send(JSON.stringify({ type: "input", ticks: 120 }));   // pour into world A
  await a1.until((m) => m.type === "patch");

  if (LOCAL) {
    const wA = await waitJSON(path.join(DATA_DIR, "worlds", safe(RA) + ".json"), (d) => d.members && d.members[PA]);
    ok(wA && wA.members && wA.members[PA], "world save = worlds/<room>.json with a member roster");
    ok(wA && wA.members[PA] && !("name" in wA.members[PA]), "world member carries NO name (name lives on the profile)");
    const pfA = path.join(DATA_DIR, "players", safe(PA) + ".json");
    const profA = await waitJSON(pfA, (d) => d.name === "Alice" && d.lifetime && d.lifetime.ticks > 0 && d.worlds.includes(RA));
    ok(profA && profA.name === "Alice", "player profile = players/<id>.json stores the global name");
    ok(profA && profA.lifetime && profA.lifetime.ticks > 0, "profile accrues lifetime ticks");
    ok(profA && profA.worlds.includes(RA), "profile records the world joined (membership index)");

    // same _pk joins a SECOND world → ONE profile, worlds unioned, lifetime = max (NOT summed)
    const a2 = open(PA, RB); await a2.ready; join(a2, "Alice"); await a2.until((m) => m.type === "snapshot");
    a2.send(JSON.stringify({ type: "input", ticks: 200 }));
    const profB = await waitJSON(pfA, (d) => d.worlds.includes(RB) && d.lifetime.ticks === 200);
    ok(profB && profB.worlds.includes(RA) && profB.worlds.includes(RB), "one profile spans both worlds");
    ok(profB && profB.lifetime.ticks === 200, "lifetime is a high-water mark (200), not a per-room sum (would be 320)");
    a2.close();
  } else {
    console.log("  --  (skipping on-disk save checks: HOST is not local)");
  }

  // read-only profile endpoint (works against any host)
  try {
    const r = await fetch(`${HTTP}://${HOST}/api/player/${PA}`);
    const body = await r.json();
    ok(r.ok && body.id === PA && Array.isArray(body.worlds) && body.worlds.includes(RA), "GET /api/player/<id> returns the profile");
  } catch (e) { ok(false, "GET /api/player/<id> returns the profile (" + e.message + ")"); }
  a1.close();

  console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed (room ${ROOM})`);
  process.exit(fail ? 1 : 0);
};
main().catch((e) => { console.error("crashed:", e); process.exit(2); });
