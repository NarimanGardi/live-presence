import { describe, it, expect } from 'vitest'
import { Room } from '../src/server/room'

describe('Room', () => {
  it('join adds a peer and reports it joined', () => {
    const room = new Room()
    expect(room.join('a', { name: 'A' }, 1000)).toEqual({
      joined: [{ id: 'a', meta: { name: 'A' } }],
    })
    expect(room.size).toBe(1)
  })

  it('a re-join of an existing id is reported as an update, not a duplicate join', () => {
    const room = new Room()
    room.join('a', { name: 'A' }, 1000)
    expect(room.join('a', { name: 'A2' }, 1100)).toEqual({
      updated: [{ id: 'a', meta: { name: 'A2' } }],
    })
    expect(room.size).toBe(1)
  })

  it('update of a known peer reports updated', () => {
    const room = new Room()
    room.join('a', { name: 'A' }, 1000)
    expect(room.update('a', { name: 'A', x: 5 }, 1100)).toEqual({
      updated: [{ id: 'a', meta: { name: 'A', x: 5 } }],
    })
  })

  it('update of an unknown peer is a no-op', () => {
    expect(new Room().update('ghost', { name: 'X' }, 1000)).toEqual({})
  })

  it('leave reports the id left', () => {
    const room = new Room()
    room.join('a', { name: 'A' }, 1000)
    expect(room.leave('a')).toEqual({ left: ['a'] })
    expect(room.size).toBe(0)
  })

  it('leave of an unknown id is a no-op', () => {
    expect(new Room().leave('ghost')).toEqual({})
  })

  it('pruneStale removes peers past the timeout and reports them left', () => {
    const room = new Room()
    room.join('a', { name: 'A' }, 1000)
    room.join('b', { name: 'B' }, 1000)
    room.touch('b', 5000)
    expect(room.pruneStale(5100, 1000)).toEqual({ left: ['a'] })
    expect(room.has('a')).toBe(false)
    expect(room.has('b')).toBe(true)
  })

  it('snapshot returns all current peers', () => {
    const room = new Room()
    room.join('a', { name: 'A' }, 1000)
    room.join('b', { name: 'B' }, 1000)
    expect(room.snapshot()).toEqual([
      { id: 'a', meta: { name: 'A' } },
      { id: 'b', meta: { name: 'B' } },
    ])
  })
})
