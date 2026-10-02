import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecallResult, RetrievedMemory } from '@engram-mem/core'
import { RecallLog, recallLogFromEnv } from '../src/recall-log.js'
import { runMemoryRecall } from '../src/server-core.js'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-recall-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function memory(id: string, type: RetrievedMemory['type'], source: RetrievedMemory['source'] = 'recall'): RetrievedMemory {
  return { id, type, content: `content of ${id}`, relevance: 0.5, source, metadata: {} }
}

const EP = memory('ep-1', 'episode')
const SEM = memory('sem-1', 'semantic')
const ASSOC = memory('proc-1', 'procedural', 'association')
const FAINT = memory('dig-1', 'digest', 'association')

function result(partial: Partial<RecallResult> = {}): RecallResult {
  return {
    memories: [EP, SEM],
    associations: [ASSOC],
    faintAssociations: [FAINT],
    primed: [],
    estimatedTokens: 40,
    formatted: '## Engram — Recalled Conversation Memory\n\n- [episode] content of ep-1',
    intent: { type: 'QUESTION', confidence: 1, strategy: {} } as unknown as RecallResult['intent'],
    timings: { total: 120, search: 80 },
    payload: {
      emittedMemories: 2,
      emittedAssociations: 1,
      emittedFaint: 1,
      truncated: false,
      items: [
        { section: 'recalled', id: 'sem-1', start: 0, end: 1 },
        { section: 'recalled', id: 'ep-1', start: 1, end: 2 },
        { section: 'related', id: 'proc-1', start: 2, end: 3 },
        { section: 'faint', id: 'dig-1', start: 3, end: 4 },
      ],
    },
    ...partial,
  }
}

function stubMemory(r: RecallResult) {
  return { recall: async () => r }
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

const FIXED_NOW = () => new Date('2026-09-30T12:00:00.000Z')

describe('recallLogFromEnv', () => {
  it('returns no log when ENGRAM_RECALL_LOG is unset or blank', () => {
    expect(recallLogFromEnv({})).toBeNull()
    expect(recallLogFromEnv({ ENGRAM_RECALL_LOG: '  ' })).toBeNull()
  })

  it('rejects a malformed size cap', () => {
    for (const v of ['0', '-1', 'abc']) {
      expect(() => recallLogFromEnv({ ENGRAM_RECALL_LOG: '/tmp/x.jsonl', ENGRAM_RECALL_LOG_MAX_MB: v })).toThrow(/ENGRAM_RECALL_LOG_MAX_MB/)
    }
  })

  it('opens the named file', () => {
    expect(recallLogFromEnv({ ENGRAM_RECALL_LOG: '/tmp/x.jsonl' })?.path).toBe('/tmp/x.jsonl')
  })
})

describe('runMemoryRecall with a recall log', () => {
  it('writes no file when ENGRAM_RECALL_LOG is unset', async () => {
    const dir = freshDir()
    const log = recallLogFromEnv({ ENGRAM_RECALL_LOG_MAX_MB: '1' })

    const res = await runMemoryRecall(stubMemory(result()), { query: 'deploy window' }, log)

    expect(log).toBeNull()
    expect(res.content[0]?.text).toBe(result().formatted)
    expect(readdirSync(dir)).toEqual([])
  })

  it('appends one line per recall with the scope and emitted ids in display order', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path, { now: FIXED_NOW })

    await runMemoryRecall(
      stubMemory(result()),
      { query: '  deploy window  ', project_id: ' engram ', session_id: 'sess-1', conversation_id: 'conv-1' },
      log,
    )
    await runMemoryRecall(stubMemory(result()), { query: 'second' }, log)
    await log.flush()

    const lines = readLines(path)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      ts: '2026-09-30T12:00:00.000Z',
      query: 'deploy window',
      project_id: 'engram',
      session_id: 'sess-1',
      conversation_id: 'conv-1',
      mode: 'QUESTION',
      emitted: [
        { id: 'sem-1', type: 'semantic', rank: 1 },
        { id: 'ep-1', type: 'episode', rank: 2 },
      ],
      associated: [
        { id: 'proc-1', type: 'procedural' },
        { id: 'dig-1', type: 'digest' },
      ],
      timings: { total: 120, search: 80 },
    })
    expect(lines[1]).toMatchObject({ query: 'second', project_id: null, session_id: null, conversation_id: null })
  })

  it('falls back to the result lists when no payload description is present', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path, { now: FIXED_NOW })

    await runMemoryRecall(stubMemory(result({ payload: undefined, timings: undefined })), { query: 'q' }, log)
    await log.flush()

    expect(readLines(path)[0]).toMatchObject({
      emitted: [
        { id: 'ep-1', type: 'episode', rank: 1 },
        { id: 'sem-1', type: 'semantic', rank: 2 },
      ],
      associated: [{ id: 'proc-1', type: 'procedural' }],
      timings: null,
    })
  })

  it('creates the file owner-only', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path)
    await runMemoryRecall(stubMemory(result()), { query: 'q' }, log)
    await log.flush()
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('scrubs credentials out of the logged query, not the recall', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path)
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    const seen: string[] = []
    const mem = { recall: async (q: string) => { seen.push(q); return result() } }

    await runMemoryRecall(mem, { query: `why does ${token} fail` }, log)
    await log.flush()

    expect(seen[0]).toContain(token)
    const logged = readFileSync(path, 'utf8')
    expect(logged).not.toContain(token)
    expect(String(readLines(path)[0]?.['query'])).toMatch(/^why does .+ fail$/)
  })

  it('rotates to <file>.1 at the size cap, keeping one', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path, { maxBytes: 600, now: FIXED_NOW })

    for (let i = 0; i < 6; i++) await runMemoryRecall(stubMemory(result()), { query: `query ${i}` }, log)
    await log.flush()

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(false)
    expect(statSync(path).size).toBeLessThanOrEqual(600)
    const current = readLines(path)
    const rotated = readLines(`${path}.1`)
    expect(current[current.length - 1]?.['query']).toBe('query 5')
    expect(rotated.length + current.length).toBeLessThan(6)
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600)
  })

  it('returns the recall when the write fails, and warns once per minute', async () => {
    const dir = freshDir()
    const path = join(dir, 'is-a-dir')
    mkdirSync(path)
    const warnings: string[] = []
    let clock = Date.parse('2026-09-30T12:00:00.000Z')
    const log = new RecallLog(path, { warn: (m) => warnings.push(m), now: () => new Date(clock) })
    const r = result()

    const first = await runMemoryRecall(stubMemory(r), { query: 'q' }, log)
    await runMemoryRecall(stubMemory(r), { query: 'q' }, log)
    await log.flush()
    clock += 61_000
    await runMemoryRecall(stubMemory(r), { query: 'q' }, log)
    await log.flush()

    expect(first).toEqual({ content: [{ type: 'text', text: r.formatted }] })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('recall log write')
  })

  it('appends to an existing file and tightens its mode', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    writeFileSync(path, '{"old":true}\n', { mode: 0o644 })
    const log = new RecallLog(path)
    await runMemoryRecall(stubMemory(result()), { query: 'q' }, log)
    await log.flush()
    expect(readLines(path)).toHaveLength(2)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
