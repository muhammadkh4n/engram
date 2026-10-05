#!/usr/bin/env node
/**
 * engram-secret-scan: counts registered secret values left in stored text,
 * per secret name, over every item and capture event. It writes nothing; a
 * stored hit is removed by a manual forget.
 *
 * Needs SUPABASE_URL, SUPABASE_KEY and ENGRAM_SECRET_SOURCES_FILE. It refuses
 * to scan with a registry that read no configuration, could not read a path,
 * or holds no value: that scan would print a false zero.
 *
 * Output: per table `<table> scanned=<n> matches=<n>`, then per secret
 * `secret <NAME> matches=<n> ids=<table>:<id>,…` (first 50 rows), then
 * `stored secrets: <n>`. Never a value or a stored text.
 * Exit 0 when nothing is found, 3 when something is, 1 on an error.
 */

import { SCAN_TARGETS, SECRET_SOURCES_ENV, defaultSecretRegistry } from '@engram-mem/core'
import type { CaptureStore, KnownValueSpan, SecretRegistry } from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { isEntryPoint } from '../ingest/entry-point.js'

export const SECRET_SCAN_PAGE_SIZE = 500
export const SECRET_SCAN_IDS_SHOWN = 50
export const EXIT_CLEAN = 0
export const EXIT_ERROR = 1
export const EXIT_FOUND = 3

export interface SecretScanIo {
  out: (line: string) => void
  err: (line: string) => void
}

interface SecretTally {
  matches: number
  ids: string[]
}

/** Overlapping spans (two spellings of one value) count as one match, under the first span's name. */
function distinctMatches(spans: KnownValueSpan[]): KnownValueSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: KnownValueSpan[] = []
  let end = -1
  for (const span of sorted) {
    if (span.start < end) {
      end = Math.max(end, span.end)
      continue
    }
    out.push(span)
    end = span.end
  }
  return out
}

/** Why the registry cannot be trusted to count, or null when it can. */
function degradedReason(registry: SecretRegistry): string | null {
  const status = registry.status()
  if (status.unreadable.length > 0) return `the secret registry could not read: ${status.unreadable.join(', ')}`
  if (!status.configured) return `the secret registry read no sources configuration (${SECRET_SOURCES_ENV})`
  if (status.values === 0) return 'the secret registry holds no value'
  return null
}

export async function runSecretScan(
  store: Pick<CaptureStore, 'scanPage'>,
  registry: SecretRegistry,
  io: SecretScanIo,
): Promise<number> {
  const degraded = degradedReason(registry)
  if (degraded !== null) {
    io.err(`engram-secret-scan: ${degraded}; refusing to scan, the count would be a false zero`)
    return EXIT_ERROR
  }
  const tallies = new Map<string, SecretTally>()
  let total = 0
  try {
    for (const target of SCAN_TARGETS) {
      let scanned = 0
      let matches = 0
      let afterId: string | null = null
      for (;;) {
        const rows = await store.scanPage(target, afterId, SECRET_SCAN_PAGE_SIZE)
        for (const row of rows) {
          const rowNames = new Set<string>()
          for (const text of row.texts) {
            for (const span of distinctMatches(registry.findKnownValues(text))) {
              const tally = tallies.get(span.name) ?? { matches: 0, ids: [] }
              tally.matches++
              tallies.set(span.name, tally)
              rowNames.add(span.name)
              matches++
            }
          }
          for (const name of rowNames) {
            const tally = tallies.get(name)!
            if (tally.ids.length < SECRET_SCAN_IDS_SHOWN) tally.ids.push(`${target}:${row.id}`)
          }
        }
        scanned += rows.length
        if (rows.length < SECRET_SCAN_PAGE_SIZE) break
        afterId = rows[rows.length - 1]!.id
      }
      io.out(`${target} scanned=${scanned} matches=${matches}`)
      total += matches
    }
  } catch (err) {
    io.err(`engram-secret-scan: failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    return EXIT_ERROR
  }
  for (const [name, tally] of [...tallies].sort(([a], [b]) => a.localeCompare(b))) {
    io.out(`secret ${name} matches=${tally.matches} ids=${tally.ids.join(',')}`)
  }
  io.out(`stored secrets: ${total}`)
  return total === 0 ? EXIT_CLEAN : EXIT_FOUND
}

async function main(): Promise<number> {
  const io: SecretScanIo = { out: (line) => console.log(line), err: (line) => console.error(line) }
  for (const name of ['SUPABASE_URL', 'SUPABASE_KEY', SECRET_SOURCES_ENV]) {
    if (!process.env[name]) {
      io.err(`engram-secret-scan: ${name} is required`)
      return EXIT_ERROR
    }
  }
  const store = new PostgRestCaptureStore({ url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_KEY! })
  return runSecretScan(store, defaultSecretRegistry(), io)
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      console.error(`engram-secret-scan: failed: ${err instanceof Error ? err.name : 'error'}`)
      process.exitCode = EXIT_ERROR
    },
  )
}
