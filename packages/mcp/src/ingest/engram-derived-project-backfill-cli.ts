#!/usr/bin/env node
/**
 * Engram derived-project backfill
 *
 * Digests and semantic facts stored without a `project_id` get the project
 * their `derives_from` sources agree on (see derived-project-backfill-lib.ts:
 * episodes → digests first, then digests → semantic facts in the same run).
 * Mixed or untagged sources leave the row NULL.
 *
 * Dry run by default: prints, per kind, counts per target project and per
 * reason, with up to ten sample ids per bucket. `--apply` performs the
 * updates in batches, prints the same counts, and writes every row it
 * tagged to the `--applied-out` CSV (created new, never overwritten) as
 * (tier, id, project_id), so the apply can be undone exactly. Never prints
 * content.
 *
 * Idempotent: only rows whose `project_id` is still NULL are read or
 * written, so a repeat run touches nothing already tagged.
 *
 * Usage:
 *   engram-derived-project-backfill                  # dry run
 *   engram-derived-project-backfill --apply --applied-out tagged.csv
 *   engram-derived-project-backfill --page-size N    # rows per fetch (default 1000)
 *   engram-derived-project-backfill --batch-size N   # ids per lookup and update (default 100)
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY
 */

import { CliExit, exitOnError } from '../cli-exit.js'
import { existsSync } from 'node:fs'
import { PostgrestClient } from '@supabase/postgrest-js'
import {
  formatDerivedReport,
  openAppliedCsv,
  postgrestDerivedProjectStore,
  runDerivedProjectBackfill,
} from './derived-project-backfill-lib.js'

const TAG = '[engram-derived-project-backfill]'

interface Args {
  apply: boolean
  pageSize: number
  batchSize: number
  appliedPath: string | null
}

function fail(message: string): never {
  throw new CliExit(1, `${TAG} ${message}`)
}

function parsePositiveInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    fail(`--${flag} requires a positive integer, got ${raw === undefined ? '(missing value)' : `"${raw}"`}`)
  }
  return n
}

const HELP =
  'engram-derived-project-backfill — restore project_id on digests and semantic facts\n' +
  '  from their derives_from sources (dry run by default)\n' +
  '  A row gets a project only when every tagged source holds that project;\n' +
  '  mixed or untagged sources leave it NULL.\n' +
  '  --apply            write project_id (needs --applied-out)\n' +
  '  --applied-out FILE new CSV of (tier, id, project_id) for every row written\n' +
  '  --page-size N      rows per fetch (default 1000)\n' +
  '  --batch-size N     ids per lookup and update (default 100)\n'

function parseArgs(argv: readonly string[]): Args {
  let apply = false
  let pageSize = 1000
  let batchSize = 100
  let appliedPath: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--page-size') pageSize = parsePositiveInt(argv[++i], 'page-size')
    else if (a === '--batch-size') batchSize = parsePositiveInt(argv[++i], 'batch-size')
    else if (a === '--applied-out') {
      const raw = argv[++i]
      if (!raw || raw.startsWith('--')) fail('--applied-out requires a file path')
      appliedPath = raw
    }
    else if (a === '--help' || a === '-h') {
      console.log(HELP)
      throw new CliExit(0)
    } else fail(`unknown argument "${a}"`)
  }
  if (apply && appliedPath === null) fail('--apply requires --applied-out FILE')
  if (!apply && appliedPath !== null) fail('--applied-out is only written with --apply')
  if (appliedPath !== null && existsSync(appliedPath)) fail(`--applied-out ${appliedPath} already exists`)
  return { apply, pageSize, batchSize, appliedPath }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_KEY']
  if (!url || !key) fail('Missing SUPABASE_URL / SUPABASE_KEY')

  const client = new PostgrestClient(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  })

  console.log(
    `${TAG} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} page-size=${args.pageSize} batch-size=${args.batchSize}`,
  )
  // Created before any write so a failed apply still leaves its list.
  const applied = args.appliedPath ? openAppliedCsv(args.appliedPath) : undefined
  let report
  try {
    report = await runDerivedProjectBackfill(postgrestDerivedProjectStore(client, args.pageSize), {
      apply: args.apply,
      pageSize: args.pageSize,
      batchSize: args.batchSize,
      applied,
    })
  } finally {
    applied?.close()
  }
  console.log(formatDerivedReport(report, args.apply))
  if (args.appliedPath) console.log(`${TAG} applied rows: ${args.appliedPath}`)
}

main().catch((err) => exitOnError(err, (e) => console.error(`${TAG} FATAL:`, e instanceof Error ? e.message : e)))
