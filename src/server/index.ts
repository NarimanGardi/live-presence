import type { Server as HttpServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { encode, parseClientMessage, ProtocolError, type RoomChange } from '../protocol'
import { Room } from './room'
import { DiffBatcher } from './batcher'
import { RedisFanout } from './redis'

export interface PresenceServerOptions {
  server: HttpServer
  path?: string
  heartbeatInterval?: number
  batchWindow?: number
  redis?: { url: string }
}

export interface PresenceServer {
  close(): Promise<void>
}

interface Connection {
  clientId: string
  room: string
  socket: WebSocket
}

interface RoomState {
  room: Room
  batcher: DiffBatcher
  sockets: Map<string, WebSocket>
  // Peers we learned about purely through remote fan-out diffs (hosted on other
  // instances). Reconcile uses these — they have no local socket and no Room entry,
  // so a crashed instance's TTL expiry is the only signal they've gone.
  remoteIds: Set<string>
}

export function createPresenceServer(opts: PresenceServerOptions): PresenceServer {
  const path = opts.path ?? '/presence'
  const heartbeatInterval = opts.heartbeatInterval ?? 15_000
  const batchWindow = opts.batchWindow ?? 50
  const ttl = heartbeatInterval * 3

  const rooms = new Map<string, RoomState>()
  const wss = new WebSocketServer({ server: opts.server })
  const fanout = opts.redis ? new RedisFanout(opts.redis.url) : null

  function broadcastLocal(name: string, diff: RoomChange) {
    const state = rooms.get(name)
    if (!state) return
    const payload = encode({ type: 'diff', ...diff })
    for (const socket of state.sockets.values()) socket.send(payload)
  }

  function roomState(name: string): RoomState {
    let state = rooms.get(name)
    if (!state) {
      const batcher = new DiffBatcher(batchWindow, (diff) => {
        broadcastLocal(name, diff)
        fanout?.publish(name, diff)
      })
      state = {
        room: new Room(),
        batcher,
        sockets: new Map<string, WebSocket>(),
        remoteIds: new Set<string>(),
      }
      rooms.set(name, state)
    }
    return state
  }

  // Diffs from other instances reach our local sockets only. We don't add them
  // to the local Room or re-publish them — remote clients hear it from their own
  // instance. We do track which remote peers exist (remoteIds) so reconcile can
  // notice when a crashed instance's peers vanish from Redis without a `left`.
  fanout?.onRemote((name, diff) => {
    const state = roomState(name)
    for (const p of diff.joined ?? []) state.remoteIds.add(p.id)
    for (const p of diff.updated ?? []) state.remoteIds.add(p.id)
    for (const id of diff.left ?? []) state.remoteIds.delete(id)
    broadcastLocal(name, diff)
  })

  function roomFromUrl(url: string | undefined): string | null {
    if (!url) return null
    const { pathname } = new URL(url, 'http://localhost')
    if (!pathname.startsWith(path + '/')) return null
    const room = pathname.slice(path.length + 1)
    return room.length ? decodeURIComponent(room) : null
  }

  wss.on('connection', (socket, req) => {
    const room = roomFromUrl(req.url)
    if (!room) {
      socket.close(1008, 'missing room')
      return
    }
    const state = roomState(room)
    let conn: Connection | null = null

    const handle = async (msg: ReturnType<typeof parseClientMessage>) => {
      const now = Date.now()
      switch (msg.type) {
        case 'join': {
          conn = { clientId: msg.clientId, room, socket }
          state.sockets.set(msg.clientId, socket)
          void fanout?.writePresence(room, msg.clientId, msg.meta, ttl)
          // Read the cross-instance roster and send the snapshot BEFORE the local
          // join diff is batched, so the joiner never misses peers on other instances.
          // If the cross-instance read fails, fall back to this instance's own Room.
          const peers = fanout
            ? await fanout
                .remoteSnapshot(room, msg.clientId)
                .catch(() => state.room.snapshot().filter((p) => p.id !== msg.clientId))
            : state.room.snapshot().filter((p) => p.id !== msg.clientId)
          socket.send(encode({ type: 'snapshot', peers }))
          state.batcher.add(state.room.join(msg.clientId, msg.meta, now))
          break
        }
        case 'update':
          if (conn) {
            void fanout?.writePresence(room, conn.clientId, msg.meta, ttl)
            state.batcher.add(state.room.update(conn.clientId, msg.meta, now))
          }
          break
        case 'pong':
          if (conn) {
            state.room.touch(conn.clientId, now)
            void fanout?.refresh(room, conn.clientId, ttl)
          }
          break
      }
    }

    // Messages share a connection's state (conn, snapshot-before-join ordering), so
    // process them strictly in arrival order even though `join` is now async.
    let queue: Promise<void> = Promise.resolve()
    socket.on('message', (raw) => {
      let msg
      try {
        msg = parseClientMessage(raw.toString())
      } catch (err) {
        if (err instanceof ProtocolError) return // ignore garbage, don't crash
        throw err
      }
      // A dead/closing socket can make a synchronous send throw mid-handle. Catch per
      // link so one rejection doesn't poison the rest of this connection's queue (a
      // rejected chain would silently drop every later message + raise an unhandled
      // rejection). The only expected error here is send-after-close on a gone socket.
      queue = queue.then(() => handle(msg)).catch(() => {})
    })

    // If the socket closes before its queued `join` runs, conn is still null here, so
    // drop skips removePresence and the later-running join leaves a presence key behind.
    // That's intentional: TTL reclaims it, same self-heal as an instance crash.
    const drop = () => {
      if (!conn) return
      state.sockets.delete(conn.clientId)
      void fanout?.removePresence(room, conn.clientId)
      state.batcher.add(state.room.leave(conn.clientId))
      conn = null
    }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  // One heartbeat + prune loop for all rooms.
  const beat = setInterval(() => {
    const now = Date.now()
    const ping = encode({ type: 'ping' })
    for (const [name, state] of rooms) {
      const stale: RoomChange = state.room.pruneStale(now, heartbeatInterval * 2)
      for (const id of stale.left ?? []) {
        state.sockets.get(id)?.terminate()
        state.sockets.delete(id)
        void fanout?.removePresence(name, id)
      }
      if (stale.left?.length) state.batcher.add(stale)
      for (const socket of state.sockets.values()) socket.send(ping)
    }
  }, heartbeatInterval)
  beat.unref?.()

  // Ghost cleanup: when a whole instance crashes it never publishes `left` for its
  // clients, but their presence keys carry a TTL and expire on their own. We turn
  // that expiry into `left` events by periodically diffing what we believe is
  // present against Redis's surviving keys, rather than relying on keyspace
  // notifications (which many managed Redis providers disable). Local sockets are
  // never evicted here — the heartbeat/prune loop owns those.
  const reconcile = fanout
    ? setInterval(() => {
        void (async () => {
          for (const [name, state] of rooms) {
            const known = new Set<string>([...state.sockets.keys(), ...state.remoteIds])
            if (known.size === 0) continue
            const live = await fanout.liveIds(name)
            const gone = [...known].filter((id) => !live.has(id) && !state.sockets.has(id))
            if (gone.length === 0) continue
            for (const id of gone) state.remoteIds.delete(id)
            broadcastLocal(name, { left: gone })
          }
          // A read racing a closing connection (shutdown) rejects; ignore and let
          // the next tick resync — never crash the process on a transient Redis blip.
        })().catch(() => {})
      }, heartbeatInterval)
    : null
  reconcile?.unref?.()

  return {
    async close() {
      clearInterval(beat)
      if (reconcile) clearInterval(reconcile)
      for (const state of rooms.values()) state.batcher.dispose()
      await fanout?.close()
      await new Promise<void>((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}
