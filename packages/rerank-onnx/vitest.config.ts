import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@engram-mem/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    name: '@engram-mem/rerank-onnx',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Model load + inference is slow on first run (cold cache)
    testTimeout: 120000,
  },
})
