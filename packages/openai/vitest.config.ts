import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@engram-mem/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    name: '@engram-mem/openai',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
})
