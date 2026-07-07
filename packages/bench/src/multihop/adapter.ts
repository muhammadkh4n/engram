import * as fs from 'node:fs/promises'
import type { Memory } from '@engram-mem/core'
import type { BenchScoredMemory } from '../merge-associations.js'
import type {
  MultiHopDataset,
  MultiHopItem,
  MultiHopParagraph,
} from './types.js'

/**
 * Dataset loading + ingest for the multi-hop distribution (distractor
 * setting — see types.ts for why per-question paragraph bags, not a pooled
 * corpus).
 *
 * Two source shapes are parsed:
 *   - MuSiQue-Ans (`*.jsonl`, one item per line): paragraphs carry
 *     `is_supporting`, and `question_decomposition[].paragraph_support_idx`
 *     labels the hop order — this is the only dataset here whose bridge
 *     (hop > 1) metric is computable.
 *   - HotpotQA-distractor / 2WikiMultiHopQA (`*.json`, a single array):
 *     paragraph-level support is derived from `supporting_facts` titles.
 *     No hop labels → bridge-recall reports not-applicable.
 */

interface MusiqueRawParagraph {
  idx: number
  title: string
  paragraph_text: string
  is_supporting: boolean
}

interface MusiqueRawItem {
  id: string
  question: string
  answer: string
  answer_aliases?: string[]
  answerable?: boolean
  paragraphs: MusiqueRawParagraph[]
  question_decomposition?: Array<{ paragraph_support_idx: number | null }>
}

interface HotpotRawItem {
  _id: string
  question: string
  answer: string
  supporting_facts: Array<[string, number]>
  context: Array<[string, string[]]>
}

export async function loadMultiHopDataset(
  dataPath: string,
  dataset: MultiHopDataset,
): Promise<MultiHopItem[]> {
  const raw = await fs.readFile(dataPath, 'utf8')
  return dataset === 'musique' ? parseMusique(raw) : parseHotpotStyle(raw, dataset)
}

function parseMusique(raw: string): MultiHopItem[] {
  const items: MultiHopItem[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const r = JSON.parse(trimmed) as MusiqueRawItem
    // MuSiQue-Full mixes in unanswerable variants; MuSiQue-Ans marks
    // everything answerable (or omits the flag). Skip unanswerables — a gold
    // set that isn't in the bag can't be retrieved.
    if (r.answerable === false) continue

    // Hop position = 1-based index of the decomposition step this paragraph
    // supports. A paragraph supporting several steps takes the earliest.
    const hopByIdx = new Map<number, number>()
    r.question_decomposition?.forEach((step, i) => {
      const idx = step.paragraph_support_idx
      if (idx !== null && idx !== undefined && !hopByIdx.has(idx)) {
        hopByIdx.set(idx, i + 1)
      }
    })

    const paragraphs: MultiHopParagraph[] = r.paragraphs.map((p) => ({
      idx: p.idx,
      title: p.title,
      text: p.paragraph_text,
      isSupporting: p.is_supporting,
      ...(p.is_supporting && hopByIdx.has(p.idx)
        ? { hop: hopByIdx.get(p.idx)! }
        : {}),
    }))

    items.push({
      id: r.id,
      question: r.question,
      answer: r.answer,
      answerAliases: r.answer_aliases ?? [],
      paragraphs,
      dataset: 'musique',
    })
  }
  return items
}

function parseHotpotStyle(raw: string, dataset: MultiHopDataset): MultiHopItem[] {
  const rows = JSON.parse(raw) as HotpotRawItem[]
  return rows.map((r) => {
    const supportingTitles = new Set(r.supporting_facts.map(([title]) => title))
    const paragraphs: MultiHopParagraph[] = r.context.map(
      ([title, sentences], idx) => ({
        idx,
        title,
        text: sentences.join(''),
        isSupporting: supportingTitles.has(title),
      }),
    )
    return {
      id: r._id,
      question: r.question,
      answer: r.answer,
      answerAliases: [],
      paragraphs,
      dataset,
    }
  })
}

/**
 * Ingest one item's paragraph bag into a fresh Memory as a single batch
 * (amortizes the embedding round-trips, mirroring the LongMemEval adapter).
 * Each paragraph is tagged with `metadata.mhParagraphIdx` so recall results
 * map back to the gold supporting set. Gold labels are deliberately NOT
 * written into metadata — nothing retrievable should encode the answer key.
 */
export async function ingestItem(
  item: MultiHopItem,
  memory: Memory,
): Promise<{ paragraphsIngested: number }> {
  const batch = item.paragraphs
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({
      role: 'user' as const,
      content: `${p.title}\n${p.text.trim()}`,
      sessionId: `mh:${item.id}`,
      metadata: {
        mhItemId: item.id,
        mhParagraphIdx: p.idx,
        mhTitle: p.title,
      },
    }))
  await memory.ingestBatch(batch)
  return { paragraphsIngested: batch.length }
}

/**
 * Map a ranked memory list back to paragraph idxs, deduped in rank order.
 * Memories without the tag (e.g. consolidation-derived rows, if consolidation
 * was enabled) are skipped — they have no paragraph identity to score.
 */
export function retrievedParagraphIdxs(
  memories: readonly BenchScoredMemory[],
): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const m of memories) {
    const idx = m.metadata?.['mhParagraphIdx']
    if (typeof idx !== 'number' || seen.has(idx)) continue
    seen.add(idx)
    out.push(idx)
  }
  return out
}
