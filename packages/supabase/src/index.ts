export { SupabaseStorageAdapter } from './adapter.js'
export type { SupabaseAdapterOptions } from './adapter.js'
export { getMigrationSQL, MIGRATION_004, MIGRATION_005, MIGRATION_006, MIGRATION_007 } from './migrations.js'

import { SupabaseStorageAdapter } from './adapter.js'

export function supabaseAdapter(opts: { url: string; key: string; embeddingDimensions?: number }) {
  return new SupabaseStorageAdapter(opts)
}
