import { defineConfig } from 'tsup'
import path from 'path'

export default defineConfig({
  entry: {
    'openclaw-plugin': 'src/openclaw-plugin.ts',
  },
  format: ['esm'],
  target: 'node18',
  dts: false,
  sourcemap: true,
  clean: false,
  // Keep native modules and host-provided packages external
  external: [
    'openclaw',
    '@sinclair/typebox',
    'better-sqlite3',
  ],
  // Bundle Engram workspace packages + pure JS deps into the plugin
  noExternal: [
    '@engram/core',
    '@engram/sqlite',
    'uuid',
  ],
  esbuildOptions(options) {
    options.platform = 'node'
    // Resolve workspace packages to their source
    options.alias = {
      '@engram/core': path.resolve(__dirname, '../core/src/index.ts'),
      '@engram/sqlite': path.resolve(__dirname, '../sqlite/src/index.ts'),
    }
  },
})
