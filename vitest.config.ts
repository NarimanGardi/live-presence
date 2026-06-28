import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // node by default; hook tests opt into jsdom via a // @vitest-environment comment
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
})
