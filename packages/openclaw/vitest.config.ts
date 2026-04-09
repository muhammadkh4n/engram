import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@engram-mem/core': resolve(__dirname, '../core/src/index.ts'),
      '@engram-mem/sqlite': resolve(__dirname, '../sqlite/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
})
