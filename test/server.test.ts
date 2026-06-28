import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { createPresenceServer, type PresenceServer } from '../src/server/index'
import { encode, parseServerMessage, type ServerMessage } from '../src/protocol'

let http: Server
let presence: PresenceServer

afterEach(async () => {
  await presence?.close()
  await new Promise<void>((r) => http?.close(() => r()))
})

async function start(opts: Partial<Parameters<typeof createPresenceServer>[0]> = {}) {
  http = createServer()
  presence = createPresenceServer({ server: http, heartbeatInterval: 80, batchWindow: 20, ...opts })
  await new Promise<void>((r) => http.listen(0, r))
  const port = (http.address() as AddressInfo).port
  return `ws://localhost:${port}/presence/lobby`
}

function open(url: string) {
  const ws = new WebSocket(url)
  const messages: ServerMessage[] = []
  ws.on('message', (raw) => messages.push(parseServerMessage(raw.toString())))
  return { ws, messages, ready: new Promise<void>((r) => ws.on('open', () => r())) }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('createPresenceServer', () => {
  it('sends a snapshot on join and a diff to others', async () => {
    const url = await start()
    const a = open(url)
    await a.ready
    a.ws.send(encode({ type: 'join', clientId: 'a', meta: { name: 'A' } }))
    // let a's join flush in its own batch window before b joins, so the diff a
    // receives is b's join alone rather than a coalesced {a, b}.
    await wait(40)

    const b = open(url)
    await b.ready
    b.ws.send(encode({ type: 'join', clientId: 'b', meta: { name: 'B' } }))
    await wait(60)

    // b's first message is its snapshot, which includes a
    const snap = b.messages.find((m) => m.type === 'snapshot')
    expect(snap).toEqual({ type: 'snapshot', peers: [{ id: 'a', meta: { name: 'A' } }] })
    // a receives a diff announcing b joined
    expect(a.messages).toContainEqual({ type: 'diff', joined: [{ id: 'b', meta: { name: 'B' } }] })
    a.ws.close()
    b.ws.close()
  })

  it('prunes a silent client (no pong) and broadcasts left', async () => {
    const url = await start()
    const a = open(url)
    await a.ready
    a.ws.send(encode({ type: 'join', clientId: 'a', meta: { name: 'A' } }))
    const b = open(url)
    await b.ready
    b.ws.send(encode({ type: 'join', clientId: 'b', meta: { name: 'B' } }))
    await wait(40)
    // a answers pings; b is muted by removing its ping handler and never ponging
    a.ws.on('message', (raw) => {
      if (parseServerMessage(raw.toString()).type === 'ping') a.ws.send(encode({ type: 'pong' }))
    })
    b.ws.removeAllListeners('message')
    await wait(300) // > heartbeatInterval * 2
    expect(a.messages).toContainEqual({ type: 'diff', left: ['b'] })
    a.ws.close()
    b.ws.close()
  })

  it('reaps a room once its last client leaves', async () => {
    const url = await start()
    const a = open(url)
    await a.ready
    a.ws.send(encode({ type: 'join', clientId: 'a', meta: { name: 'A' } }))
    await wait(40)
    expect(presence.roomCount()).toBe(1)

    a.ws.close()
    await wait(200) // past a prune+reap tick (heartbeatInterval 80)
    expect(presence.roomCount()).toBe(0)
  })
})
