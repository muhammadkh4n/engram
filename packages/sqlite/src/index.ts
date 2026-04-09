export { SqliteStorageAdapter } from './adapter.js'

import { SqliteStorageAdapter } from './adapter.js'
import type { StorageAdapter } from '@engram-mem/core'

export function sqliteAdapter(opts?: { path?: string }): StorageAdapter {
  return new SqliteStorageAdapter(opts?.path)
}
