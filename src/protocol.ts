export type PresenceMeta = Record<string, unknown>

export interface Peer<T = PresenceMeta> {
  id: string
  meta: T
}

export interface RoomChange<T = PresenceMeta> {
  joined?: Peer<T>[]
  updated?: Peer<T>[]
  left?: string[]
}

export type ClientMessage =
  | { type: 'join'; clientId: string; meta: PresenceMeta }
  | { type: 'update'; meta: PresenceMeta }
  | { type: 'pong' }

export type ServerMessage =
  { type: 'snapshot'; peers: Peer[] } | ({ type: 'diff' } & RoomChange) | { type: 'ping' }

export class ProtocolError extends Error {}

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg)
}

function asObject(raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ProtocolError('message is not valid JSON')
  }
  if (typeof value !== 'object' || value === null) {
    throw new ProtocolError('message is not an object')
  }
  return value as Record<string, unknown>
}

const isMeta = (v: unknown): v is PresenceMeta =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseClientMessage(raw: string): ClientMessage {
  const obj = asObject(raw)
  switch (obj.type) {
    case 'join':
      if (typeof obj.clientId !== 'string' || !isMeta(obj.meta)) {
        throw new ProtocolError('invalid join')
      }
      return { type: 'join', clientId: obj.clientId, meta: obj.meta }
    case 'update':
      if (!isMeta(obj.meta)) throw new ProtocolError('invalid update')
      return { type: 'update', meta: obj.meta }
    case 'pong':
      return { type: 'pong' }
    default:
      throw new ProtocolError(`unknown client message: ${String(obj.type)}`)
  }
}

export function parseServerMessage(raw: string): ServerMessage {
  const obj = asObject(raw)
  switch (obj.type) {
    case 'snapshot':
      if (!Array.isArray(obj.peers)) throw new ProtocolError('invalid snapshot')
      return { type: 'snapshot', peers: obj.peers as Peer[] }
    case 'diff':
      return {
        type: 'diff',
        joined: obj.joined as Peer[] | undefined,
        updated: obj.updated as Peer[] | undefined,
        left: obj.left as string[] | undefined,
      }
    case 'ping':
      return { type: 'ping' }
    default:
      throw new ProtocolError(`unknown server message: ${String(obj.type)}`)
  }
}
