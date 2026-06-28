import { createServer } from 'node:http'
import { createPresenceServer } from '../src/index'

const http = createServer()
createPresenceServer({ server: http, heartbeatInterval: 10_000, batchWindow: 50 })
http.listen(3001, () => console.log('presence server on ws://localhost:3001/presence/:room'))
