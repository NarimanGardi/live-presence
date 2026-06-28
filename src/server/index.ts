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
      state = { room: new Room(), batcher, sockets: new Map<string, WebSocket>() }
      rooms.set(name, state)
    }
    return state
  }

  // Diffs from other instances reach our local sockets only. We don't add them
  // to the local Room or re-publish them — remote clients hear it from their own
  // instance. Cross-instance snapshot-on-join arrives in a later task.
  fanout?.onRemote((name, diff) => {
    roomState(name)
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
      queue = queue.then(() => handle(msg))
    })

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

  return {
    async close() {
      clearInterval(beat)
      for (const state of rooms.values()) state.batcher.dispose()
      await fanout?.close()
      await new Promise<void>((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}
