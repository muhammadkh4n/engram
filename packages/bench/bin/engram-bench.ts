#!/usr/bin/env node
/**
 * engram-bench CLI
 *
 * Usage:
 *   npx engram-bench --benchmark locomo --data ./data/locomo/
 *   npx engram-bench --benchmark longmemeval --data ./data/longmemeval/
 *   npx engram-bench --benchmark locomo --compare --data ./data/locomo/
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { LoCoMoAdapter } from '../src/locomo/adapter.js'
import { LongMemEvalAdapter } from '../src/longmemeval/adapter.js'
import { compareLoCoMo, compareLongMemEval } from '../src/runner/compare.js'
import { compareMatrix } from '../src/runner/compare-matrix.js'
import { formatLoCoMoTable, formatLongMemEvalTable, formatComparisonTable } from '../src/metrics/table.js'
import type { BenchmarkOpts } from '../src/types.js'

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--no-consolidate') { args['consolidate'] = false; continue }
    if (arg === '--no-graph') { args['graph'] = false; continue }
    if (arg === '--no-rerank') { args['noRerank'] = true; continue }
    if (arg === '--consolidate') { args['consolidate'] = true; continue }
    if (arg === '--graph') { args['graph'] = true; continue }
    if (arg === '--compare') { args['compare'] = true; continue }
    if (arg === '--matrix') { args['matrix'] = true; continue }
    if (arg === '--require-graph') { args['requireGraph'] = true; continue }
    if (arg === '--verbose') { args['verbose'] = true; continue }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      args[key] = argv[i + 1] ?? true
      i++
    }
  }

  if (!args['benchmark'] || typeof args['benchmark'] !== 'string') {
    console.error('Error: --benchmark is required (locomo or longmemeval)')
    process.exit(1)
  }
  if (!args['data'] || typeof args['data'] !== 'string') {
    console.error('Error: --data is required')
    process.exit(1)
  }

  return {
    benchmark: args['benchmark'] as string,
    dataPath: path.resolve(args['data'] as string),
    outputDir: path.resolve((args['output'] as string | undefined) ?? './results'),
    consolidate: args['consolidate'] !== false,
    graph: args['graph'] !== false,
    compare: args['compare'] === true,
    matrix: args['matrix'] === true,
    requireGraph: args['requireGraph'] === true,
    categories: typeof args['categories'] === 'string'
      ? (args['categories'] as string).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
      : undefined,
    topK: parseInt(args['top-k'] as string ?? '10', 10) || 10,
    limit: parseInt(args['limit'] as string ?? '0', 10) || 0,
    noRerank: args['noRerank'] === true,
    verbose: args['verbose'] === true,
  }
}

/** sha256 fingerprint of the corpus (file contents, or dir name:size listing). */
async function hashCorpus(p: string): Promise<string> {
  try {
    const st = await fs.stat(p)
    const hash = createHash('sha256')
    if (st.isDirectory()) {
      for (const e of (await fs.readdir(p)).sort()) {
        const s = await fs.stat(path.join(p, e))
        hash.update(`${e}:${s.size}\n`)
      }
    } else {
      hash.update(await fs.readFile(p))
    }
    return hash.digest('hex')
  } catch {
    return 'unknown'
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const opts: BenchmarkOpts = {
    consolidate: args.consolidate,
    graph: args.graph,
    topK: args.topK,
    limit: args.limit > 0 ? args.limit : undefined,
    noRerank: args.noRerank === true,
  }

  await fs.mkdir(args.outputDir, { recursive: true })

  console.log(`Benchmark:     ${args.benchmark}`)
  console.log(`Data:          ${args.dataPath}`)
  console.log(`Graph layer:   ${args.graph ? 'ON (Neo4j)' : 'OFF (SQL-only)'}`)
  console.log(`Consolidation: ${args.consolidate ? 'ON' : 'OFF'}`)
  console.log('')

  if (args.matrix) {
    console.log('Running 4-cell {graph}x{rerank} ablation matrix...')
    if (args.requireGraph) console.log('requireGraph: ON (a graph cell without a bench Neo4j will hard-fail)')
    let commit = 'unknown'
    try { commit = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim() } catch { /* not a git checkout */ }
    const corpusSha256 = await hashCorpus(args.dataPath)

    const result = await compareMatrix(
      args.benchmark as 'locomo' | 'longmemeval',
      args.dataPath,
      {
        consolidate: args.consolidate,
        topK: args.topK,
        limit: args.limit > 0 ? args.limit : undefined,
        ...(args.categories ? { categories: args.categories } : {}),
      },
      { requireGraph: args.requireGraph, commit, corpusSha256 },
    )

    for (const cell of result.cells) {
      console.log(
        `  graph=${cell.graph ? 'ON ' : 'OFF'} rerank=${cell.rerank ? 'ON ' : 'OFF'}` +
        `  graphEffect=${cell.graphEffect.toFixed(4)} (n=${cell.graphVisibleN})`,
      )
    }

    const gatesDir = path.resolve('./results/gates')
    await fs.mkdir(gatesDir, { recursive: true })
    const outFile = path.join(gatesDir, 'graph-eval-baseline.json')
    await fs.writeFile(outFile, JSON.stringify(result, null, 2), 'utf8')
    console.log(`\nMatrix baseline written to: ${outFile}`)
    console.log(`Provenance: commit=${commit.slice(0, 8)} corpus=${corpusSha256.slice(0, 12)} gate=${result.provenance.neo4jGateState}`)
    return
  }

  if (args.compare) {
    console.log('Running comparison mode...')
    let comparisonResult

    if (args.benchmark === 'locomo') {
      comparisonResult = await compareLoCoMo(args.dataPath, opts)
    } else if (args.benchmark === 'longmemeval') {
      comparisonResult = await compareLongMemEval(args.dataPath, opts)
    } else {
      console.error(`Unknown benchmark: ${args.benchmark}`)
      process.exit(1)
    }

    console.log(formatComparisonTable(comparisonResult))
    const outputFile = path.join(args.outputDir, `${args.benchmark}-comparison.json`)
    await fs.writeFile(outputFile, JSON.stringify(comparisonResult, null, 2), 'utf8')
    console.log(`\nResults written to: ${outputFile}`)
    return
  }

  if (args.benchmark === 'locomo') {
    const adapter = new LoCoMoAdapter()
    console.log('Ingesting and evaluating LoCoMo...')
    const result = await adapter.run(args.dataPath, opts)
    console.log(formatLoCoMoTable(result))

    const outputFile = path.join(args.outputDir, 'locomo-results.json')
    const evalFile = path.join(args.outputDir, 'locomo-eval.json')
    await fs.writeFile(outputFile, JSON.stringify(result, null, 2), 'utf8')
    await fs.writeFile(evalFile, JSON.stringify(result.evalFormat, null, 2), 'utf8')
    console.log(`\nFull results: ${outputFile}`)
    console.log(`Eval format:  ${evalFile}`)

  } else if (args.benchmark === 'longmemeval') {
    const adapter = new LongMemEvalAdapter()
    console.log('Ingesting and evaluating LongMemEval...')
    const result = await adapter.run(args.dataPath, opts)
    console.log(formatLongMemEvalTable(result))

    const outputFile = path.join(args.outputDir, 'longmemeval-results.json')
    const jsonlFile = path.join(args.outputDir, 'longmemeval-predictions.jsonl')
    await fs.writeFile(outputFile, JSON.stringify(result, null, 2), 'utf8')
    await fs.writeFile(jsonlFile, result.evalJsonl.map(r => JSON.stringify(r)).join('\n'), 'utf8')
    console.log(`\nFull results: ${outputFile}`)
    console.log(`JSONL for GPT-4o judge: ${jsonlFile}`)

  } else {
    console.error(`Unknown benchmark: ${args.benchmark}. Valid: locomo, longmemeval`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
