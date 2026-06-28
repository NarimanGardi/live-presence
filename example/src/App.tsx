import { useEffect, useRef } from 'react'
import { usePresence } from 'live-presence/react'

interface CursorMeta {
  name: string
  color: string
  cursor: { x: number; y: number } | null
}

const palette = ['#ef4444', '#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#ec4899']
const me = {
  name: `guest-${Math.floor(Math.random() * 1000)}`,
  color: palette[Math.floor(Math.random() * palette.length)]!,
  cursor: null,
}

export function App() {
  const url = `${location.origin.replace(/^http/, 'ws')}/presence/lobby`
  const { others, setPresence, connected } = usePresence<CursorMeta>({ url, initial: me })
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (frame.current) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        setPresence({ cursor: { x: e.clientX, y: e.clientY } })
      })
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [setPresence])

  const here = others.filter((p) => p.meta.cursor)

  return (
    <main>
      <header>
        <span className={connected ? 'dot on' : 'dot'} />
        <strong>{others.length + 1}</strong> here
        <div className="avatars">
          <span className="avatar" style={{ background: me.color }} title={me.name} />
          {others.map((o) => (
            <span
              key={o.id}
              className="avatar"
              style={{ background: o.meta.color }}
              title={o.meta.name}
            />
          ))}
        </div>
      </header>
      {here.map((p) => (
        <div
          key={p.id}
          className="cursor"
          style={{
            transform: `translate(${p.meta.cursor!.x}px, ${p.meta.cursor!.y}px)`,
            color: p.meta.color,
          }}
        >
          <Pointer />
          <span className="label" style={{ background: p.meta.color }}>
            {p.meta.name}
          </span>
        </div>
      ))}
    </main>
  )
}

function Pointer() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 2l6 14 2-5 5-2z" />
    </svg>
  )
}
