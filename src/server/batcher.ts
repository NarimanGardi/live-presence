import type { Peer, RoomChange } from '../protocol'

type Pending = 'joined' | 'updated'

// Coalesces a stream of RoomChanges into one diff per window. Per id we keep at
// most one outcome: a pending join/update carries the latest meta; a leave
// supersedes a pending update but cancels a pending join (the peer came and went
// within the window, so no one needs to hear about it).
export class DiffBatcher {
  private readonly joinedOrUpdated = new Map<string, { kind: Pending; meta: Peer['meta'] }>()
  private readonly left = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly windowMs: number,
    private readonly flush: (diff: RoomChange) => void,
  ) {}

  add(change: RoomChange): void {
    for (const p of change.joined ?? []) {
      this.left.delete(p.id)
      this.joinedOrUpdated.set(p.id, { kind: 'joined', meta: p.meta })
    }
    for (const p of change.updated ?? []) {
      this.left.delete(p.id)
      const prev = this.joinedOrUpdated.get(p.id)
      this.joinedOrUpdated.set(p.id, { kind: prev?.kind ?? 'updated', meta: p.meta })
    }
    for (const id of change.left ?? []) {
      const prev = this.joinedOrUpdated.get(id)
      this.joinedOrUpdated.delete(id)
      // A peer that joined and left within the window never needs broadcasting.
      if (prev?.kind !== 'joined') this.left.add(id)
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flushNow(), this.windowMs)
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const joined: Peer[] = []
    const updated: Peer[] = []
    for (const [id, { kind, meta }] of this.joinedOrUpdated) {
      const bucket = kind === 'joined' ? joined : updated
      bucket.push({ id, meta })
    }
    const diff: RoomChange = {}
    if (joined.length) diff.joined = joined
    if (updated.length) diff.updated = updated
    if (this.left.size) diff.left = [...this.left]
    this.joinedOrUpdated.clear()
    this.left.clear()
    if (diff.joined || diff.updated || diff.left) this.flush(diff)
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
