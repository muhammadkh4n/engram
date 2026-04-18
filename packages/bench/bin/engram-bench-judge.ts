#!/usr/bin/env node
/**
 * engram-bench-judge — TrueMemory-protocol LoCoMo benchmark (LLM-judge).
 *
 * Usage:
 *   tsx packages/bench/bin/engram-bench-judge.ts \
 *     --data ./data/locomo/data/locomo10.json \
 *     --output ./results/engram_mem_v1_run1.json \
 *     [--smoke] [--no-consolidate] [--graph]
 *
 * Env: OPENAI_API_KEY
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { runLoCoMoJudgeBench } from '../src/locomo/judge-adapter.js'

interface CliArgs {
  data: string
  output: string
  smoke: boolean
  smokeQuestions?: number
  consolidate: boolean
  graph: boolean
  concurrency?: number
  checkpointPath?: string
  rerankerBackend?: 'openai' | 'onnx' | 'none'
  onnxRerankerModel?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--smoke') { args['smoke'] = true; continue }
    if (a === '--no-consolidate') { args['consolidate'] = false; continue }
    if (a === '--consolidate') { args['consolidate'] = true; continue }
    if (a === '--graph') { args['graph'] = true; continue }
    if (a === '--no-graph') { args['graph'] = false; continue }
    if (a.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1] ?? true
      i++
    }
  }
  if (!args['data']) { console.error('Error: --data is required'); process.exit(1) }

  const qFlag = args['smoke-questions']
  const smokeQuestions = typeof qFlag === 'string' ? parseInt(qFlag, 10) : undefined
  const concurrency = typeof args['concurrency'] === 'string'
    ? parseInt(args['concurrency'] as string, 10) : undefined
  const checkpointPath = typeof args['checkpoint'] === 'string'
    ? path.resolve(args['checkpoint'] as string) : undefined

  const rerankFlag = args['reranker']
  let rerankerBackend: 'openai' | 'onnx' | 'none' | undefined
  if (rerankFlag === 'openai' || rerankFlag === 'onnx' || rerankFlag === 'none') {
    rerankerBackend = rerankFlag
  } else if (rerankFlag !== undefined) {
    console.error(`Error: --reranker must be one of openai|onnx|none, got ${String(rerankFlag)}`)
    process.exit(1)
  }
  const onnxRerankerModel = typeof args['onnx-model'] === 'string'
    ? args['onnx-model'] as string : undefined

  return {
    data: path.resolve(args['data'] as string),
    output: path.resolve((args['output'] as string | undefined) ?? './results/engram_mem_v1_run1.json'),
    smoke: args['smoke'] === true,
    ...(smokeQuestions !== undefined ? { smokeQuestions } : {}),
    consolidate: args['consolidate'] !== false,
    graph: args['graph'] === true,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(checkpointPath !== undefined ? { checkpointPath } : {}),
    ...(rerankerBackend !== undefined ? { rerankerBackend } : {}),
    ...(onnxRerankerModel !== undefined ? { onnxRerankerModel } : {}),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await fs.mkdir(path.dirname(args.output), { recursive: true })

  const runOpts: {
    smoke: boolean
    consolidate: boolean
    graph: boolean
    smokeQuestions?: number
    concurrency?: number
    checkpointPath?: string
    rerankerBackend?: 'openai' | 'onnx' | 'none'
    onnxRerankerModel?: string
  } = {
    smoke: args.smoke,
    consolidate: args.consolidate,
    graph: args.graph,
  }
  if (args.smokeQuestions !== undefined) runOpts.smokeQuestions = args.smokeQuestions
  if (args.concurrency !== undefined) runOpts.concurrency = args.concurrency
  if (args.checkpointPath !== undefined) runOpts.checkpointPath = args.checkpointPath
  if (args.rerankerBackend !== undefined) runOpts.rerankerBackend = args.rerankerBackend
  if (args.onnxRerankerModel !== undefined) runOpts.onnxRerankerModel = args.onnxRerankerModel

  const result = await runLoCoMoJudgeBench(args.data, runOpts)

  await fs.writeFile(args.output, JSON.stringify(result, null, 2), 'utf8')
  console.log(`\nResults: ${args.output}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
