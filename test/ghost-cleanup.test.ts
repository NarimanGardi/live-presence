import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket as WsWebSocket } from 'ws'
import { createPresenceServer, type PresenceServer } from '../src/server/index'
import { PresenceClient } from '../src/react/client'
import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
;(globalThis as { WebSocket?: unknown }).WebSocket = WsWebSocket

async function redisAvailable(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await r.connect()
    await r.ping()
    return true
  } catch {
    return false
  } finally {
    r.disconnect()
  }
}

const instances: PresenceServer[] = []
const servers: Server[] = []
const clients: Redis[] = []
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

afterEach(async () => {
  await Promise.all(instances.splice(0).map((i) => i.close()))
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  clients.splice(0).forEach((c) => c.disconnect())
})

async function startInstance(room: string): Promise<string> {
  const http = createServer()
  servers.push(http)
  // Short heartbeat so ttl (3x = 360ms) and the reconcile tick (120ms) are fast.
  instances.push(
    createPresenceServer({
      server: http,
      heartbeatInterval: 120,
      batchWindow: 15,
      redis: { url: REDIS_URL },
    }),
  )
  await new Promise<void>((r) => http.listen(0, r))
  return `ws://localhost:${(http.address() as AddressInfo).port}/presence/${room}`
}

describe.skipIf(!(await redisAvailable()))('ghost cleanup', () => {
  it('drops a peer whose instance crashed and stopped refreshing its TTL key', async () => {
    // Unique room per test: these files share one Redis, so a fixed room name
    // would let their keys and pub/sub channels collide across parallel runs.
    const room = `lobby-${crypto.randomUUID()}`
    const url1 = await startInstance(room)
    const a = new PresenceClient({ url: url1, initial: { name: 'A' } })
    await wait(120)

    // Simulate a SECOND instance that hosts peer B and then hard-crashes. A clean
    // close would publish `left` + delete B's key, exercising the normal leave path
    // instead of reconcile — so we forge the crash directly against Redis:
    //   (1) publish B's `joined` envelope from a foreign instanceId, so instance 1's
    //       onRemote learns B and records it in remoteIds (the only path that can),
    //   (2) write B's presence key with a SHORT ttl and never refresh it,
    //   (3) never publish `left` — B's key just expires, as a dead instance leaves it.
    const raw = new Redis(REDIS_URL)
    clients.push(raw)
    const foreignInstance = crypto.randomUUID()
    const bMeta = { name: 'B' }
    await raw.set(`presence:meta:${room}:B`, JSON.stringify(bMeta), 'PX', 360)
    await raw.publish(
      `presence:room:${room}`,
      JSON.stringify({ from: foreignInstance, change: { joined: [{ id: 'B', meta: bMeta }] } }),
    )

    await wait(80)
    // Instance 1 forwarded the forged diff to A, so A sees B before the key expires.
    expect(a.getState().others.map((p) => p.meta.name)).toContain('B')

    // No `left` is ever published. After B's key TTL (360ms) lapses and one reconcile
    // tick (120ms) runs, the reconcile loop — comparing remoteIds against Redis truth —
    // must broadcast `left: ['B']` to A. Without that loop, A keeps seeing B forever.
    await wait(700)
    expect(a.getState().others.map((p) => p.meta.name)).not.toContain('B')

    a.close()
  })
})
