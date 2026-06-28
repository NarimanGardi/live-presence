import { useEffect, useRef, useState, useCallback } from 'react'
import type { Peer, PresenceMeta } from '../protocol'
import { PresenceClient, type PresenceState } from './client'

export interface UsePresenceOptions<T extends PresenceMeta> {
  url: string
  initial: T
  throttleMs?: number
  maxBackoffMs?: number
}

export function usePresence<T extends PresenceMeta>(
  opts: UsePresenceOptions<T>,
): {
  self: T
  others: Peer<T>[]
  setPresence: (patch: Partial<T>) => void
  connected: boolean
} {
  const clientRef = useRef<PresenceClient<T> | null>(null)
  const [state, setState] = useState<PresenceState<T>>({
    self: opts.initial,
    others: [],
    connected: false,
  })

  // URL identifies the room+server; reconnecting on every render would thrash,
  // so the client is created once per url and torn down on unmount / url change.
  useEffect(() => {
    const client = new PresenceClient<T>(opts)
    clientRef.current = client
    const unsubscribe = client.subscribe(setState)
    return () => {
      unsubscribe()
      client.close()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.url])

  const setPresence = useCallback((patch: Partial<T>) => {
    clientRef.current?.setPresence(patch)
  }, [])

  return { self: state.self, others: state.others, setPresence, connected: state.connected }
}
