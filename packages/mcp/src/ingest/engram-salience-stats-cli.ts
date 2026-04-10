#!/usr/bin/env node
/**
 * engram-salience-stats — audit the salience gate's behavior.
 *
 * Reads ~/.engram/rejected.jsonl and (optionally) the hook log to
 * produce a one-screen summary of what's being rejected and why,
 * broken down by category, reason, project, and source.
 *
 * Usage:
 *   engram-salience-stats                   # last 7 days
 *   engram-salience-stats --days 30         # last 30 days
 *   engram-salience-stats --category fact   # only one category
 *   engram-salience-stats --rotate          # trim old entries first
 */

import { readRejections, rotateRejectionLog, rejectionLogPath } from './rejection-log.js'

interface Args {
  days: number
  category: string | null
  rotate: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 7, category: null, rotate: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--days') args.days = Number.parseInt(argv[++i] ?? '7', 10)
    else if (flag === '--category') args.category = argv[++i] ?? null
    else if (flag === '--rotate') args.rotate = true
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if (args.rotate) {
    rotateRejectionLog()
    process.stdout.write('Rotated rejection log (removed entries >30 days old).\n')
  }

  const all = readRejections(args.days)
  const entries = args.category
    ? all.filter((e) => e.category === args.category)
    : all

  process.stdout.write(`\nengram-salience-stats — last ${args.days} days\n`)
  process.stdout.write(`log file: ${rejectionLogPath()}\n`)
  process.stdout.write('\n')

  if (entries.length === 0) {
    process.stdout.write('No rejections in window.\n')
    return
  }

  // --- By reason ---
  const byReason = new Map<string, number>()
  for (const e of entries) {
    byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1)
  }
  process.stdout.write(`rejections: ${entries.length}\n\n`)
  process.stdout.write('top rejection reasons:\n')
  const reasonRows = [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  for (const [reason, count] of reasonRows) {
    const pct = ((count / entries.length) * 100).toFixed(1)
    process.stdout.write(`  ${count.toString().padStart(4)} (${pct.padStart(5)}%)  ${reason}\n`)
  }

  // --- By attempted category ---
  process.stdout.write('\ncategories the classifier TRIED to reject as:\n')
  const byCategory = new Map<string, number>()
  for (const e of entries) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1)
  }
  for (const [cat, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${count.toString().padStart(4)}  ${cat}\n`)
  }

  // --- By role ---
  process.stdout.write('\nby role:\n')
  const byRole = new Map<string, number>()
  for (const e of entries) {
    byRole.set(e.role, (byRole.get(e.role) ?? 0) + 1)
  }
  for (const [role, count] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${count.toString().padStart(4)}  ${role}\n`)
  }

  // --- By project ---
  process.stdout.write('\nby project:\n')
  const byProject = new Map<string, number>()
  for (const e of entries) {
    byProject.set(e.project, (byProject.get(e.project) ?? 0) + 1)
  }
  for (const [proj, count] of [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    process.stdout.write(`  ${count.toString().padStart(4)}  ${proj}\n`)
  }

  // --- Confidence histogram ---
  process.stdout.write('\nconfidence distribution:\n')
  const buckets: [number, number][] = [
    [0, 0], [0.1, 0], [0.2, 0], [0.3, 0], [0.4, 0],
    [0.5, 0], [0.6, 0], [0.7, 0], [0.8, 0], [0.9, 0],
  ]
  for (const e of entries) {
    const idx = Math.min(9, Math.floor(e.confidence * 10))
    const bucket = buckets[idx]
    if (bucket) bucket[1]++
  }
  for (const [floor, count] of buckets) {
    if (count === 0) continue
    const label = `${floor.toFixed(1)}-${(floor + 0.1).toFixed(1)}`
    const bar = '█'.repeat(Math.min(40, Math.ceil((count / entries.length) * 40)))
    process.stdout.write(`  ${label}  ${count.toString().padStart(4)}  ${bar}\n`)
  }

  // --- Recent sample ---
  process.stdout.write('\nrecent 5 rejections:\n')
  for (const e of entries.slice(-5).reverse()) {
    const preview = e.contentPreview.replace(/\n/g, ' ').slice(0, 80)
    process.stdout.write(`  [${e.timestamp.slice(0, 19)}] ${e.reason}: "${preview}"\n`)
  }
  process.stdout.write('\n')
}

main()
