import { encode, parseServerMessage } from '../protocol'
import type { Peer, PresenceMeta, RoomChange } from '../protocol'

export interface PresenceClientOptions<T extends PresenceMeta> {
  url: string
  initial: T
  throttleMs?: number
  maxBackoffMs?: number
}

export interface PresenceState<T extends PresenceMeta> {
  self: T
  others: Peer<T>[]
  connected: boolean
}

export class PresenceClient<T extends PresenceMeta> {
  private readonly clientId = crypto.randomUUID()
  private readonly throttleMs: number
  private readonly maxBackoffMs: number
  private socket: WebSocket | null = null
  private closed = false
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private self: T
  private readonly peers = new Map<string, T>()
  private connected = false

  private readonly listeners = new Set<(s: PresenceState<T>) => void>()
  private pendingSend: ReturnType<typeof setTimeout> | null = null
  private lastSentAt = 0

  constructor(private readonly opts: PresenceClientOptions<T>) {
    this.self = opts.initial
    this.throttleMs = opts.throttleMs ?? 50
    this.maxBackoffMs = opts.maxBackoffMs ?? 5000
    this.connect()
  }

  subscribe(fn: (s: PresenceState<T>) => void): () => void {
    this.listeners.add(fn)
    fn(this.getState())
    return () => {
      this.listeners.delete(fn)
    }
  }

  getState(): PresenceState<T> {
    return {
      self: this.self,
      others: [...this.peers].map(([id, meta]) => ({ id, meta })),
      connected: this.connected,
    }
  }

  setPresence(patch: Partial<T>): void {
    this.self = { ...this.self, ...patch }
    this.emit()
    this.scheduleSend()
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pendingSend) clearTimeout(this.pendingSend)
    this.socket?.close()
  }

  private connect(): void {
    const socket = new WebSocket(this.opts.url)
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      this.connected = true
      // Re-publish self on every (re)connect so a blip never loses our presence.
      socket.send(encode({ type: 'join', clientId: this.clientId, meta: this.self }))
      this.emit()
    }

    socket.onmessage = (ev) => {
      const msg = parseServerMessage(typeof ev.data === 'string' ? ev.data : String(ev.data))
      switch (msg.type) {
        case 'ping':
          socket.send(encode({ type: 'pong' }))
          break
        case 'snapshot':
          this.peers.clear()
          for (const p of msg.peers) {
            // Defensive: the server already excludes self from snapshots, but
            // `others` must never include us regardless of what arrives.
            if (p.id === this.clientId) continue
            this.peers.set(p.id, p.meta as T)
          }
          this.emit()
          break
        case 'diff':
          this.applyDiff(msg)
          this.emit()
          break
      }
    }

    socket.onclose = () => {
      this.connected = false
      this.socket = null
      this.emit()
      this.scheduleReconnect()
    }

    socket.onerror = () => socket.close()
  }

  private applyDiff(diff: RoomChange): void {
    // The server broadcasts every diff to all sockets in the room, including
    // ours, so it echoes our own join/updates back. Skip self everywhere —
    // `others` is genuine peers only.
    for (const p of diff.joined ?? []) {
      if (p.id === this.clientId) continue
      this.peers.set(p.id, p.meta as T)
    }
    for (const p of diff.updated ?? []) {
      if (p.id === this.clientId) continue
      this.peers.set(p.id, p.meta as T)
    }
    for (const id of diff.left ?? []) {
      if (id === this.clientId) continue
      this.peers.delete(id)
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = Math.min(this.maxBackoffMs, 100 * 2 ** this.attempts++)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  // Trailing-edge throttle: cursor spam never floods the wire, but the final
  // position always lands.
  private scheduleSend(): void {
    if (this.pendingSend) return
    const elapsed = Date.now() - this.lastSentAt
    const delay = Math.max(0, this.throttleMs - elapsed)
    this.pendingSend = setTimeout(() => {
      this.pendingSend = null
      this.flushSend()
    }, delay)
  }

  private flushSend(): void {
    this.lastSentAt = Date.now()
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encode({ type: 'update', meta: this.self }))
    }
  }

  private emit(): void {
    const state = this.getState()
    for (const fn of this.listeners) fn(state)
  }
}
