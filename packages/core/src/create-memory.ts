import { Memory } from './memory.js'
import type { MemoryOptions } from './memory.js'

export function createMemory(opts: MemoryOptions): Memory {
  return new Memory(opts)
}
