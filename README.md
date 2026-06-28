# live-presence

Self-hostable real-time presence: who's in a room and what they're doing, right now. A small WebSocket server you attach to your own `http.Server`, plus a React hook. No accounts, no SaaS, no message bus — you bring the server.

```tsx
import { usePresence } from 'live-presence/react'

function Lobby() {
  const { self, others, setPresence, connected } = usePresence({
    url: 'ws://localhost:3001/presence/lobby',
    initial: { name: 'Ada', cursor: null as { x: number; y: number } | null },
  })

  return (
    <div onPointerMove={(e) => setPresence({ cursor: { x: e.clientX, y: e.clientY } })}>
      {connected ? `${others.length + 1} here` : 'connecting…'}
      {others.map((p) => (
        <Cursor key={p.id} at={p.meta.cursor} name={p.meta.name} />
      ))}
    </div>
  )
}
```

On the server you attach to an existing HTTP server. The room is the path after `/presence/`:

```ts
import { createServer } from 'node:http'
import { createPresenceServer } from 'live-presence'

const http = createServer()
const presence = createPresenceServer({ server: http })
http.listen(3001)
// later: await presence.close()
```

That's the whole surface: `createPresenceServer` on the back end, `usePresence` on the front end.

## Why this exists

I built and ran the real-time pipeline behind [Torliga](https://torliga.com) — live football scores and a live viewer count next to each match. During a big game the room is loud: thousands of people join in a minute, the score and minute tick constantly, and the viewer count is changing the whole time.

The first version did the obvious thing: broadcast every event to everyone. It worked in testing and fell over on the first real match. The problem isn't the steady state, it's the churn — a goal goes in, half the room reacts at once, everyone's client sends something, and you fan all of that back out to everyone. The naive loop turns N clients into N² messages right when you can least afford it.

What actually kept it standing was unglamorous: throttle what each client sends, batch the diffs the server fans out over a short window instead of one message per change, hang up on connections that stopped answering, and let presence expire on its own instead of trusting a clean disconnect that often never comes. None of that is novel. It's just the set of mechanics you end up with once "broadcast everything" has burned you.

`live-presence` is those mechanics pulled out into a library you can read end to end in a sitting. It is deliberately not a Liveblocks or an Ably — it's the opposite. Those hide this machinery behind a hosted product; this is the same machinery made legible and self-hostable, so you can see what presence actually costs and run it yourself.

## Install and run the demo

```
npm install live-presence
```

`react` is an optional peer dependency — only the `live-presence/react` entry needs it; the server runs without React.

Attach the server to an HTTP server, point the hook at it, and you have presence. To see it working, the repo ships a live-cursors demo (cursor trails, a head-count, and avatars) that starts with one command:

```
npm run demo
```

That runs the presence server and the example client together. Open two browser tabs at the printed URL and move your mouse — each tab sees the other's cursor, name, and color, and the head-count tracks tabs opening and closing.

## How it works

**Connection lifecycle.** A client opens a WebSocket to `…/presence/<room>` and sends a `join` with a `clientId` it generates and a `meta` object (whatever presence payload you want — a name, a color, a cursor). The server replies with a one-time `snapshot` of everyone already in the room, then streams `diff` messages (`joined` / `updated` / `left`) as things change. The client keeps a local map of peers and applies diffs to it. When the socket closes — tab closed, network dropped, server hung up on it — the server emits a `left` for that client.

**Heartbeat, at the application level.** The server sends a JSON `{"type":"ping"}` to every client on an interval; the client answers with `{"type":"pong"}`. A client that misses pongs for long enough gets pruned and terminated, and a `left` goes out for it. This is a JSON ping/pong in the protocol, *not* a WebSocket protocol-level ping frame, and that's deliberate: a browser's `WebSocket` API gives JavaScript no way to send a ping frame or observe a pong, so a protocol-frame heartbeat is invisible to the client half of the system. An app-level ping is the only heartbeat both ends can actually see — and it's trivial to drive in a test.

**Ephemeral state and diffs.** Presence is per-connection and lives in memory; there is no history and nothing to persist. A fresh joiner gets a full snapshot once, and everything after that is a diff. Sending snapshots on every change is what melts under churn — the diff stream is the point.

**Backpressure in two places.** The client throttles outbound updates (trailing-edge, so the last cursor position always lands even while you're spamming moves). The server collects diffs over a short batch window and fans out one message per window instead of one per change. Both exist because the failure mode is a burst, not a steady trickle: the throttle caps any single client, the batch window caps the room.

**Across instances.** One process is just an in-memory map. To run more than one instance behind a load balancer and have them share a room, pass a `redis` URL. Then:

- Each batched diff is **published** to a Redis pub/sub channel for the room; every instance relays diffs it receives to its own local sockets. That's the liveness path — fast, fire-and-forget.
- Each client also gets a **per-client key with a TTL** that its pongs refresh. That's the source of truth for who's actually present, independent of any single instance staying up.
- A periodic **reconcile** diffs what an instance believes is present against the keys still alive in Redis, and emits `left` for the ones that vanished. That's the ghost-cleanup path: if a whole instance crashes it never sends `left` for its clients, but their keys expire on their own, and reconcile turns that expiry into the `left` everyone else was waiting for.

```
   tab A ──ws──┐                          ┌──ws── tab C
   tab B ──ws──┤                          │
              ┌─────────────┐      ┌─────────────┐
              │ instance 1  │      │ instance 2  │
              └──────┬──────┘      └──────┬──────┘
                     │   publish/subscribe │     (diffs)
                     │   TTL keys + reconcile     (truth)
                     └──────────┬──────────┘
                           ┌────────┐
                           │  Redis │
                           └────────┘
```

With no `redis` option the publish/subscribe and reconcile paths are simply never created — a single instance pays nothing for the multi-instance machinery.

## Design decisions

**The client owns its identity.** The `clientId` is generated on the client (`crypto.randomUUID()`), not assigned by the server. So when a connection blips and the client reconnects, it re-`join`s under the same id and re-attaches as the same person rather than showing up as a stranger. The cost is that you trust the client's id; for presence that's fine — see *Limitations* on auth.

**Reconcile instead of Redis keyspace notifications.** Redis can fire an event when a key expires, which would be a tidier way to learn a ghost has died. I chose a periodic reconcile loop instead, because keyspace notifications are off by default and many managed Redis providers don't let you turn them on. Polling the surviving keys works everywhere a plain Redis does, which matters more here than elegance.

**Throttle and batch windows are small on purpose.** The client throttle defaults to 50ms (so a client tops out around 20 updates/sec) and the server batch window defaults to 50ms. Small enough that presence still feels live, large enough that a burst collapses into a few messages instead of a storm. Both are options if your room behaves differently.

**The connection is created once per `url`.** The React hook spins up its client the first time it sees a `url` and tears it down when the `url` changes or the component unmounts. Changing the *other* options (`initial`, `throttleMs`, `maxBackoffMs`) after mount has no effect — they're read when the client is constructed. Reconnecting on every render would thrash the socket, so the `url` is the only dependency that rebuilds it. Set those options once.

## Limitations / not handled

This is a presence primitive, not a real-time platform. On purpose, it does not do:

- **General pub/sub messaging.** It moves presence diffs, not your application's chat or events. If you need a message bus, this isn't one.
- **Auth / authz.** There is none built in, by design. Bring your own and terminate it at the HTTP upgrade — gate the WebSocket handshake on your existing session before the connection is established. Anyone who can open the socket can claim any `clientId` and any `meta`.
- **Persistence or history.** Presence is in-memory and ephemeral. When everyone leaves, the room is gone; there is no "who was here yesterday".
- **CRDTs or conflict resolution.** `meta` is last-write-wins per client. There is no shared editable document and no merge. For collaborative state that needs real conflict resolution, use [Yjs](https://github.com/yjs/yjs) or [Liveblocks](https://liveblocks.io); this can sit alongside one of them for the "who's here" layer.
- **Strong consistency across instances.** Multi-instance presence is best-effort and eventually consistent. If an instance crashes, its peers linger in other instances' rooms until their TTL expires and the next reconcile sweeps them — up to roughly the heartbeat window, not instant.
- **A second source of truth.** With multiple instances, Redis is a shared dependency. If it's down, instances stop sharing rooms (each still works on its own).

## Where it fits

If you need production multiplayer with stored state and conflict resolution, reach for a real platform — that's not what this is. The honest map:

- **[Pusher](https://pusher.com)** (presence channels) and **[Ably](https://ably.com)** — hosted real-time messaging with presence built in.
- **[Liveblocks](https://liveblocks.io)** — presence *and* synced storage for multiplayer UIs; the closest thing to "presence + the document".
- **[Supabase Realtime](https://supabase.com/realtime)** — presence and broadcast on top of Postgres.
- **[Soketi](https://soketi.app)** and **[Laravel Reverb](https://reverb.laravel.com)** — self-hosted servers that speak the Pusher protocol, if you want self-hosting with an existing client ecosystem.
- **[PartyKit](https://www.partykit.io)** — rooms as edge-deployed stateful objects.
- **[Yjs `awareness`](https://docs.yjs.dev/api/about-awareness)** — presence as part of a CRDT stack.

`live-presence` is the small, readable, self-hostable end of that spectrum: a presence primitive you can own and understand, not a competitor to any of the above. The design also maps cleanly onto Cloudflare Durable Objects — one object per room as the authority, no Redis needed — though that deployment isn't built here.

## API reference

### `createPresenceServer(options)`

Attaches a `WebSocketServer` to your HTTP server and returns a `{ close(): Promise<void> }` handle.

- **`server`** (required) — the Node `http.Server` (or `https.Server`) to attach to.
- **`path`** — URL prefix the room name follows. Default `'/presence'`, so a client connects to `…/presence/<room>`.
- **`heartbeatInterval`** — milliseconds between server pings, and the cadence of the prune and reconcile loops. Default `15000`. A client is pruned after missing roughly two intervals; the Redis TTL is three.
- **`batchWindow`** — milliseconds the server collects diffs before fanning out one message. Default `50`.
- **`redis`** — `{ url }` to enable cross-instance fan-out. Omit it for a single-instance, in-memory server.

```ts
const presence = createPresenceServer({
  server: http,
  path: '/presence',
  heartbeatInterval: 15_000,
  batchWindow: 50,
  redis: { url: 'redis://localhost:6379' },
})
await presence.close()
```

### `usePresence(options)` (from `live-presence/react`)

Connects to a room and returns the live presence state.

- **`url`** (required) — the full WebSocket URL including the room, e.g. `ws://host/presence/lobby`. This is the only option that, when changed, rebuilds the connection.
- **`initial`** (required) — your starting `meta`. Its type parameterizes the hook, so `self` and `others[].meta` are typed to match.
- **`throttleMs`** — minimum gap between outbound updates (trailing-edge). Default `50`.
- **`maxBackoffMs`** — ceiling on reconnect backoff, which grows from 100ms by doubling. Default `5000`.

Returns:

- **`self`** — your current `meta` (updates synchronously as you call `setPresence`).
- **`others`** — the other peers in the room, each `{ id, meta }`. Never includes you.
- **`setPresence(patch)`** — shallow-merge a patch into your `meta`; reflected locally at once and sent (throttled) to the room.
- **`connected`** — whether the socket is currently open.

```tsx
const { self, others, setPresence, connected } = usePresence<{ name: string }>({
  url: 'ws://localhost:3001/presence/lobby',
  initial: { name: 'Ada' },
  throttleMs: 50,
  maxBackoffMs: 5000,
})
```

### Protocol

The wire format is small JSON messages, useful if you want a non-React or non-browser client. Client to server: `{ type: 'join', clientId, meta }`, `{ type: 'update', meta }`, `{ type: 'pong' }`. Server to client: `{ type: 'snapshot', peers }`, `{ type: 'diff', joined?, updated?, left? }`, `{ type: 'ping' }`. A `Peer` is `{ id, meta }`; `meta` is any JSON object. Malformed messages are dropped rather than killing the connection.

## License

MIT
