import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, proxy: { '/presence': { target: 'ws://localhost:3001', ws: true } } },
  resolve: { alias: { 'live-presence/react': new URL('../src/react/index.ts', import.meta.url).pathname } },
})
