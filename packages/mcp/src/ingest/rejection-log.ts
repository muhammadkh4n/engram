/**
 * Rolling rejection log for the salience gate.
 *
 * Every rejected classification gets appended to ~/.engram/rejected.jsonl
 * with timestamp, cwd, project, role, content, category attempt,
 * confidence, and reason. Rolling retention: entries older than 30 days
 * are trimmed on each write.
 *
 * This gives us an audit trail for tuning the classifier prompt without
 * polluting the memory store itself with noise. engram-salience-stats
 * reads this file to compute ingest-rate and rejection-reason histograms.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendPrivateFile, ensurePrivateDir } from './private-files.js'

export interface RejectionEntry {
  timestamp: string
  cwd: string
  /** Null when the turn happened outside any repository (shared). */
  project: string | null
  role: 'user' | 'assistant' | 'system'
  source: string
  category: string
  confidence: number
  reason: string
  /** First 300 chars of the rejected content — enough for audit, bounded for disk */
  contentPreview: string
}

const LOG_DIR = join(homedir(), '.engram')
const LOG_PATH = join(LOG_DIR, 'rejected.jsonl')
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function ensureDir(): void {
  try {
    ensurePrivateDir(LOG_DIR)
  } catch {
    // ignore — write will fail loudly if dir is inaccessible
  }
}

export function logRejection(entry: RejectionEntry): void {
  ensureDir()
  try {
    appendPrivateFile(LOG_PATH, JSON.stringify(entry) + '\n')
  } catch {
    // non-fatal — the ingest path should never break over logging
  }
}

/**
 * Trim entries older than RETENTION_MS. Called periodically (e.g. from
 * the stats command). Reads the whole file, filters, rewrites.
 */
export function rotateRejectionLog(): void {
  if (!existsSync(LOG_PATH)) return
  try {
    const raw = readFileSync(LOG_PATH, 'utf-8')
    const cutoff = Date.now() - RETENTION_MS
    const kept: string[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as RejectionEntry
        const ts = Date.parse(entry.timestamp)
        if (Number.isFinite(ts) && ts >= cutoff) {
          kept.push(line)
        }
      } catch {
        continue
      }
    }
    writeFileSync(LOG_PATH, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8')
  } catch {
    // non-fatal
  }
}

export function readRejections(sinceDays: number = 30): RejectionEntry[] {
  if (!existsSync(LOG_PATH)) return []
  try {
    const raw = readFileSync(LOG_PATH, 'utf-8')
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000
    const entries: RejectionEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as RejectionEntry
        const ts = Date.parse(entry.timestamp)
        if (Number.isFinite(ts) && ts >= cutoff) {
          entries.push(entry)
        }
      } catch {
        continue
      }
    }
    return entries
  } catch {
    return []
  }
}

export function rejectionLogPath(): string {
  return LOG_PATH
}
