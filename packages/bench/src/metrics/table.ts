import type { LoCoMoResult, LongMemEvalResult, ComparisonResult } from '../types.js'

export function formatLoCoMoTable(result: LoCoMoResult): string {
  const lines: string[] = []
  lines.push('=== LoCoMo Benchmark Results (Retrieval F1) ===')
  lines.push('')
  lines.push('NOTE: This is RETRIEVAL F1 — how much gold text appears in recalled memories.')
  lines.push('      Published baselines use LLM-generated answers and will be higher.')
  lines.push('')
  lines.push(padRow(['Category', 'Questions', 'Retrieval F1', 'R@K']))
  lines.push(separator())

  const categoryNames: Record<number, string> = {
    1: 'Single-hop', 2: 'Multi-hop', 3: 'Temporal', 4: 'Commonsense', 5: 'Adversarial',
  }

  for (const cat of result.overall.byCategory) {
    lines.push(padRow([
      categoryNames[cat.category] ?? `Cat ${cat.category}`,
      String(cat.totalQuestions),
      (cat.averageRetrievalF1 * 100).toFixed(1) + '%',
      (cat.recallAtK * 100).toFixed(1) + '%',
    ]))
  }

  lines.push(separator())
  lines.push(padRow(['Overall', String(result.metrics.totalQueries),
    (result.overall.averageRetrievalF1 * 100).toFixed(1) + '%',
    (result.overall.recallAtK * 100).toFixed(1) + '%']))
  lines.push('')
  lines.push(`Ingest time:  ${result.metrics.ingestTimeMs.toLocaleString()}ms`)
  lines.push(`Eval time:    ${result.metrics.evalTimeMs.toLocaleString()}ms`)
  lines.push(`Tokens recalled: ${result.metrics.totalTokensRecalled.toLocaleString()}`)
  return lines.join('\n')
}

export function formatLongMemEvalTable(result: LongMemEvalResult): string {
  const lines: string[] = []
  lines.push('=== LongMemEval Benchmark Results ===')
  lines.push('')
  lines.push(padRow(['Ability', 'Questions', 'R@5', 'R@10']))
  lines.push(separator())

  for (const ab of result.overall.byAbility) {
    lines.push(padRow([ab.ability, String(ab.totalQuestions),
      (ab.recallAt5 * 100).toFixed(1) + '%', (ab.recallAt10 * 100).toFixed(1) + '%']))
  }

  lines.push(separator())
  lines.push(padRow(['Overall', String(result.metrics.totalQueries),
    (result.overall.recallAt5 * 100).toFixed(1) + '%', (result.overall.recallAt10 * 100).toFixed(1) + '%']))
  lines.push('')
  lines.push(`Ingest time: ${result.metrics.ingestTimeMs.toLocaleString()}ms`)
  lines.push(`Eval time:   ${result.metrics.evalTimeMs.toLocaleString()}ms`)
  return lines.join('\n')
}

export function formatComparisonTable(result: ComparisonResult): string {
  const lines: string[] = []
  lines.push(`=== ${result.benchmark.toUpperCase()} Comparison: Neo4j Graph ON vs OFF ===`)
  lines.push('')
  lines.push(padRow(['Metric', 'With Graph', 'Without Graph', 'Delta'], 20))
  lines.push(separator(4, 20))

  const wg = result.withGraph
  const wog = result.withoutGraph

  if (result.benchmark === 'locomo') {
    const wgL = wg as LoCoMoResult
    const wogL = wog as LoCoMoResult
    lines.push(padRow(['Retrieval F1',
      (wgL.overall.averageRetrievalF1 * 100).toFixed(1) + '%',
      (wogL.overall.averageRetrievalF1 * 100).toFixed(1) + '%',
      formatDelta(result.delta.primaryMetricDelta * 100, '%')], 20))
  } else {
    const wgE = wg as LongMemEvalResult
    const wogE = wog as LongMemEvalResult
    lines.push(padRow(['R@5',
      (wgE.overall.recallAt5 * 100).toFixed(1) + '%',
      (wogE.overall.recallAt5 * 100).toFixed(1) + '%',
      formatDelta(result.delta.primaryMetricDelta * 100, '%')], 20))
  }

  lines.push(padRow(['Ingest time',
    wg.metrics.ingestTimeMs.toLocaleString() + 'ms',
    wog.metrics.ingestTimeMs.toLocaleString() + 'ms',
    formatDelta(result.delta.ingestTimeDeltaMs, 'ms')], 20))
  lines.push(padRow(['Eval time',
    wg.metrics.evalTimeMs.toLocaleString() + 'ms',
    wog.metrics.evalTimeMs.toLocaleString() + 'ms',
    formatDelta(result.delta.evalTimeDeltaMs, 'ms')], 20))
  return lines.join('\n')
}

function padRow(cols: string[], width = 18): string {
  return cols.map(c => c.padEnd(width)).join(' | ')
}

function separator(cols = 4, width = 18): string {
  return Array(cols).fill('-'.repeat(width)).join('-+-')
}

function formatDelta(value: number, unit: string): string {
  const sign = value > 0 ? '+' : ''
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${sign}${formatted}${unit}`
}
