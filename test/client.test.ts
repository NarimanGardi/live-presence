import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket as WsWebSocket } from 'ws'
import { createPresenceServer, type PresenceServer } from '../src/server/index'
import { PresenceClient } from '../src/react/client'

// jsdom-free: run in node with ws as the global WebSocket the client uses.
beforeAll(() => {
  const g = globalThis as { WebSocket?: unknown }
  g.WebSocket = WsWebSocket
})

let http: Server
let presence: PresenceServer
let baseUrl: string

afterEach(async () => {
  await presence?.close()
  await new Promise<void>((r) => http?.close(() => r()))
})

async function start() {
  http = createServer()
  presence = createPresenceServer({ server: http, heartbeatInterval: 60, batchWindow: 15 })
  await new Promise<void>((r) => http.listen(0, r))
  baseUrl = `ws://localhost:${(http.address() as AddressInfo).port}/presence/lobby`
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('PresenceClient', () => {
  it('connects, joins, and sees other peers', async () => {
    await start()
    const a = new PresenceClient({ url: baseUrl, initial: { name: 'A' } })
    await wait(40)
    const b = new PresenceClient({ url: baseUrl, initial: { name: 'B' } })
    await wait(60)
    expect(a.getState().connected).toBe(true)
    expect(a.getState().others.map((p) => p.meta.name)).toContain('B')
    // self must never appear in `others` — the server echoes our own presence back.
    expect(a.getState().others.map((p) => p.meta.name)).not.toContain('A')
    expect(a.getState().others.length).toBe(1)
    a.close()
    b.close()
  })

  it('reconnects and re-syncs after the socket drops', async () => {
    await start()
    const a = new PresenceClient({ url: baseUrl, initial: { name: 'A' }, maxBackoffMs: 50 })
    const b = new PresenceClient({ url: baseUrl, initial: { name: 'B' } })
    await wait(60)
    expect(a.getState().others.length).toBe(1)

    // Force-close a's underlying socket; it should reconnect and re-sync.
    ;(a as unknown as { socket: WebSocket }).socket.close()
    await wait(150)
    expect(a.getState().connected).toBe(true)
    expect(a.getState().others.map((p) => p.meta.name)).toContain('B')
    a.close()
    b.close()
  })
})
