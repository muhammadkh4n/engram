import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  loadMultiHopDataset,
  retrievedParagraphIdxs,
} from '../src/multihop/adapter.js'
import type { BenchScoredMemory } from '../src/merge-associations.js'

async function tmpFile(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mh-adapter-'))
  const p = path.join(dir, name)
  await fs.writeFile(p, content)
  return p
}

const MUSIQUE_LINE = JSON.stringify({
  id: '2hop__1_2',
  question: 'Who directed the film that starred X?',
  answer: 'Y',
  answer_aliases: ['Y.'],
  answerable: true,
  paragraphs: [
    { idx: 0, title: 'Distractor', paragraph_text: 'Nothing here.', is_supporting: false },
    { idx: 1, title: 'Film', paragraph_text: 'X starred in Film F.', is_supporting: true },
    { idx: 2, title: 'Director', paragraph_text: 'Film F was directed by Y.', is_supporting: true },
  ],
  question_decomposition: [
    { paragraph_support_idx: 1 },
    { paragraph_support_idx: 2 },
  ],
})

const MUSIQUE_UNANSWERABLE = JSON.stringify({
  id: '2hop__unans',
  question: 'q',
  answer: 'a',
  answerable: false,
  paragraphs: [],
  question_decomposition: [],
})

describe('loadMultiHopDataset — musique', () => {
  it('parses jsonl, labels hops from the decomposition, skips unanswerables', async () => {
    const p = await tmpFile('dev.jsonl', `${MUSIQUE_LINE}\n${MUSIQUE_UNANSWERABLE}\n\n`)
    const items = await loadMultiHopDataset(p, 'musique')

    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.dataset).toBe('musique')
    expect(item.answerAliases).toEqual(['Y.'])

    const byIdx = new Map(item.paragraphs.map((x) => [x.idx, x]))
    expect(byIdx.get(0)!.isSupporting).toBe(false)
    expect(byIdx.get(0)!.hop).toBeUndefined()
    expect(byIdx.get(1)!.hop).toBe(1)
    // idx 2 supports decomposition step 2 → the bridge paragraph.
    expect(byIdx.get(2)!.hop).toBe(2)
  })
})

describe('loadMultiHopDataset — hotpotqa shape', () => {
  it('derives paragraph support from supporting_facts titles, no hop labels', async () => {
    const p = await tmpFile(
      'dev.json',
      JSON.stringify([
        {
          _id: 'h1',
          question: 'q?',
          answer: 'a',
          supporting_facts: [
            ['Gold A', 0],
            ['Gold B', 2],
          ],
          context: [
            ['Gold A', ['Sentence 1.', ' Sentence 2.']],
            ['Distractor', ['Noise.']],
            ['Gold B', ['Bridge fact.']],
          ],
        },
      ]),
    )
    const items = await loadMultiHopDataset(p, 'hotpotqa')

    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.paragraphs.map((x) => x.isSupporting)).toEqual([true, false, true])
    expect(item.paragraphs[0]!.text).toBe('Sentence 1. Sentence 2.')
    expect(item.paragraphs.every((x) => x.hop === undefined)).toBe(true)
  })
})

describe('retrievedParagraphIdxs', () => {
  const mem = (id: string, idx: number | undefined, relevance = 0.5): BenchScoredMemory =>
    ({
      id,
      type: 'episode',
      content: 'c',
      relevance,
      metadata: idx === undefined ? {} : { mhParagraphIdx: idx },
    }) as unknown as BenchScoredMemory

  it('maps to idxs in rank order, deduping and skipping untagged rows', () => {
    const idxs = retrievedParagraphIdxs([
      mem('a', 2),
      mem('b', undefined), // consolidation-derived row — no paragraph identity
      mem('c', 0),
      mem('d', 2), // duplicate paragraph
      mem('e', 7),
    ])
    expect(idxs).toEqual([2, 0, 7])
  })
})
