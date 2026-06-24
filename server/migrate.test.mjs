// Self-contained test for server/migrate.mjs (no live server needed).
// Builds fake OLD saves in a temp SAND_DATA_DIR, runs the migration, asserts the decoupled
// outputs (world rosters + merged global profiles + legacy backups), then re-runs to prove
// idempotency. Run: `node server/migrate.test.mjs`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE = path.join(__dirname, "migrate.mjs");
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "  ok  " : " FAIL ") + m); };
const rj = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sand-migrate-"));
const gridB64 = Buffer.from([1, 2, 3, 0, 4]).toString("base64");
const runMigrate = () => execFileSync(process.execPath, [MIGRATE], { env: { ...process.env, SAND_DATA_DIR: dir }, encoding: "utf8" });

try {
  // OLD coupled saves: pid-1 is in BOTH rooms (newer room BBBB should win the name).
  const aaaa = path.join(dir, "AAAA.json"), bbbb = path.join(dir, "BBBB.json");
  fs.writeFileSync(aaaa, JSON.stringify({ players: { "pid-1": { name: "Old", color: "amber", ticks: 100 }, "pid-2": { name: "Bob", color: "teal", ticks: 50 } }, grid: gridB64, bands: [] }));
  fs.writeFileSync(bbbb, JSON.stringify({ players: { "pid-1": { name: "New", color: "violet", ticks: 300 } }, grid: gridB64, bands: [] }));
  // AAAA older than BBBB so oldest-first processing makes "New" (BBBB) the surviving name.
  const t = Date.now() / 1000;
  fs.utimesSync(aaaa, t - 100, t - 100);
  fs.utimesSync(bbbb, t, t);

  console.log(runMigrate().trim());

  const wA = rj(path.join(dir, "worlds", "AAAA.json"));
  const wB = rj(path.join(dir, "worlds", "BBBB.json"));
  ok(wA.id === "AAAA" && wA.grid === gridB64, "world AAAA: id + grid carried verbatim");
  ok(wA.members["pid-1"] && wA.members["pid-1"].color === "amber" && wA.members["pid-1"].ticks === 100, "world AAAA member pid-1 keeps per-world color/ticks");
  ok(!("name" in wA.members["pid-1"]), "world member has no name (decoupled to the profile)");
  ok(wA.members["pid-2"] && wA.members["pid-2"].color === "teal", "world AAAA member pid-2 present");
  ok(wB.members["pid-1"] && wB.members["pid-1"].color === "violet" && wB.members["pid-1"].ticks === 300, "world BBBB member pid-1 (distinct per-world color/ticks)");

  const p1 = rj(path.join(dir, "players", "pid-1.json"));
  const p2 = rj(path.join(dir, "players", "pid-2.json"));
  ok(p1.name === "New", "profile pid-1: newest room's name wins (New)");
  ok(p1.worlds.includes("AAAA") && p1.worlds.includes("BBBB") && p1.worlds.length === 2, "profile pid-1: worlds = union of both rooms");
  ok(p1.lifetime.ticks === 300, "profile pid-1: lifetime = max(100,300) = 300 (not summed = 400)");
  ok(p1.skills && typeof p1.skills === "object", "profile pid-1: skills{} reserved");
  ok(p2.name === "Bob" && p2.worlds.length === 1 && p2.lifetime.ticks === 50, "profile pid-2: single world, own lifetime");

  ok(fs.existsSync(path.join(dir, "legacy", "AAAA.json")) && fs.existsSync(path.join(dir, "legacy", "BBBB.json")), "originals backed up to legacy/");
  ok(!fs.existsSync(aaaa) && !fs.existsSync(bbbb), "originals removed from top-level data/");

  // idempotency: a second run finds nothing at top level and changes nothing.
  const out2 = runMigrate();
  ok(/nothing to migrate/.test(out2), "re-run is a no-op (nothing to migrate)");
  const wA2 = rj(path.join(dir, "worlds", "AAAA.json"));
  ok(wA2.members["pid-1"].ticks === 100 && fs.readdirSync(path.join(dir, "worlds")).length === 2, "re-run leaves worlds untouched");

  console.log(`\n${fail ? "x" : "+"} ${pass} passed, ${fail} failed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
