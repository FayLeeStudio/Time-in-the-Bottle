// Phase A protocol smoke test against a local `wrangler dev` (127.0.0.1:8787).
// Validates colour assignment, the 4-player cap, keep-on-disconnect, and `leave`.
// Run `npm run party:dev` first, then `node party/smoke-test.mjs`.

const HOST = process.env.SMOKE_HOST || "127.0.0.1:8787"; // SMOKE_HOST=...workers.dev → prod
const WSPROTO = /workers\.dev/.test(HOST) ? "wss" : "ws";
const ROOM = "SMOKE" + Date.now().toString(36).slice(-4); // fresh room each run
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ok  " : " FAIL ") + m); };

function open(pk) {
  const ws = new WebSocket(`${WSPROTO}://${HOST}/parties/main/${ROOM}?_pk=${pk}`);
  const states = [];
  ws.addEventListener("message", (e) => states.push(JSON.parse(e.data)));
  return Object.assign(ws, {
    states,
    ready: new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }),
    last: () => states[states.length - 1],
    // resolve once any received state matches `pred`, or after `ms`
    until: (pred, ms = 4000) => new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = states.find(pred);
        if (hit || Date.now() - t0 > ms) { clearInterval(iv); res(hit); }
      }, 25);
    }),
  });
}
const join = (ws, name) => ws.send(JSON.stringify({ type: "join", name, color: "auto" }));
const colorOf = (st, pk) => st && st.players && st.players[pk] && st.players[pk].color;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  // 1) four players get four distinct objective colours, in join order
  const p1 = open("p1"); await p1.ready; join(p1, "P1");
  await p1.until((s) => colorOf(s, "p1"));
  ok(colorOf(p1.last(), "p1") === "amber", "p1 -> amber (first join)");

  const p2 = open("p2"); await p2.ready; join(p2, "P2");
  await p2.until((s) => colorOf(s, "p2"));
  ok(colorOf(p2.last(), "p2") === "teal", "p2 -> teal");

  const p3 = open("p3"); await p3.ready; join(p3, "P3");
  await p3.until((s) => colorOf(s, "p3"));
  ok(colorOf(p3.last(), "p3") === "violet", "p3 -> violet");

  const p4 = open("p4"); await p4.ready; join(p4, "P4");
  await p4.until((s) => colorOf(s, "p4"));
  ok(colorOf(p4.last(), "p4") === "rose", "p4 -> rose");

  await p1.until((s) => s.players && Object.keys(s.players).length === 4);
  ok(Object.keys(p1.last().players).length === 4, "p1 sees 4 players");
  ok(Array.isArray(p1.last().frozenBands), "state carries a frozenBands array");

  // 2) a 5th NEW player is bounced with room_full (over the WS, not a 403 body)
  const p5 = open("p5"); await p5.ready; join(p5, "P5");
  await p5.until((s) => s.type === "error");
  ok(p5.last() && p5.last().reason === "room_full", "5th new player -> room_full");

  // 3) keep-on-disconnect: p4 drops, p1 still sees p4 (offline != exit)
  p4.close(); await sleep(600);
  p2.send(JSON.stringify({ type: "progress", ticks: 7 })); // force a fresh broadcast
  await p2.until((s) => colorOf(s, "p2") === "teal");
  ok(!!colorOf(p1.last(), "p4"), "p4 still present after disconnect (kept)");

  // 4) returning player keeps identity/colour and is NOT bounced even at 4
  const p4b = open("p4"); await p4b.ready; join(p4b, "P4");
  await p4b.until((s) => colorOf(s, "p4"));
  ok(p4b.last().type !== "error", "returning p4 not bounced at 4 players");
  ok(colorOf(p4b.last(), "p4") === "rose", "returning p4 keeps rose");

  // 5) explicit leave frees the colour for a brand-new player
  p3.send(JSON.stringify({ type: "leave" })); await sleep(600);
  const p6 = open("p6"); await p6.ready; join(p6, "P6");
  await p6.until((s) => colorOf(s, "p6"));
  ok(p6.last().type !== "error", "new player joins after a leave");
  ok(colorOf(p6.last(), "p6") === "violet", "freed colour (violet) reused by p6");

  console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed (room ${ROOM})`);
  process.exit(fail ? 1 : 0);
};
const mini = async () => {
  // Production-friendly check (SMOKE_MIN=1): just two players over the WAN — no
  // 5-connection burst, which the GFW/VPN path to Cloudflare tends to choke on.
  // Verifies colour assignment + mutual visibility, then cleans up with leave.
  const a = open("alice"); await a.ready; join(a, "Alice");
  await a.until((s) => colorOf(s, "alice"));
  const b = open("bob"); await b.ready; join(b, "Bob");
  await b.until((s) => colorOf(s, "bob"));
  await a.until((s) => colorOf(s, "alice") && colorOf(s, "bob"));
  ok(colorOf(a.last(), "alice") === "amber", "alice -> amber");
  ok(colorOf(b.last(), "bob") === "teal", "bob -> teal (distinct objective colour)");
  ok(!!colorOf(a.last(), "bob"), "alice sees bob (two players visible)");
  a.send(JSON.stringify({ type: "leave" })); b.send(JSON.stringify({ type: "leave" }));
  await sleep(400);
  console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed (room ${ROOM}, mini)`);
  process.exit(fail ? 1 : 0);
};

const run = process.env.SMOKE_MIN ? mini : main;
run().catch((e) => { console.error("test crashed:", e); process.exit(2); });
