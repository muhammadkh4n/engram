#!/usr/bin/env node
/**
 * Measures the candidate statement's exact-scan latency on a throwaway
 * Postgres container that already holds schema.sql and bm25.sql.
 *
 * Usage:
 *   npx tsx packages/bench/src/access-path/engram-access-path.ts seed --container <name> --rows <n> [--seed <n>]
 *   npx tsx packages/bench/src/access-path/engram-access-path.ts latency --container <name> \
 *     [--sizes 1000,2000,…] [--seed <n>] [--k 50]
 *
 * `seed` writes synthetic document notes into an empty memory_items. `latency`
 * times the exact branch at each grid size through
 * engram_item_candidates_explain(..., p_force_path => 'exact', p_analyze => true),
 * with p_as_of chosen so exactly that many rows are visible, and prints the
 * table and the threshold rule's value. Postgres is reached only through
 * `docker exec -i <container> psql`; nothing else on the host is touched.
 * Exit 2: usage error. Exit 1: any other error.
 */
import { spawn } from 'node:child_process'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'
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

const PSQL = ['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres']

function psql(container: string, sql: string, onStdout?: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, ...PSQL], { stdio: ['pipe', 'pipe', 'pipe'] })
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

async function main(argv: readonly string[]): Promise<number> {
  let command: Command
  try {
    command = parseCommand(argv)
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  if (command.command === 'seed') await seed(command)
  else await latency(command)
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
