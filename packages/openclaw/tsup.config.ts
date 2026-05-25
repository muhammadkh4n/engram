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
  // Keep native modules and host-provided packages external.
  // @supabase/supabase-js is a runtime dep installed separately on the host.
  external: [
    'openclaw',
    '@sinclair/typebox',
    'better-sqlite3',
    'openai',
    '@supabase/supabase-js',
  ],
  // Bundle Engram workspace packages + pure JS deps into the plugin
  noExternal: [
    '@engram-mem/core',
    '@engram-mem/sqlite',
    '@engram-mem/openai',
    '@engram-mem/postgrest',
    'uuid',
  ],
  esbuildOptions(options) {
    options.platform = 'node'
    // Resolve workspace packages to their source
    options.alias = {
      '@engram-mem/core': path.resolve(__dirname, '../core/src/index.ts'),
      '@engram-mem/sqlite': path.resolve(__dirname, '../sqlite/src/index.ts'),
      '@engram-mem/openai': path.resolve(__dirname, '../openai/src/index.ts'),
      '@engram-mem/postgrest': path.resolve(__dirname, '../postgrest/src/index.ts'),
    }
  },
})
