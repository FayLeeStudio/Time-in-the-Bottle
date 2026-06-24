#!/usr/bin/env node
// One-off migration: the OLD coupled save (data/<roomId>.json holding
//   { players:{pid:{name,color,ticks}}, grid, bands })
// → the DECOUPLED saves:
//   data/worlds/<roomId>.json   { id, createdAt, members:{pid:{color,ticks,contributionTicks,joinedAt}}, grid, bands }
//   data/players/<playerId>.json { id, name, createdAt, lastSeen, skills, lifetime:{ticks}, worlds:[...] }
// Originals are MOVED to data/legacy/ as a backup (never deleted).
//
// Idempotent: once originals are relocated a re-run is a no-op. Same playerId across
// several old rooms merges into ONE profile — name = most recent room (we process
// oldest-first), worlds = union, lifetime.ticks = max (NOT a sum — the client counter is
// device-monotonic, so summing would over-count). Privacy red line holds: only counts /
// colors / pixels / display name move — never key contents.
//
// Run: `npm run migrate` (or `node server/migrate.mjs`). Honors SAND_DATA_DIR.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SAND_DATA_DIR || path.join(__dirname, "data");
const WORLDS_DIR = path.join(DATA_DIR, "worlds");
const PLAYERS_DIR = path.join(DATA_DIR, "players");
const LEGACY_DIR = path.join(DATA_DIR, "legacy");

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
const freshProfile = (id) => ({ id, name: "Player", createdAt: Date.now(), lastSeen: 0, skills: {}, lifetime: { ticks: 0 }, worlds: [] });
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

function main() {
  for (const d of [WORLDS_DIR, PLAYERS_DIR, LEGACY_DIR]) fs.mkdirSync(d, { recursive: true });

  // Top-level data/*.json only (subdirs worlds/ players/ legacy/ are skipped — they're
  // not files). Oldest-first so the newest room's name wins the merge.
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => { const f = path.join(DATA_DIR, e.name); return { name: e.name, f, mtime: Math.floor(fs.statSync(f).mtimeMs) }; })
    .sort((a, b) => a.mtime - b.mtime);

  if (!entries.length) { console.log("[migrate] nothing to migrate (no top-level data/*.json) — already done?"); return; }

  let worldsW = 0, skipped = 0; const players = new Set();
  for (const { name, f, mtime } of entries) {
    const d = readJSON(f);
    const roomId = name.replace(/\.json$/, "");
    if (!d || (!d.players && !d.members)) { console.warn(`[migrate] skip ${name} (unrecognized shape)`); skipped++; continue; }

    const members = {};
    if (d.members && typeof d.members === "object") {
      Object.assign(members, d.members); // already-new shape sitting at top level → just relocate it
    } else {
      for (const pid in d.players) {
        const pl = d.players[pid] || {};
        members[pid] = { color: pl.color || "amber", ticks: pl.ticks | 0, contributionTicks: 0, joinedAt: 0 };
        // merge into the global profile (create or update)
        const pf = path.join(PLAYERS_DIR, safe(pid) + ".json");
        const prof = readJSON(pf) || freshProfile(pid);
        prof.id = pid;
        if (!prof.skills || typeof prof.skills !== "object") prof.skills = {};
        if (!prof.lifetime || typeof prof.lifetime !== "object") prof.lifetime = { ticks: 0 };
        if (!Array.isArray(prof.worlds)) prof.worlds = [];
        if (pl.name) prof.name = String(pl.name);                 // oldest-first ⇒ newest wins
        if (!prof.worlds.includes(roomId)) prof.worlds.push(roomId);
        prof.lifetime.ticks = Math.max(prof.lifetime.ticks | 0, pl.ticks | 0);
        prof.lastSeen = Math.max(prof.lastSeen || 0, mtime);
        fs.writeFileSync(pf, JSON.stringify(prof));
        players.add(pid);
      }
    }

    const world = { id: roomId, createdAt: d.createdAt || mtime, members, grid: d.grid || "", bands: Array.isArray(d.bands) ? d.bands : [] };
    fs.writeFileSync(path.join(WORLDS_DIR, safe(roomId) + ".json"), JSON.stringify(world));
    worldsW++;

    fs.renameSync(f, path.join(LEGACY_DIR, name)); // back up the original (never deleted)
  }
  console.log(`[migrate] done: ${worldsW} world(s), ${players.size} player profile(s), ${skipped} skipped. Originals → ${LEGACY_DIR}`);
}
main();
