// Phase 2c own-sand prediction test. Mirrors the browser's deriveRenderSim(): clone the
// confirmed authSim, add MY un-confirmed grains, fast-forward a few ticks. Asserts my sand
// appears BEFORE the server confirms it, the derivation is deterministic + side-effect-free
// (never corrupts authSim), and no unconfirmed grains ⇒ no predicted sand.
//   node server/predict.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SandSim } = require("../sim.js");

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ok  " : " FAIL ") + m); };
const grains = (s) => { let n = 0; for (const v of s.grid) if (v) n++; return n; };
const NO_FLOOD = {};

// exact mirror of index.html deriveRenderSim() (sans the module-level aliasing)
function deriveRenderSim(a, myCount, confirmed, myId, LEAD) {
  const r = new SandSim({ H: a.H });
  r.rngState = a.rngState; r.frame = a.frame;
  r.grid.set(a.grid);
  r.bands = a.bands;
  r.members = a.members; r.spoutSize = a.spoutSize; r.pouring = a.pouring; r.flooding = NO_FLOOD;
  r.queues = Object.assign({}, a.queues);
  const predicted = myCount - confirmed;
  if (predicted > 0 && myId) r.enqueue(myId, predicted);
  for (let i = 0; i < LEAD; i++) r.step();
  return r;
}

// authSim: empty grid, I'm a confirmed member with a wide brush so prediction shows fast.
const a = new SandSim({ rngState: 0x1234 });
a.addMember("me", "amber");
a.addMember("you", "teal");
a.setSpout("me", 4);
const aChkBefore = a.checksum(), aGrainsBefore = grains(a);

// I've typed 200 grains; the server has confirmed 0 yet → predict them.
const r = deriveRenderSim(a, 200, 0, "me", 3);
ok(grains(r) > 0, "predicted own grains appear in the render sim before the server confirms (" + grains(r) + ")");
ok(a.checksum() === aChkBefore && grains(a) === aGrainsBefore, "deriveRenderSim never mutates authSim (no side effects)");

// deterministic: same authSim + same unconfirmed count ⇒ identical render
const r2 = deriveRenderSim(a, 200, 0, "me", 3);
ok(r.checksum() === r2.checksum(), "deriveRenderSim is deterministic (same inputs ⇒ same render)");

// nothing un-confirmed ⇒ no predicted sand (pure fast-forward of an empty grid)
const r0 = deriveRenderSim(a, 50, 50, "me", 3);
ok(grains(r0) === 0, "no un-confirmed grains ⇒ no predicted sand");

// the predicted grains are MINE (amber = slot 1), at my spout column — not someone else's
let mine = 0, other = 0; for (const v of r.grid) { if (v === 1) mine++; else if (v) other++; }
ok(mine > 0 && other === 0, "predicted sand is only MY colour (own-spout prediction, no one else's)");

console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
