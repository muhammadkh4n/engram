#!/usr/bin/env node
/**
 * Measures the candidate statement on a Postgres container that already
 * holds schema.sql and bm25.sql: a throwaway one for the synthetic exact-scan
 * latency, a copy of a real store for HNSW recall and per-leg contributions.
 *
 * Usage:
 *   npx tsx packages/bench/src/access-path/engram-access-path.ts seed --container <name> --rows <n> [--seed <n>]
 *   npx tsx packages/bench/src/access-path/engram-access-path.ts latency --container <name> \
 *     [--sizes 1000,2000,…] [--seed <n>] [--k 50]
 *   npx tsx packages/bench/src/access-path/engram-access-path.ts recall --container <name> --db <db> \
 *     --pins <file>… [--sample-items 200] [--k 50]
 *   npx tsx packages/bench/src/access-path/engram-access-path.ts legs --container <name> --db <db> \
 *     --cases <file> --gold <file> --pins <file>… --calibration-before <iso> [--k 50]
 *
 * `seed` writes synthetic document notes into an empty memory_items. `latency`
 * times the exact branch at each grid size through
 * engram_item_candidates_explain(..., p_force_path => 'exact', p_analyze => true),
 * with p_as_of chosen so exactly that many rows are visible, and prints the
 * table and the threshold rule's value.
 *
 * `recall` compares the vector leg's forced hnsw ids with its forced exact
 * ids for every pinned embedding reply and a sample of item embeddings,
 * under seven filters, and prints recall@k per filtered-size bucket above
 * exact_max_rows with the bar's verdict. `legs` runs each reviewed decision
 * case and gold query with and without its entities and prints which legs
 * hold each target, by id, and the entity-leg rule's verdict; item text is
 * read to match phrases and never printed.
 *
 * Postgres is reached only through `docker exec -i <container> psql`; nothing
 * else on the host is touched, and every statement only reads the store.
 * Exit 2: usage error. Exit 1: any other error.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'
import type { EntityProject } from '@engram-mem/core'
import { assertReviewed, parseCases } from '../decisions/cases.js'
import { parseGold } from '../eval/gold.js'
import { parsePinFile, type PinTable } from '../eval/pins.js'
import {
  assertOtherLegsUnchanged,
  caseQueries,
  entityRule,
  evaluateQuery,
  formatLegs,
  goldQueries,
  legsSql,
  noVectorResult,
  parseLegsOutput,
  type QueryResult,
} from './legs-lib.js'
import {
  BUDGET_MS,
  QUERY_VECTORS,
  TIMED_CALLS,
  applyThresholdRule,
  formatTable,
  latencySql,
  parseCommand,
  parseLatencyOutput,
  queryVectors,
  seedSql,
  type Command,
  type SizeTimings,
} from './measure-lib.js'
import {
  RECALL_FILTERS,
  embeddingReplies,
  formatRecall,
  parseRecallOutput,
  recallSql,
  summarizeRecall,
  type RecallPair,
} from './recall-lib.js'

const PSQL = ['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres']

function psql(container: string, sql: string, onStdout?: (chunk: string) => void, db?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['exec', '-i', container, ...PSQL, ...(db === undefined ? [] : ['-d', db])]
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      onStdout?.(chunk)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`psql in ${container} failed (exit ${code}): ${stderr.trim()}`))
    })
    child.stdin.end(sql)
  })
}

async function seed(command: Extract<Command, { command: 'seed' }>): Promise<void> {
  const started = Date.now()
  const out = await psql(command.container, seedSql(command.rows, command.seed), (chunk) => process.stderr.write(chunk))
  const count = out.trim().split('\n').at(-1)
  console.log(`memory_items holds ${count} rows; seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

async function latency(command: Extract<Command, { command: 'latency' }>): Promise<void> {
  const vectors = queryVectors(command.seed)
  const measured: SizeTimings[] = []
  for (const size of command.sizes) {
    const calls = parseLatencyOutput(await psql(command.container, latencySql(size, vectors, command.k)), size)
    const timingsMs = calls.filter((c) => c.label === 'timed').map((c) => c.executionMs)
    measured.push({ size, timingsMs })
    process.stderr.write(`measured ${size} rows: ${timingsMs.length} timed calls\n`)
  }
  const result = applyThresholdRule(measured)
  const cpu = os.cpus()[0]?.model ?? 'unknown'
  console.log(
    `Exact branch, p_k ${command.k}, ${QUERY_VECTORS} query vectors x ${TIMED_CALLS} timed calls after one warm-up per size, ` +
      `max_parallel_workers_per_gather 0. Host: ${cpu}, ${os.availableParallelism()} CPUs.`,
  )
  console.log(formatTable(result))
  if (result.anyWithinBudget) {
    console.log(`exact_max_rows = ${result.exactMaxRows} (largest size with p95 <= ${BUDGET_MS} ms)`)
  } else {
    console.log(`exact_max_rows = ${result.exactMaxRows}: every measured size exceeds ${BUDGET_MS} ms at p95`)
  }
}

function readPins(files: readonly string[]): PinTable[] {
  return files.map((file) => parsePinFile(fs.readFileSync(file, 'utf8')).pins)
}

async function exactMaxRows(container: string, db: string): Promise<number> {
  const out = await psql(container, 'SELECT exact_max_rows FROM public.engram_item_access_settings();', undefined, db)
  const value = Number(out.trim())
  if (!Number.isInteger(value) || value < 1) throw new Error(`engram_item_access_settings returned ${out.trim()}`)
  return value
}

async function recall(command: Extract<Command, { command: 'recall' }>): Promise<void> {
  const pinned = embeddingReplies(readPins(command.pins))
  const threshold = await exactMaxRows(command.container, command.db)
  const pairs: RecallPair[] = []
  for (const filter of RECALL_FILTERS) {
    const sql = recallSql(filter, pinned, command.sampleItems, command.k)
    const run = parseRecallOutput(filter, await psql(command.container, sql, undefined, command.db))
    pairs.push(...run.pairs)
    process.stderr.write(`${filter}${run.value === null ? '' : ` (${run.value})`}: ${run.pairs.length} pairs\n`)
  }
  console.log(`${pinned.length} pinned query vectors, ${command.sampleItems} sampled items, ${RECALL_FILTERS.length} filters`)
  console.log(formatRecall(summarizeRecall(pairs, threshold, command.k)))
}

async function legs(command: Extract<Command, { command: 'legs' }>): Promise<void> {
  const cases = parseCases(fs.readFileSync(command.cases, 'utf8'))
  assertReviewed(cases)
  const gold = parseGold(fs.readFileSync(command.gold, 'utf8'))
  const pins = readPins(command.pins)
  const projectsOut = await psql(
    command.container,
    "SELECT json_build_object('id', id, 'kind', kind)::text FROM public.memory_projects ORDER BY id;",
    undefined,
    command.db,
  )
  const projects = projectsOut.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as EntityProject)
  const { queries: fromCases, skipped } = caseQueries(cases, command.calibrationBefore, projects, pins)
  const queries = [...fromCases, ...goldQueries(gold, projects, pins)]
  const runnable = queries.filter((q) => q.vector !== null)
  const { rows, items } =
    runnable.length === 0
      ? { rows: [], items: new Map() }
      : parseLegsOutput(await psql(command.container, legsSql(runnable, command.k), undefined, command.db))
  const results: QueryResult[] = queries.map((q) => {
    const n = runnable.indexOf(q) + 1
    if (n === 0) return noVectorResult(q)
    const withRows = rows.filter((r) => r.n === n && r.withEntities)
    assertOtherLegsUnchanged(q.id, withRows, rows.filter((r) => r.n === n && !r.withEntities))
    return evaluateQuery(q, withRows, items)
  })
  console.log(formatLegs(results, entityRule(results, skipped)))
}

async function main(argv: readonly string[]): Promise<number> {
  let command: Command
  try {
    command = parseCommand(argv)
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  if (command.command === 'seed') await seed(command)
  else if (command.command === 'latency') await latency(command)
  else if (command.command === 'recall') await recall(command)
  else await legs(command)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error((error as Error).message)
      process.exit(1)
    },
  )
}
