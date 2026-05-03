#!/usr/bin/env node
/**
 * recall-miss-anatomy — characterize the 185 recall-miss Qs to inform Phase 2.
 *
 * Free analysis. Reads:
 *   - results/forensics/recall-bottleneck.json (Phase 1.1 output)
 *   - results/failure-analysis.json (existing classification)
 *   - results/full-10conv/locomo-results.json (per-Q prediction strings)
 *   - data/locomo/data/locomo10.json (gold evidence dia_ids and source turns)
 *
 * For each recall_miss Q, computes:
 *   - failure subtype (WRONG_FACT, NO_INFO, PARTIAL, etc.)
 *   - gold-answer token overlap with retrieved prediction (did the model
 *     pick up the correct fact from a non-gold chunk?)
 *   - gold-evidence position in source conv (early session vs late)
 *   - gold-evidence length (short factual reply vs long elaboration)
 *   - gold-evidence speaker frequency in the conv (rare speaker vs dominant)
 *
 * Outputs results/forensics/recall-miss-anatomy.json + console summary.
 *
 * Usage:
 *   npx tsx packages/bench/src/locomo/forensics/recall-miss-anatomy.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

interface BottleneckClassification {
  conversation_id: string
  question: string
  category: number
  gold_answer: string
  generated_answer_snippet: string
  recallAtK: boolean | null
  classification: 'recall_miss' | 'ranking_miss' | 'unjoined'
}

interface BottleneckOutput {
  classifications: BottleneckClassification[]
}

interface FailureClassified {
  conv: string
  category: number
  type: 'CORRECT' | 'NO_INFO' | 'TEMPORAL_FORMAT' | 'PARTIAL' | 'JUDGE_SPLIT' | 'WRONG_FACT'
  question: string
  gold: string
  generated_snippet: string
  votes: boolean[]
  evidence?: string[]
}

interface FailureAnalysis {
  classified: FailureClassified[]
}

interface RetrievalQA {
  qaId: string
  question: string
  goldAnswer: string
  prediction: string
  retrievalF1: number
  recallAtK: boolean
  category: number
}

interface RetrievalConv {
  conversationId: string
  qaPredictions: RetrievalQA[]
}

interface RetrievalRun {
  conversations: RetrievalConv[]
}

interface Turn { dia_id: string; speaker: string; text: string }
interface LoCoMoQA { question: string; answer: string | number; evidence?: string[]; category?: number }
interface LoCoMoSample {
  sample_id: string
  conversation: Record<string, unknown>
  qa: LoCoMoQA[]
}

const BOTTLENECK_PATH = './results/forensics/recall-bottleneck.json'
const FAILURE_PATH = './results/failure-analysis.json'
const RETRIEVAL_PATH = './results/full-10conv/locomo-results.json'
const DATASET_PATH = './data/locomo/data/locomo10.json'
const OUTPUT_PATH = './results/forensics/recall-miss-anatomy.json'

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const bottleneck = readJson<BottleneckOutput>(BOTTLENECK_PATH)
  const failure = readJson<FailureAnalysis>(FAILURE_PATH)
  const retrieval = readJson<RetrievalRun>(RETRIEVAL_PATH)
  const dataset = readJson<LoCoMoSample[]>(DATASET_PATH)

  // Build indexes
  const failureByKey = new Map<string, FailureClassified>()
  for (const f of failure.classified) {
    failureByKey.set(joinKey(f.conv, f.question), f)
  }
  const retrievalByKey = new Map<string, RetrievalQA>()
  for (const conv of retrieval.conversations) {
    for (const qa of conv.qaPredictions) {
      retrievalByKey.set(joinKey(conv.conversationId, qa.question), qa)
    }
  }
  const turnsByConv = new Map<string, Map<string, Turn>>()
  const speakerCountByConv = new Map<string, Map<string, number>>()
  const totalTurnsByConv = new Map<string, number>()
  for (const sample of dataset) {
    const turns = new Map<string, Turn>()
    const speakers = new Map<string, number>()
    let total = 0
    for (const k of Object.keys(sample.conversation)) {
      const v = sample.conversation[k]
      if (Array.isArray(v)) {
        for (const t of v as Turn[]) {
          turns.set(t.dia_id, t)
          speakers.set(t.speaker, (speakers.get(t.speaker) ?? 0) + 1)
          total += 1
        }
      }
    }
    turnsByConv.set(sample.sample_id, turns)
    speakerCountByConv.set(sample.sample_id, speakers)
    totalTurnsByConv.set(sample.sample_id, total)
  }
  const qaEvidenceByKey = new Map<string, string[]>()
  for (const sample of dataset) {
    for (const qa of sample.qa) {
      qaEvidenceByKey.set(joinKey(sample.sample_id, qa.question), qa.evidence ?? [])
    }
  }

  const recallMisses = bottleneck.classifications.filter((c) => c.classification === 'recall_miss')

  const subtypeCounts: Record<string, number> = {}
  const goldInPredictionCounts = { hit: 0, miss: 0 }
  const evidencePositionBuckets = { early_third: 0, middle_third: 0, late_third: 0, unknown: 0 }
  const evidenceLengthBuckets = { short_lt_100: 0, medium_100_300: 0, long_gt_300: 0, unknown: 0 }
  const speakerRarityBuckets = { dominant_50pct: 0, balanced: 0, rare_lt_10pct: 0, unknown: 0 }
  const evidenceCountBuckets = { single: 0, multi_2: 0, multi_3plus: 0 }

  const samples: any[] = []

  for (const c of recallMisses) {
    const key = joinKey(c.conversation_id, c.question)
    const failureInfo = failureByKey.get(key)
    const retrievalInfo = retrievalByKey.get(key)
    const evidenceIds = qaEvidenceByKey.get(key) ?? []
    const turns = turnsByConv.get(c.conversation_id)
    const totalTurns = totalTurnsByConv.get(c.conversation_id) ?? 0
    const speakers = speakerCountByConv.get(c.conversation_id)

    // Subtype
    const subtype = failureInfo?.type ?? 'UNKNOWN'
    subtypeCounts[subtype] = (subtypeCounts[subtype] ?? 0) + 1

    // Gold-in-prediction (does retriever surface the answer text from non-gold chunk?)
    let goldInPrediction = false
    if (retrievalInfo) {
      const goldNorm = normalizeForMatch(c.gold_answer)
      const predNorm = normalizeForMatch(retrievalInfo.prediction)
      if (goldNorm.length > 0) {
        // Token-overlap fuzzy match: ≥60% of gold tokens appear in prediction
        const goldTokens = goldNorm.split(' ').filter((t) => t.length > 2)
        if (goldTokens.length > 0) {
          const matched = goldTokens.filter((t) => predNorm.includes(t)).length
          goldInPrediction = matched / goldTokens.length >= 0.6
        }
      }
    }
    if (goldInPrediction) goldInPredictionCounts.hit += 1
    else goldInPredictionCounts.miss += 1

    // Evidence-count distribution
    if (evidenceIds.length === 0) evidenceCountBuckets.single += 0
    else if (evidenceIds.length === 1) evidenceCountBuckets.single += 1
    else if (evidenceIds.length === 2) evidenceCountBuckets.multi_2 += 1
    else evidenceCountBuckets.multi_3plus += 1

    // Per-evidence analysis (use first evidence)
    const evTurns = evidenceIds.map((eid) => turns?.get(eid)).filter((t): t is Turn => !!t)
    if (evTurns.length > 0 && totalTurns > 0) {
      const firstEv = evTurns[0]!
      const turnPos = parseDiaPosition(firstEv.dia_id)
      const positionRatio = turnPos !== null ? turnPos / Math.max(1, totalTurns) : null
      if (positionRatio === null) evidencePositionBuckets.unknown += 1
      else if (positionRatio < 1 / 3) evidencePositionBuckets.early_third += 1
      else if (positionRatio < 2 / 3) evidencePositionBuckets.middle_third += 1
      else evidencePositionBuckets.late_third += 1

      const len = firstEv.text.length
      if (len < 100) evidenceLengthBuckets.short_lt_100 += 1
      else if (len < 300) evidenceLengthBuckets.medium_100_300 += 1
      else evidenceLengthBuckets.long_gt_300 += 1

      if (speakers) {
        const spkCount = speakers.get(firstEv.speaker) ?? 0
        const spkPct = spkCount / Math.max(1, totalTurns)
        if (spkPct >= 0.5) speakerRarityBuckets.dominant_50pct += 1
        else if (spkPct >= 0.1) speakerRarityBuckets.balanced += 1
        else speakerRarityBuckets.rare_lt_10pct += 1
      } else {
        speakerRarityBuckets.unknown += 1
      }
    } else {
      evidencePositionBuckets.unknown += 1
      evidenceLengthBuckets.unknown += 1
      speakerRarityBuckets.unknown += 1
    }

    if (samples.length < 8) {
      samples.push({
        conv: c.conversation_id,
        question: c.question,
        category: c.category,
        gold_answer: c.gold_answer,
        subtype,
        gold_in_prediction: goldInPrediction,
        evidence_ids: evidenceIds,
        evidence_turns: evTurns.map((t) => ({ id: t.dia_id, speaker: t.speaker, text_snippet: t.text.slice(0, 200) })),
        prediction_snippet: retrievalInfo?.prediction.slice(0, 240) ?? null,
      })
    }
  }

  const out = {
    meta: {
      total_recall_misses: recallMisses.length,
      generated_at: new Date().toISOString(),
    },
    subtype_distribution: subtypeCounts,
    gold_in_prediction: goldInPredictionCounts,
    evidence_position: evidencePositionBuckets,
    evidence_length: evidenceLengthBuckets,
    speaker_rarity: speakerRarityBuckets,
    evidence_count: evidenceCountBuckets,
    samples,
  }

  ensureDir(path.dirname(OUTPUT_PATH))
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2))
  console.log(`Wrote ${OUTPUT_PATH}`)
  console.log()
  console.log('═══ Recall-Miss Anatomy ═══')
  console.log(`Total recall_misses: ${recallMisses.length}`)
  console.log()
  console.log('Subtype distribution (which existing failure-analysis bucket they map to):')
  for (const [k, v] of Object.entries(subtypeCounts).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)} (${(v / recallMisses.length * 100).toFixed(1)}%)`)
  }
  console.log()
  console.log('Gold answer text appears in prediction string (≥60% token overlap):')
  console.log(`  HIT  ${goldInPredictionCounts.hit} (${(goldInPredictionCounts.hit / recallMisses.length * 100).toFixed(1)}%)  <- retriever surfaced answer from non-gold chunk; rerank/extraction issue, not pure recall`)
  console.log(`  MISS ${goldInPredictionCounts.miss} (${(goldInPredictionCounts.miss / recallMisses.length * 100).toFixed(1)}%)  <- retriever didn't bring back the fact at all; pure recall miss`)
  console.log()
  console.log('Gold evidence position in conv (first evidence turn):')
  for (const [k, v] of Object.entries(evidencePositionBuckets)) {
    console.log(`  ${k.padEnd(15)} ${String(v).padStart(4)} (${(v / recallMisses.length * 100).toFixed(1)}%)`)
  }
  console.log()
  console.log('Gold evidence length:')
  for (const [k, v] of Object.entries(evidenceLengthBuckets)) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)} (${(v / recallMisses.length * 100).toFixed(1)}%)`)
  }
  console.log()
  console.log('Gold evidence speaker rarity:')
  for (const [k, v] of Object.entries(speakerRarityBuckets)) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)} (${(v / recallMisses.length * 100).toFixed(1)}%)`)
  }
  console.log()
  console.log('Evidence count distribution:')
  for (const [k, v] of Object.entries(evidenceCountBuckets)) {
    console.log(`  ${k.padEnd(15)} ${String(v).padStart(4)} (${(v / recallMisses.length * 100).toFixed(1)}%)`)
  }
}

function joinKey(convId: string, q: string): string {
  return `${convId}::${q.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseDiaPosition(diaId: string): number | null {
  // "D1:3" → estimate ordinal position: prior segments + this turn idx
  // We don't have segment-length data here, so use segment+turn as a coarse proxy
  const m = diaId.match(/^D(\d+):(\d+)$/)
  if (!m) return null
  const seg = parseInt(m[1]!, 10)
  const turn = parseInt(m[2]!, 10)
  // Coarse weighting: assume ~30 turns per segment
  return (seg - 1) * 30 + turn
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}
