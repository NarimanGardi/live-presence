import { describe, it, expect } from 'vitest'
import {
  encode,
  parseClientMessage,
  parseServerMessage,
  ProtocolError,
  type ServerMessage,
} from '../src/protocol'

describe('protocol', () => {
  it('round-trips a join message', () => {
    const msg = { type: 'join', clientId: 'c1', meta: { name: 'Nariman' } } as const
    expect(parseClientMessage(encode(msg))).toEqual(msg)
  })

  it('round-trips a diff message', () => {
    const msg: ServerMessage = {
      type: 'diff',
      joined: [{ id: 'c1', meta: { name: 'A' } }],
      left: ['c2'],
    }
    expect(parseServerMessage(encode(msg))).toEqual(msg)
  })

  it('rejects non-JSON', () => {
    expect(() => parseClientMessage('not json')).toThrow(ProtocolError)
  })

  it('rejects an unknown client message type', () => {
    expect(() => parseClientMessage(JSON.stringify({ type: 'nope' }))).toThrow(ProtocolError)
  })

  it('rejects a join missing clientId', () => {
    expect(() => parseClientMessage(JSON.stringify({ type: 'join', meta: {} }))).toThrow(
      ProtocolError,
    )
  })
})
