import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_FUSION_CONFIG,
  FUSION_ENV_VAR,
  resolveFusionConfig,
  validateFusionOverride,
  type FusionConfig,
} from '../../src/retrieval/fusion-config.js'
import { recall } from '../../src/retrieval/engine.js'
import type { RecallOpts } from '../../src/retrieval/engine.js'
import { classifyQuery } from '../../src/retrieval/query-classifier.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import { createMockStorage, MOCK_EPISODE } from './mock-storage.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { RecallStrategy, SearchResult, TypedMemory } from '../../src/types.js'

describe('resolveFusionConfig', () => {
  it('returns the defaults with no override and no env', () => {
    expect(resolveFusionConfig(undefined, {})).toEqual(DEFAULT_FUSION_CONFIG)
    expect(resolveFusionConfig({}, { [FUSION_ENV_VAR]: '' })).toEqual(DEFAULT_FUSION_CONFIG)
  })

  it('keeps the values the scoring code used before the config existed', () => {
    expect(DEFAULT_FUSION_CONFIG).toEqual({
      lexicalWeight: 0.15,
      lexicalCandidateFactor: 5,
      vectorCandidateFactor: 4,
      recencyDecayHours: 720,
      accessBoostPerAccess: 0.01,
      accessBoostCap: 0.1,
      assistantRoleBoost: 0.05,
      recallFailurePenalty: 0.4,
      lexicalReserveShare: 0.5,
      hydeTopScoreBelow: 0.3,
      patternTopScoreBelow: 0.2,
      rrfK: 60,
      rerankWeight: 0.7,
      rerankWeightMultiHop: 0.85,
    })
    expect(Object.isFrozen(DEFAULT_FUSION_CONFIG)).toBe(true)
  })

  it('applies env keys over the defaults and per-call keys over the env, key by key', () => {
    const env = { [FUSION_ENV_VAR]: JSON.stringify({ lexicalWeight: 0.3, rrfK: 10 }) }
    expect(resolveFusionConfig(undefined, env)).toEqual({ ...DEFAULT_FUSION_CONFIG, lexicalWeight: 0.3, rrfK: 10 })
    expect(resolveFusionConfig({ lexicalWeight: 0.05, rerankWeight: 0.5 }, env)).toEqual({
      ...DEFAULT_FUSION_CONFIG, lexicalWeight: 0.05, rrfK: 10, rerankWeight: 0.5,
    })
  })

  it('treats a per-call key set to undefined as absent', () => {
    const env = { [FUSION_ENV_VAR]: JSON.stringify({ lexicalWeight: 0.3 }) }
    expect(resolveFusionConfig({ lexicalWeight: undefined }, env).lexicalWeight).toBe(0.3)
  })

  it('accepts the range boundaries', () => {
    expect(() => validateFusionOverride({
      lexicalWeight: 0, rerankWeight: 1, rerankWeightMultiHop: 0, recallFailurePenalty: 1,
      hydeTopScoreBelow: 0, patternTopScoreBelow: 3, rrfK: 0, recencyDecayHours: 0.5, lexicalCandidateFactor: 1,
    }, 'test')).not.toThrow()
  })

  describe('validation', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['an unknown key', { lexicalWieght: 0.2 }, /unknown fusion key "lexicalWieght"/],
      ['a prototype key', JSON.parse('{"__proto__": 1}'), /unknown fusion key "__proto__"/],
      ['a string value', { rrfK: '60' }, /"rrfK" must be a finite number/],
      ['a null value', { rerankWeight: null }, /"rerankWeight" must be a finite number/],
      ['a non-finite value', { recencyDecayHours: Infinity }, /"recencyDecayHours" must be a finite number/],
      ['NaN', { accessBoostCap: NaN }, /"accessBoostCap" must be a finite number/],
      ['a weight above 1', { lexicalWeight: 1.01 }, /"lexicalWeight" must be in \[0, 1\]/],
      ['a negative weight', { assistantRoleBoost: -0.1 }, /"assistantRoleBoost" must be in \[0, 1\]/],
      ['a rerank weight above 1', { rerankWeightMultiHop: 1.2 }, /"rerankWeightMultiHop" must be in \[0, 1\]/],
      ['a zero half-life', { recencyDecayHours: 0 }, /"recencyDecayHours" must be greater than 0/],
      ['a negative trigger', { hydeTopScoreBelow: -0.1 }, /"hydeTopScoreBelow" must be at least 0/],
      ['a fractional candidate factor', { lexicalCandidateFactor: 2.5 }, /"lexicalCandidateFactor" must be an integer of at least 1/],
      ['a zero candidate factor', { vectorCandidateFactor: 0 }, /"vectorCandidateFactor" must be an integer of at least 1/],
      ['an array', [0.1], /must be a JSON object/],
      ['null', null, /must be a JSON object/],
    ]
    for (const [label, value, pattern] of cases) {
      it(`rejects ${label}`, () => {
        expect(() => validateFusionOverride(value, 'strategy.fusion')).toThrow(pattern)
      })
    }

    it('names the env var for an invalid env value', () => {
      expect(() => resolveFusionConfig(undefined, { [FUSION_ENV_VAR]: '{"rrfK": -1}' }))
        .toThrow(/ENGRAM_RECALL_FUSION: fusion key "rrfK" must be at least 0/)
      expect(() => resolveFusionConfig(undefined, { [FUSION_ENV_VAR]: '{lexicalWeight: 0.2}' }))
        .toThrow(/ENGRAM_RECALL_FUSION: not valid JSON/)
      expect(() => resolveFusionConfig(undefined, { [FUSION_ENV_VAR]: '0.2' }))
        .toThrow(/ENGRAM_RECALL_FUSION: fusion config must be a JSON object/)
    })

    it('names strategy.fusion for an invalid per-call value', () => {
      expect(() => resolveFusionConfig({ rerankWeight: 2 }, {})).toThrow(/strategy\.fusion: fusion key "rerankWeight"/)
    })
  })
})

