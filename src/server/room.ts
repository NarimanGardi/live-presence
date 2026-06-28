import type { Peer, PresenceMeta, RoomChange } from '../protocol'

interface Entry {
  meta: PresenceMeta
  lastSeen: number
}

export class Room {
  private readonly peers = new Map<string, Entry>()

  get size(): number {
    return this.peers.size
  }

  has(id: string): boolean {
    return this.peers.has(id)
  }

  // A re-join of a live id is a meta refresh (a reconnect during a blip),
  // not a second join — otherwise peers would see a duplicate.
  join(id: string, meta: PresenceMeta, now: number): RoomChange {
    const existed = this.peers.has(id)
    this.peers.set(id, { meta, lastSeen: now })
    const peer: Peer = { id, meta }
    return existed ? { updated: [peer] } : { joined: [peer] }
  }

  update(id: string, meta: PresenceMeta, now: number): RoomChange {
    const entry = this.peers.get(id)
    if (!entry) return {}
    entry.meta = meta
    entry.lastSeen = now
    return { updated: [{ id, meta }] }
  }

  leave(id: string): RoomChange {
    return this.peers.delete(id) ? { left: [id] } : {}
  }

  touch(id: string, now: number): void {
    const entry = this.peers.get(id)
    if (entry) entry.lastSeen = now
  }

  pruneStale(now: number, timeout: number): RoomChange {
    const left: string[] = []
    for (const [id, entry] of this.peers) {
      if (now - entry.lastSeen > timeout) {
        this.peers.delete(id)
        left.push(id)
      }
    }
    return left.length ? { left } : {}
  }

  snapshot(): Peer[] {
    return [...this.peers].map(([id, entry]) => ({ id, meta: entry.meta }))
  }
}
