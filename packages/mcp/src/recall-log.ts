/**
 * Opt-in recall log: one JSONL line per recall, from POST /recall and from
 * memory_recall alike, holding the request, the effective filters, the ids
 * shown in order and the fingerprints the invariant counts compare. It lets a
 * window of real recall traffic be replayed in order and lets the exposure of
 * each item be counted, neither of which the database records.
 *
 * Writes never block or fail a recall: lines are queued and appended in the
 * background, one at a time so rotation and appends cannot interleave.
 */

import { promises as fs } from 'node:fs'
import { scrubSecrets } from '@engram-mem/core'
import { openPrivateHandle } from './ingest/private-files.js'
import type { RecallLogLineV2 } from './recall-route.js'

export const DEFAULT_RECALL_LOG_MAX_MB = 200
const BYTES_PER_MB = 1024 * 1024
/** A disk-full or permission error would otherwise print once per recall. */
const WRITE_ERROR_LOG_INTERVAL_MS = 60_000

export interface RecallLogOptions {
  maxBytes?: number
  now?: () => Date
  warn?: (message: string) => void
}

export class RecallLog {
  readonly path: string
  private readonly maxBytes: number
  private readonly now: () => Date
  private readonly warn: (message: string) => void
  private queue: Promise<void> = Promise.resolve()
  private lastWarnAt = Number.NEGATIVE_INFINITY

  constructor(path: string, options: RecallLogOptions = {}) {
    this.path = path
    this.maxBytes = options.maxBytes ?? DEFAULT_RECALL_LOG_MAX_MB * BYTES_PER_MB
    this.now = options.now ?? (() => new Date())
    this.warn = options.warn ?? ((message) => console.error(message))
  }

  /** Queues one line and returns at once; the write, with its scrub and rotation, happens in the background. */
  recordLine(line: RecallLogLineV2): void {
    this.queue = this.queue.then(() => this.write(line)).catch((err: unknown) => this.reportError(err))
  }

  /** Resolves once every queued line has been written or has failed. */
  flush(): Promise<void> {
    return this.queue
  }

  private async write(line: RecallLogLineV2): Promise<void> {
    // The query is caller text; credentials in it never reach the file.
    const { text } = await scrubSecrets(line.query)
    const data = `${JSON.stringify({ ...line, query: text })}\n`
    await this.rotateIfFull(Buffer.byteLength(data))
    const handle = await openPrivateHandle(this.path, 'a')
    try {
      await handle.appendFile(data)
    } finally {
      await handle.close()
    }
  }

  private async rotateIfFull(incoming: number): Promise<void> {
    let size: number
    try {
      size = (await fs.stat(this.path)).size
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    if (size > 0 && size + incoming > this.maxBytes) await fs.rename(this.path, `${this.path}.1`)
  }

  private reportError(err: unknown): void {
    const at = this.now().getTime()
    if (at - this.lastWarnAt < WRITE_ERROR_LOG_INTERVAL_MS) return
    this.lastWarnAt = at
    const message = err instanceof Error ? err.message : String(err)
    this.warn(`[engram-mcp] recall log write to ${this.path} failed: ${message}`)
  }
}

/** The recall log ENGRAM_RECALL_LOG names, or null when it is unset. A bad
 *  ENGRAM_RECALL_LOG_MAX_MB throws so the server fails at startup. */
export function recallLogFromEnv(env: NodeJS.ProcessEnv = process.env, options: Omit<RecallLogOptions, 'maxBytes'> = {}): RecallLog | null {
  const path = env['ENGRAM_RECALL_LOG']?.trim()
  if (!path) return null
  const rawMax = env['ENGRAM_RECALL_LOG_MAX_MB']?.trim()
  let maxMb = DEFAULT_RECALL_LOG_MAX_MB
  if (rawMax) {
    maxMb = Number(rawMax)
    if (!Number.isFinite(maxMb) || maxMb <= 0) {
      throw new Error(`ENGRAM_RECALL_LOG_MAX_MB must be a positive number of megabytes, got ${JSON.stringify(rawMax)}`)
    }
  }
  return new RecallLog(path, { ...options, maxBytes: Math.floor(maxMb * BYTES_PER_MB) })
}
