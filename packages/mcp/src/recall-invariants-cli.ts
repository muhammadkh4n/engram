#!/usr/bin/env node
/**
 * engram-recall-invariants --log <file> [--log <file>]...
 *
 * Counts, over the v2 lines POST /recall writes, what a recall must never do:
 *   forgotten_or_retired_shown  an item shown after it was forgotten, or
 *                               after it was retired when the call did not
 *                               ask for history (read now, via item states)
 *   over_budget                 a line whose shown characters exceed its budget
 *   nondeterministic_pairs      a group of lines with one request fingerprint
 *                               and one store version, each read with no
 *                               write between its start and end and no
 *                               degraded stage, that shows more than one output
 * Prints JSON with each count and up to 10 `file:line` places per count, and
 * exits 1 when any count is above 0. It prints no query text and writes
 * nothing. Needs SUPABASE_URL and SUPABASE_KEY for the item states.
 */
import { readFile } from 'node:fs/promises'
import { PostgRestRecallStore } from '@engram-mem/postgrest'
import type { RecallItemState, RecallStore } from '@engram-mem/core'
import { exitWhenFlushed } from './cli-exit.js'
import { isEntryPoint } from './ingest/entry-point.js'

const MAX_PLACES = 10
/** engram_recall_item_states reads this many ids per call. */
const STATE_BATCH = 500

export interface InvariantCount {
  count: number
  /** Up to 10 `file:line` places. */
  lines: string[]
}

export interface InvariantCounts {
  forgotten_or_retired_shown: InvariantCount
  over_budget: InvariantCount
  nondeterministic_pairs: InvariantCount
  /** v2 lines read; other lines are skipped. */
  lines_read: number
}

interface V2Line {
  place: string
  ts: Date
  includeHistory: boolean
  requestFp: string
  outputFp: string
  storeVersion: [number, number]
  degraded: string[]
  totalChars: number
  budgetChars: number
  itemIds: string[]
}

function asV2(raw: unknown, place: string): V2Line | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 2) return null
  const ts = new Date(String(r.ts))
  const sv = r.store_version
  if (
    Number.isNaN(ts.getTime()) ||
    typeof r.request_fp !== 'string' ||
    typeof r.output_fp !== 'string' ||
    !Array.isArray(sv) ||
    sv.length !== 2 ||
    !sv.every((n) => typeof n === 'number') ||
    typeof r.total_chars !== 'number' ||
    typeof r.budget_chars !== 'number' ||
    !Array.isArray(r.items)
  ) {
    throw new Error(`${place}: a v2 line is missing a field the counts need`)
  }
  return {
    place,
    ts,
    includeHistory: r.include_history === true,
    requestFp: r.request_fp,
    outputFp: r.output_fp,
    storeVersion: [sv[0] as number, sv[1] as number],
    degraded: Array.isArray(r.degraded) ? (r.degraded as string[]) : [],
    totalChars: r.total_chars,
    budgetChars: r.budget_chars,
    itemIds: (r.items as Array<{ id?: unknown }>).map((i) => String(i.id)),
  }
}

export function parseLog(path: string, text: string): V2Line[] {
  const lines: V2Line[] = []
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const line = asV2(parsed, `${path}:${i + 1}`)
    if (line !== null) lines.push(line)
  })
  return lines
}

function counter(): InvariantCount {
  return { count: 0, lines: [] }
}

function hit(c: InvariantCount, place: string, by = 1): void {
  c.count += by
  if (c.lines.length < MAX_PLACES && !c.lines.includes(place)) c.lines.push(place)
}

async function statesOf(store: Pick<RecallStore, 'itemStates'>, ids: string[]): Promise<Map<string, RecallItemState>> {
  const states = new Map<string, RecallItemState>()
  for (let i = 0; i < ids.length; i += STATE_BATCH) {
    for (const s of await store.itemStates(ids.slice(i, i + STATE_BATCH))) states.set(s.id, s)
  }
  return states
}

export async function countInvariants(lines: readonly V2Line[], store: Pick<RecallStore, 'itemStates'>): Promise<InvariantCounts> {
  const shown = counter()
  const overBudget = counter()
  const nondeterministic = counter()

  const states = await statesOf(store, [...new Set(lines.flatMap((l) => l.itemIds))])
  for (const line of lines) {
    for (const id of line.itemIds) {
      const state = states.get(id)
      if (state === undefined) continue
      const forgotten = state.forgottenAt !== null && state.forgottenAt <= line.ts
      const retired = !line.includeHistory && state.retiredAt !== null && state.retiredAt <= line.ts
      if (forgotten || retired) hit(shown, line.place)
    }
    if (line.totalChars > line.budgetChars) hit(overBudget, line.place)
  }

  // Two outputs are comparable only for the same request on the same store:
  // a write between two calls may rightly change what the second shows.
  const groups = new Map<string, V2Line[]>()
  for (const line of lines) {
    if (line.storeVersion[0] !== line.storeVersion[1] || line.degraded.length > 0) continue
    const key = `${line.requestFp}\u0000${line.storeVersion[0]}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  }
  for (const group of groups.values()) {
    if (new Set(group.map((l) => l.outputFp)).size < 2) continue
    nondeterministic.count += 1
    for (const l of group) if (nondeterministic.lines.length < MAX_PLACES) nondeterministic.lines.push(l.place)
  }

  return { forgotten_or_retired_shown: shown, over_budget: overBudget, nondeterministic_pairs: nondeterministic, lines_read: lines.length }
}

export function parseArgs(argv: readonly string[]): { logs: string[] } | { error: string } {
  const logs: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--log' && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
      logs.push(argv[i + 1]!)
      i += 1
    } else {
      return { error: `unexpected argument: ${argv[i]}` }
    }
  }
  return logs.length === 0 ? { error: 'name at least one --log <file>' } : { logs }
}

export interface InvariantsIo {
  readText(path: string): Promise<string>
  store(): Pick<RecallStore, 'itemStates'>
  out(text: string): void
  err(text: string): void
}

/** Returns the exit code: 0 when every count is 0, 1 when any is not, 2 on a usage or read error. */
export async function runInvariants(argv: readonly string[], io: InvariantsIo): Promise<number> {
  const args = parseArgs(argv)
  if ('error' in args) {
    io.err(`${args.error}\nusage: engram-recall-invariants --log <file> [--log <file>]...\n`)
    return 2
  }
  let lines: V2Line[]
  try {
    lines = (await Promise.all(args.logs.map(async (p) => parseLog(p, await io.readText(p))))).flat()
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  const counts = await countInvariants(lines, io.store())
  io.out(`${JSON.stringify(counts, null, 2)}\n`)
  const any = counts.forgotten_or_retired_shown.count + counts.over_budget.count + counts.nondeterministic_pairs.count
  return any > 0 ? 1 : 0
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

if (isEntryPoint(import.meta.url)) {
  runInvariants(process.argv.slice(2), {
    readText: (path) => readFile(path, 'utf8'),
    store: () => new PostgRestRecallStore({ url: requireEnv('SUPABASE_URL'), key: requireEnv('SUPABASE_KEY') }),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  })
    .then((code) => exitWhenFlushed(code))
    .catch((err: unknown) => {
      process.stderr.write(`engram-recall-invariants: ${err instanceof Error ? err.message : String(err)}\n`)
      return exitWhenFlushed(2)
    })
}
