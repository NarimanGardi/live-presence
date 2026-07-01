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
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

afterEach(async () => {
  await Promise.all(instances.splice(0).map((i) => i.close()))
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

async function startInstance(room: string): Promise<string> {
  const http = createServer()
  servers.push(http)
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

describe.skipIf(!(await redisAvailable()))('redis fan-out', () => {
  it('clients on two instances see each other', async () => {
    // Unique room per test: these files share one Redis, so a fixed room name
    // would let their keys and pub/sub channels collide across parallel runs.
    const room = `lobby-${crypto.randomUUID()}`
    const url1 = await startInstance(room)
    const url2 = await startInstance(room)
    const a = new PresenceClient({ url: url1, initial: { name: 'A' } })
    const b = new PresenceClient({ url: url2, initial: { name: 'B' } })
    await wait(120)
    expect(a.getState().others.map((p) => p.meta.name)).toContain('B')
    expect(b.getState().others.map((p) => p.meta.name)).toContain('A')
    a.close()
    b.close()
  })
})
