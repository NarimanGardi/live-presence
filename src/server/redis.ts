import Redis from 'ioredis'
import type { RoomChange } from '../protocol'

const channel = (room: string) => `presence:room:${room}`
const CHANNEL_PREFIX = 'presence:room:'

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

  async close(): Promise<void> {
    this.pub.disconnect()
    this.sub.disconnect()
  }
}
