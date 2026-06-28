// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket as WsWebSocket } from 'ws'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { createPresenceServer, type PresenceServer } from '../src/server/index'
import { PresenceClient } from '../src/react/client'
import { usePresence } from '../src/react/use-presence'

;(globalThis as { WebSocket?: unknown }).WebSocket = WsWebSocket

let http: Server
let presence: PresenceServer
let other: PresenceClient<{ name: string }> | null = null
let url: string

afterEach(async () => {
  // Unmount the hook (closing its socket) and the second peer before the
  // server closes — ws's wss.close() waits for every live connection.
  cleanup()
  other?.close()
  other = null
  await presence?.close()
  await new Promise<void>((r) => http?.close(() => r()))
})

async function start() {
  http = createServer()
  presence = createPresenceServer({ server: http, heartbeatInterval: 200, batchWindow: 15 })
  await new Promise<void>((r) => http.listen(0, r))
  url = `ws://localhost:${(http.address() as AddressInfo).port}/presence/lobby`
}

describe('usePresence', () => {
  it('reports connected and exposes other peers', async () => {
    await start()
    other = new PresenceClient<{ name: string }>({ url, initial: { name: 'Other' } })

    const { result } = renderHook(() =>
      usePresence<{ name: string }>({ url, initial: { name: 'Me' } }),
    )

    await waitFor(() => expect(result.current.connected).toBe(true))
    await waitFor(() => expect(result.current.others.map((p) => p.meta.name)).toContain('Other'))
    expect(result.current.self).toEqual({ name: 'Me' })
  })
})
