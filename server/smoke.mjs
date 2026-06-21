// Stage 1 authoritative-server smoke test. Run the server first (`npm run server`),
// then `node server/smoke.mjs`. Verifies: join → snapshot + objective colour,
// input → server broadcasts grid patches, a NEW joiner sees the already-poured
// canvas (server is the single source of truth), and the 4-player cap.

const HOST = process.env.SMOKE_HOST || "127.0.0.1:8090";
const WSP = /workers\.dev|:443/.test(HOST) ? "wss" : "ws";
const ROOM = "S1" + Date.now().toString(36).slice(-5); // fresh room each run
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ok  " : " FAIL ") + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(pk) {
  const ws = new WebSocket(`${WSP}://${HOST}/r/${ROOM}?_pk=${pk}`);
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

  console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed (room ${ROOM})`);
  process.exit(fail ? 1 : 0);
};
main().catch((e) => { console.error("crashed:", e); process.exit(2); });
