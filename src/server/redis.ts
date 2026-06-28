import Redis from 'ioredis'
import type { Peer, PresenceMeta, RoomChange } from '../protocol'

const channel = (room: string) => `presence:room:${room}`
const CHANNEL_PREFIX = 'presence:room:'

const metaKey = (room: string, id: string) => `presence:meta:${room}:${id}`
const metaPrefix = (room: string) => `presence:meta:${room}:`

interface Envelope {
  from: string
  change: RoomChange
}

export class RedisFanout {
  readonly instanceId = crypto.randomUUID()
  private readonly pub: Redis
  private readonly sub: Redis
  private handler: ((room: string, change: RoomChange) => void) | null = null

  // Redis requires a dedicated connection for subscribe mode, hence two clients.
  constructor(url: string) {
    this.pub = new Redis(url)
    this.sub = new Redis(url)
    void this.sub.psubscribe(`${CHANNEL_PREFIX}*`)
    this.sub.on('pmessage', (_pattern, ch, raw) => {
      const env = JSON.parse(raw) as Envelope
      if (env.from === this.instanceId) return // our own echo; local clients already got it
      this.handler?.(ch.slice(CHANNEL_PREFIX.length), env.change)
    })
  }

  publish(room: string, change: RoomChange): void {
    const env: Envelope = { from: this.instanceId, change }
    void this.pub.publish(channel(room), JSON.stringify(env))
  }

  onRemote(handler: (room: string, change: RoomChange) => void): void {
    this.handler = handler
  }

  // Each presence entry is mirrored to a TTL key so a joiner on any instance can
  // read the cross-instance roster directly, instead of waiting for live diffs.
  // These writes are best-effort: callers fire them without awaiting, and the TTL
  // means a dropped write self-heals — so a closed connection during shutdown must
  // not surface as an unhandled rejection.
  async writePresence(room: string, id: string, meta: PresenceMeta, ttlMs: number): Promise<void> {
    await this.bestEffort(this.pub.set(metaKey(room, id), JSON.stringify(meta), 'PX', ttlMs))
  }

  async refresh(room: string, id: string, ttlMs: number): Promise<void> {
    await this.bestEffort(this.pub.pexpire(metaKey(room, id), ttlMs))
  }

  async removePresence(room: string, id: string): Promise<void> {
    await this.bestEffort(this.pub.del(metaKey(room, id)))
  }

  private async bestEffort(op: Promise<unknown>): Promise<void> {
    try {
      await op
    } catch {
      // connection closed / transient error — the TTL key self-heals
    }
  }

  // The ids whose TTL keys still exist — Redis's truth about who's present. The
  // reconcile loop diffs this against what each instance believes to evict ghosts
  // left behind by a crashed instance that never published `left`.
  async liveIds(room: string): Promise<Set<string>> {
    const peers = await this.remoteSnapshot(room, '')
    return new Set(peers.map((p) => p.id))
  }

  async remoteSnapshot(room: string, excludeId: string): Promise<Peer[]> {
    const prefix = metaPrefix(room)
    const peers: Peer[] = []
    let cursor = '0'
    do {
      const [next, keys] = await this.pub.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
      cursor = next
      if (keys.length === 0) continue
      const values = await this.pub.mget(keys)
      keys.forEach((key, i) => {
        const id = key.slice(prefix.length)
        const raw = values[i]
        // A key may expire between SCAN and MGET (raw === null); skip it.
        if (id === excludeId || raw == null) return
        try {
          peers.push({ id, meta: JSON.parse(raw) as PresenceMeta })
        } catch {
          // corrupt value — ignore rather than crash the snapshot
        }
      })
    } while (cursor !== '0')
    return peers
  }

  async close(): Promise<void> {
    this.pub.disconnect()
    this.sub.disconnect()
  }
}
