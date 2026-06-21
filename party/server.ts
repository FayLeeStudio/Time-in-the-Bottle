// Time in the Bottle — room backend (Stage 2, Phase A).
//
// History: originally planned on PartyKit's hosted cloud, but its shared domain
// `partykit.dev` hit Cloudflare's hard limit of 10,000 custom domains per zone,
// so new free deploys are blocked (2026-06). PartyKit is itself a thin wrapper
// over Cloudflare Durable Objects, so we run that directly: free, always-on, no
// custom domain needed (uses *.workers.dev). See Doc/backend.md, Doc/architecture.md.
//
// What the room does NOW (Phase A): relay each player's integer `ticks` (their
// cumulative keystroke count) AND keep a persistent room:
//   · players persist in DO storage — offline ≠ exit; reconnecting keeps your
//     identity, colour and last-known count. Only an explicit `leave` removes you.
//   · the server assigns each player an objective colour (amber/teal/violet/rose);
//     every client renders the same colour for the same player.
//   · max 4 players; a 5th NEW player is bounced with reason "room_full".
// It still never runs physics or understands the sand grid — it only stores and
// forwards integers (and, in Phase B, opaque frozen-band snapshots it never parses).
//
// Routing: wss://<host>/parties/main/<roomId>?_pk=<playerId>
//   · each roomId maps to one Durable Object instance (= one room),
//   · `_pk` is the client's PERSISTENT playerId (stored in localStorage and
//     reused across reconnects) — this is how the room tells "an old player came
//     back" from "a new player wants in".

export interface Env {
  // Binding kept as RACEROOM/RaceRoom to match the already-deployed worker; the
  // name is internal (players use room codes). See wrangler.toml for the why.
  RACEROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/parties\/main\/([^/]+)/);
    if (request.headers.get("Upgrade") === "websocket" && match) {
      const roomId = decodeURIComponent(match[1]);
      const stub = env.RACEROOM.get(env.RACEROOM.idFromName(roomId));
      return stub.fetch(request);
    }
    return new Response("Time in the Bottle room server (Cloudflare Durable Objects)", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

type PlayerState = { name: string; color: string; ticks: number };

// Objective identity colours, slot order 1..4. The client maps the same names to
// the same grid values / hues, so a snapshot means the same thing everywhere.
const ROOM_COLORS = ["amber", "teal", "violet", "rose"];
const ROOM_CAP = 4;

// One instance per roomId. Players + frozen bands live in DO storage (the DO can
// be evicted when idle, so in-memory fields are just a hot cache of storage).
export class RaceRoom {  // legacy class name, kept to match the live deployment
  players: Record<string, PlayerState> = {};
  frozenBands: unknown[] = [];           // append-only, opaque; Phase B fills this
  conns: Map<WebSocket, string> = new Map(); // socket -> playerId (routing only)
  state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Load storage before any fetch runs — storage is the source of truth.
    state.blockConcurrencyWhile(async () => {
      this.players = ((await state.storage.get("players")) as Record<string, PlayerState>) || {};
      this.frozenBands = ((await state.storage.get("frozenBands")) as unknown[]) || [];
    });
  }

  persist() {
    // Fire-and-forget; the DO output gate keeps writes ordered + consistent.
    this.state.storage.put("players", this.players);
    this.state.storage.put("frozenBands", this.frozenBands);
  }

  takeColor(): string {
    const used = new Set(Object.values(this.players).map((p) => p.color));
    for (const c of ROOM_COLORS) if (!used.has(c)) return c;
    return ROOM_COLORS[0]; // unreachable under the 4-cap
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const playerId = url.searchParams.get("_pk") || crypto.randomUUID();
    const isNew = !this.players[playerId];

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // Reject a 5th NEW player. We accept the socket first, then send the reason
    // and close — a browser WebSocket can't read an HTTP 403 body, so this is the
    // only way the client actually learns *why* it bounced. Returning players
    // (their playerId is already on file) are never blocked, even at 4.
    if (isNew && Object.keys(this.players).length >= ROOM_CAP) {
      server.send(JSON.stringify({ type: "error", reason: "room_full" }));
      server.close(4001, "room_full");
      return new Response(null, { status: 101, webSocket: client });
    }

    this.conns.set(server, playerId);

    // snapshot so the newcomer immediately sees everyone + the frozen history
    server.send(JSON.stringify({
      type: "state",
      players: this.players,
      frozenBands: this.frozenBands,
    }));

    server.addEventListener("message", (e: MessageEvent) => {
      this.onMessage(playerId, e.data);
    });
    const drop = () => this.onClose(server);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(id: string, raw: unknown) {
    let data: { type?: string; name?: string; ticks?: number; seq?: number; band?: string };
    try { data = JSON.parse(typeof raw === "string" ? raw : ""); } catch { return; }

    if (data.type === "join") {
      if (!this.players[id]) {
        // first time in this room → build a profile + assign an objective colour
        this.players[id] = { name: String(data.name ?? "Player"), color: this.takeColor(), ticks: 0 };
      } else if (data.name != null) {
        this.players[id].name = String(data.name); // returning player may rename
      }
      this.persist();
      this.broadcast(); // players only — newcomer already got frozenBands in its snapshot
    } else if (data.type === "progress" && this.players[id]) {
      // ticks live in memory during the session (the DO stays alive while any
      // socket is open); we persist on join/leave/disconnect, NOT on every 10fps
      // tick. A reconnecting client re-reports its true count anyway.
      this.players[id].ticks = Number(data.ticks) || 0;
      this.broadcast(); // players only — keep frozen history off the 10fps stream
    } else if (data.type === "freeze" && this.players[id]) {
      // Seq-guarded first-write-wins: accept a band only if its index is exactly
      // the next free slot. A loser's seq won't match (someone already took it),
      // so it's silently dropped — that client adopts the authoritative band from
      // the broadcast below. The band is opaque; the server never parses it.
      if (typeof data.seq === "number" && data.seq === this.frozenBands.length && typeof data.band === "string") {
        this.frozenBands.push(data.band);
        this.persist();
        this.broadcast(true); // include the now-longer authoritative history
      }
    } else if (data.type === "leave") {
      // explicit exit: free the slot + colour. (Just closing the app/window does
      // NOT come here — that's onClose, which keeps you on file.)
      if (this.players[id]) { delete this.players[id]; this.persist(); this.broadcast(); }
    } else {
      return; // unknown / invalid → no broadcast
    }
  }

  onClose(ws: WebSocket) {
    const id = this.conns.get(ws);
    this.conns.delete(ws);
    // Keep the player record (offline ≠ exit). Persist so the last-known ticks
    // survive a later DO eviction; everyone still sees them in the ranking.
    if (id && this.players[id]) this.persist();
  }

  // High-frequency updates (join/progress/leave) send players only; the frozen
  // history (large, rarely changes) rides along ONLY when it actually grew
  // (freeze) or for a newcomer's initial snapshot. Keeps the 10fps stream small.
  broadcast(withFrozen = false) {
    const payload: Record<string, unknown> = { type: "state", players: this.players };
    if (withFrozen) payload.frozenBands = this.frozenBands;
    const msg = JSON.stringify(payload);
    for (const ws of this.conns.keys()) {
      try { ws.send(msg); } catch { /* dead socket; its close handler cleans up */ }
    }
  }
}