describe('recall — fusion config', () => {
  const NAMES = [FUSION_ENV_VAR, 'ENGRAM_MMR_PRE_RERANK', 'ENGRAM_RECALL_HUB_DAMPING', 'ENGRAM_RECALL_SEMANTIC_CONFIDENCE'] as const
  const original = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]))
  const NOW = new Date('2026-06-01T12:00:00Z')
  const createdAt = new Date(NOW.getTime() - 24 * 3_600_000)

  beforeEach(() => {
    for (const n of NAMES) delete process.env[n]
    // MMR reorders the slate before the reranker; off, the rerank input is
    // exactly the fused slate.
    process.env['ENGRAM_MMR_PRE_RERANK'] = 'false'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const n of NAMES) {
      if (original[n] === undefined) delete process.env[n]
      else process.env[n] = original[n]
    }
  })

  function episode(id: string, content: string, embedding: number[] | null = null): TypedMemory {
    return { type: 'episode', data: { ...MOCK_EPISODE, id, content, accessCount: 0, createdAt, embedding } }
  }

  const STRONG: SearchResult<TypedMemory>[] = [
    { item: episode('a', 'billing worker deploy uses a blue-green switch'), similarity: 0.8 },
    { item: episode('b', 'deploy notes for the export worker'), similarity: 0.7 },
  ]
  // Sixty days old, so the recency term stays small and the top score
  // (about 0.15) is under the default HyDE trigger.
  const WEAK: SearchResult<TypedMemory>[] = [
    { item: { type: 'episode', data: { ...MOCK_EPISODE, id: 'weak', content: 'vaguely related memory', accessCount: 0, createdAt: new Date(NOW.getTime() - 60 * 24 * 3_600_000) } }, similarity: 0.1 },
  ]

  function strategy(fusion?: Partial<FusionConfig>, base: RecallStrategy = RECALL_STRATEGIES.light): RecallStrategy {
    return fusion === undefined ? base : { ...base, fusion }
  }

  function opts(over: Partial<RecallOpts> = {}): RecallOpts {
    return { strategy: RECALL_STRATEGIES.light, embedding: [0.1, 0.2, 0.3], reconsolidate: false, ...over }
  }

  function hydeIntelligence() {
    return {
      generateHypotheticalDoc: vi.fn().mockResolvedValue('a hypothetical deploy note'),
      embed: vi.fn().mockResolvedValue([0.3, 0.2, 0.1]),
    }
  }

  describe('hydeTopScoreBelow', () => {
    it('fires HyDE on a strong top score once the threshold is above it', async () => {
      const off = hydeIntelligence()
      await recall('billing worker deploy', createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({ intelligence: off }))
      expect(off.generateHypotheticalDoc).not.toHaveBeenCalled()

      const on = hydeIntelligence()
      await recall('billing worker deploy', createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({
        intelligence: on, strategy: strategy({ hydeTopScoreBelow: 2 }),
      }))
      expect(on.generateHypotheticalDoc).toHaveBeenCalledOnce()
    })

    it('stops HyDE on a weak top score once the threshold is 0', async () => {
      const on = hydeIntelligence()
      await recall('billing worker deploy', createMockStorage({ vectorSearchResults: WEAK, textBoostResults: [] }), new SensoryBuffer(), opts({ intelligence: on }))
      expect(on.generateHypotheticalDoc).toHaveBeenCalledOnce()

      const off = hydeIntelligence()
      await recall('billing worker deploy', createMockStorage({ vectorSearchResults: WEAK, textBoostResults: [] }), new SensoryBuffer(), opts({
        intelligence: off, strategy: strategy({ hydeTopScoreBelow: 0 }),
      }))
      expect(off.generateHypotheticalDoc).not.toHaveBeenCalled()
    })
  })

  describe('rrfK', () => {
    // The mock storage answers the direct and the HyDE search with the same
    // list, so the top memory is rank 0 in both: 2 / (k + 1).
    async function topRelevance(fusion?: Partial<FusionConfig>): Promise<number> {
      const result = await recall('billing worker deploy', createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({
        intelligence: hydeIntelligence(), strategy: strategy({ hydeTopScoreBelow: 2, ...fusion }),
      }))
      return result.memories[0]!.relevance
    }

    it('sets k of the HyDE rank fusion', async () => {
      expect(await topRelevance()).toBeCloseTo(2 / 61, 12)
      expect(await topRelevance({ rrfK: 10 })).toBeCloseTo(2 / 11, 12)
    })
  })

  describe('patternTopScoreBelow', () => {
    function graph(): GraphPort {
      return {
        findMatchingContextNodes: vi.fn().mockResolvedValue([]),
        spreadActivation: vi.fn().mockResolvedValue([]),
      } as unknown as GraphPort
    }

    it('fires pattern completion on a strong top score once the threshold is above it', async () => {
      const query = 'remember the billing worker deploy'
      const off = graph()
      await recall(query, createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({ graph: off }))
      expect(off.findMatchingContextNodes).not.toHaveBeenCalled()

      const on = graph()
      await recall(query, createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({
        graph: on, strategy: strategy({ patternTopScoreBelow: 5 }),
      }))
      expect(on.findMatchingContextNodes).toHaveBeenCalledOnce()
    })
  })

  describe('rerank blend', () => {
    const RERANK: Record<string, number> = { a: 0.2, b: 0.9 }
    const rerankIntelligence = (): IntelligenceAdapter => ({
      rerank: vi.fn(async (_q: string, docs: ReadonlyArray<{ id: string }>) => docs.map((d) => ({ id: d.id, score: RERANK[d.id]! }))),
    })

    async function blended(query: string, fusion?: Partial<FusionConfig>) {
      const fused = await recall(query, createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({
        strategy: strategy(fusion),
      }))
      const reranked = await recall(query, createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({
        intelligence: rerankIntelligence(), strategy: strategy(fusion),
      }))
      return {
        fused: new Map(fused.memories.map((m) => [m.id, m.relevance])),
        reranked: new Map(reranked.memories.map((m) => [m.id, m.relevance])),
      }
    }

    const SINGLE_HOP = 'billing worker deploy'
    const TEMPORAL = 'billing worker deploy last week'

    it('classifies the two fixture queries as intended', () => {
      expect(classifyQuery(SINGLE_HOP)).toMatchObject({ multiHop: false, temporal: false })
      expect(classifyQuery(TEMPORAL).temporal).toBe(true)
    })

    for (const [query, key, defaultWeight, other] of [
      [SINGLE_HOP, 'rerankWeight', 0.7, 'rerankWeightMultiHop'],
      [TEMPORAL, 'rerankWeightMultiHop', 0.85, 'rerankWeight'],
    ] as const) {
      it(`${key} sets the reranker share for its query class and ${other} does not`, async () => {
        const base = await blended(query)
        for (const id of ['a', 'b']) {
          expect(base.reranked.get(id)).toBeCloseTo(RERANK[id]! * defaultWeight + base.fused.get(id)! * (1 - defaultWeight), 12)
        }

        const moved = await blended(query, { [key]: 0.25 })
        for (const id of ['a', 'b']) {
          expect(moved.reranked.get(id)).toBeCloseTo(RERANK[id]! * 0.25 + moved.fused.get(id)! * 0.75, 12)
        }

        const untouched = await blended(query, { [other]: 0.25 })
        expect(untouched.reranked).toEqual(base.reranked)
      })
    }
  })

  describe('lexicalReserveShare', () => {
    const LEXICAL_ONLY = ['lex-1', 'lex-2', 'lex-3', 'lex-4']

    function reserveStorage() {
      const storage = createMockStorage({
        vectorSearchResults: STRONG,
        textBoostResults: LEXICAL_ONLY.map((id, i) => ({ id, type: 'episode' as const, boost: 1 - i * 0.1 })),
      })
      const rows = new Map(LEXICAL_ONLY.map((id) => [id, episode(id, `exact term ${id}`)]))
      storage.getByIds = vi.fn(async (refs: Array<{ id: string }>) => refs.flatMap((r) => rows.get(r.id) ?? []))
      return storage
    }

    async function rerankInputSize(fusion?: Partial<FusionConfig>): Promise<number> {
      const rerank = vi.fn(async (_q: string, docs: ReadonlyArray<{ id: string }>) => docs.map((d, i) => ({ id: d.id, score: 1 - i * 0.01 })))
      await recall('billing worker deploy', reserveStorage(), new SensoryBuffer(), opts({
        intelligence: { rerank }, strategy: strategy(fusion, { ...RECALL_STRATEGIES.light, maxResults: 2 }),
      }))
      return rerank.mock.calls[0]![1].length
    }

    it('sizes the lexical reserve the reranker sees', async () => {
      expect(await rerankInputSize()).toBe(3)
      expect(await rerankInputSize({ lexicalReserveShare: 1 })).toBe(4)
      expect(await rerankInputSize({ lexicalReserveShare: 0 })).toBe(2)
    })
  })

  describe('sources', () => {
    it('reads ENGRAM_RECALL_FUSION per call and lets a per-call key win over it', async () => {
      process.env[FUSION_ENV_VAR] = JSON.stringify({ hydeTopScoreBelow: 2 })
      const fromEnv = hydeIntelligence()
      await recall('billing worker deploy', createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({ intelligence: fromEnv }))
      expect(fromEnv.generateHypotheticalDoc).toHaveBeenCalledOnce()

      const callWins = hydeIntelligence()
      await recall('billing worker deploy', createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({
        intelligence: callWins, strategy: strategy({ hydeTopScoreBelow: 0.3 }),
      }))
      expect(callWins.generateHypotheticalDoc).not.toHaveBeenCalled()

      delete process.env[FUSION_ENV_VAR]
      const unset = hydeIntelligence()
      await recall('billing worker deploy', createMockStorage({ vectorSearchResults: STRONG, textBoostResults: [] }), new SensoryBuffer(), opts({ intelligence: unset }))
      expect(unset.generateHypotheticalDoc).not.toHaveBeenCalled()
    })

    it('fails before searching on an invalid env or per-call value', async () => {
      process.env[FUSION_ENV_VAR] = '{"rerankWeight": 1.5}'
      const storage = createMockStorage()
      await expect(recall('billing worker deploy', storage, new SensoryBuffer(), opts())).rejects.toThrow(/rerankWeight/)
      delete process.env[FUSION_ENV_VAR]
      await expect(recall('billing worker deploy', storage, new SensoryBuffer(), opts({ strategy: strategy({ rrfK: -1 }) })))
        .rejects.toThrow(/rrfK/)
      expect(storage.vectorSearch).not.toHaveBeenCalled()
    })

    it('returns byte-identical output with defaults however they are given', async () => {
      const intelligence = (): IntelligenceAdapter => ({
        ...hydeIntelligence(),
        rerank: vi.fn(async (_q: string, docs: ReadonlyArray<{ id: string }>) => docs.map((d, i) => ({ id: d.id, score: 0.9 - i * 0.1 }))),
      })
      const run = async (s?: RecallStrategy) => {
        const result = await recall('what did we decide about strict mode last week', createMockStorage(), new SensoryBuffer(), opts({
          intelligence: intelligence(), ...(s ? { strategy: s } : {}),
        }))
        return JSON.stringify({ memories: result.memories, associations: result.associations, formatted: result.formatted })
      }
      const baseline = await run()
      expect(JSON.parse(baseline).memories.length).toBeGreaterThan(1)

      expect(await run(strategy({}))).toBe(baseline)
      expect(await run(strategy({ ...DEFAULT_FUSION_CONFIG }))).toBe(baseline)
      process.env[FUSION_ENV_VAR] = '{}'
      expect(await run()).toBe(baseline)
      process.env[FUSION_ENV_VAR] = JSON.stringify(DEFAULT_FUSION_CONFIG)
      expect(await run()).toBe(baseline)
    })
  })
})
