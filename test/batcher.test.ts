import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DiffBatcher } from '../src/server/batcher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DiffBatcher', () => {
  it('coalesces multiple changes in a window into one flush', () => {
    const flush = vi.fn()
    const b = new DiffBatcher(50, flush)
    b.add({ joined: [{ id: 'a', meta: { name: 'A' } }] })
    b.add({ updated: [{ id: 'a', meta: { name: 'A', x: 1 } }] })
    b.add({ updated: [{ id: 'a', meta: { name: 'A', x: 2 } }] })
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    // join + later updates collapse to a single joined with the latest meta
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith({ joined: [{ id: 'a', meta: { name: 'A', x: 2 } }] })
  })

  it('join then leave in the same window cancels out (no flush)', () => {
    const flush = vi.fn()
    const b = new DiffBatcher(50, flush)
    b.add({ joined: [{ id: 'a', meta: { name: 'A' } }] })
    b.add({ left: ['a'] })
    vi.advanceTimersByTime(50)
    expect(flush).not.toHaveBeenCalled()
  })

  it('update then leave becomes a left', () => {
    const flush = vi.fn()
    const b = new DiffBatcher(50, flush)
    b.add({ updated: [{ id: 'a', meta: { name: 'A' } }] })
    b.add({ left: ['a'] })
    vi.advanceTimersByTime(50)
    expect(flush).toHaveBeenCalledWith({ left: ['a'] })
  })

  it('coalesces cursor spam to the latest position', () => {
    const flush = vi.fn()
    const b = new DiffBatcher(50, flush)
    for (let x = 0; x < 100; x++) b.add({ updated: [{ id: 'a', meta: { x } }] })
    vi.advanceTimersByTime(50)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith({ updated: [{ id: 'a', meta: { x: 99 } }] })
  })
})
