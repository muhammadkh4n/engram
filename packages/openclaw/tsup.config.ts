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
    '@engram/core',
    '@engram/sqlite',
    '@engram/openai',
    '@engram/supabase',
    'uuid',
  ],
  esbuildOptions(options) {
    options.platform = 'node'
    // Resolve workspace packages to their source
    options.alias = {
      '@engram/core': path.resolve(__dirname, '../core/src/index.ts'),
      '@engram/sqlite': path.resolve(__dirname, '../sqlite/src/index.ts'),
      '@engram/openai': path.resolve(__dirname, '../openai/src/index.ts'),
      '@engram/supabase': path.resolve(__dirname, '../supabase/src/index.ts'),
    }
  },
})
