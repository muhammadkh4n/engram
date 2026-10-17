import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRecall, type RerankOptions } from '@engram-mem/core'
import { RecallLog, recallLogFromEnv } from '../src/recall-log.js'
import { buildRecallLogLineV2, type RecallLogLineV2 } from '../src/recall-route.js'
import { TST_T0, stubRecallDeps } from './recall-fixtures.js'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-recall-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A real v2 line for a recall on the stub deps, with the given query. */
async function lineFor(query: string): Promise<RecallLogLineV2> {
  const request = { query, channel: 'mcp' as const, scope: {} }
  const { response, trace } = await runRecall(stubRecallDeps(), request)
  return buildRecallLogLineV2(request, response, trace, 'tst-server', TST_T0)
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

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

describe('RecallLog.recordLine', () => {
  it('appends one line per call, in order, as written', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path)
    const first = await lineFor('tst deploy window')
    log.recordLine(first)
    log.recordLine(await lineFor('second'))
    await log.flush()
    const lines = readLines(path)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual(JSON.parse(JSON.stringify(first)))
    expect(lines[1]).toMatchObject({ v: 2, query: 'second', channel: 'mcp' })
  })

  it('carries the recall queue time in its timings', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path)
    const stub = stubRecallDeps()
    const deps = {
      ...stub,
      rerank: {
        id: stub.rerank.id,
        rerank: async (q: string, docs: ReadonlyArray<{ id: string; content: string }>, options?: RerankOptions) => {
          options?.onSettled?.({ waitMs: 9, runMs: 1, passes: docs.length })
          return stub.rerank.rerank(q, docs)
        },
      },
    }
    const request = { query: 'tst queue', channel: 'mcp' as const, scope: {} }
    const { response, trace } = await runRecall(deps, request)
    log.recordLine(buildRecallLogLineV2(request, response, trace, 'tst-server', TST_T0))
    await log.flush()

    expect(readLines(path)[0]).toMatchObject({ timings: { queue: 9 } })
  })

  it('creates the file owner-only', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path)
    log.recordLine(await lineFor('q'))
    await log.flush()
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('scrubs credentials out of the logged query', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const log = new RecallLog(path)
    log.recordLine(await lineFor('deploy with Authorization: Bearer Zq7madeupNotReal91xAbc now'))
    await log.flush()
    expect(readFileSync(path, 'utf8')).not.toContain('Zq7madeupNotReal91xAbc')
    expect(String(readLines(path)[0]?.['query'])).toMatch(/^deploy with .+ now$/)
  })

  it('rotates to <file>.1 at the size cap, keeping one', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    const line = await lineFor('query 0')
    const size = Buffer.byteLength(`${JSON.stringify(line)}\n`)
    const log = new RecallLog(path, { maxBytes: size * 2 + 10 })
    for (let i = 0; i < 6; i++) log.recordLine({ ...line, query: `query ${i}` })
    await log.flush()
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(false)
    expect(statSync(path).size).toBeLessThanOrEqual(size * 2 + 10)
    const current = readLines(path)
    expect(current[current.length - 1]?.['query']).toBe('query 5')
    expect(readLines(`${path}.1`).length + current.length).toBeLessThan(6)
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600)
  })

  it('never throws when a write fails, and warns once per minute', async () => {
    const path = join(freshDir(), 'is-a-dir')
    mkdirSync(path)
    const warnings: string[] = []
    let clock = Date.parse('2026-09-30T12:00:00.000Z')
    const log = new RecallLog(path, { warn: (m) => warnings.push(m), now: () => new Date(clock) })
    const line = await lineFor('q')
    expect(() => log.recordLine(line)).not.toThrow()
    log.recordLine(line)
    await log.flush()
    clock += 61_000
    log.recordLine(line)
    await log.flush()
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('recall log write')
  })

  it('appends to an existing file and tightens its mode', async () => {
    const path = join(freshDir(), 'recall.jsonl')
    writeFileSync(path, '{"old":true}\n', { mode: 0o644 })
    const log = new RecallLog(path)
    log.recordLine(await lineFor('q'))
    await log.flush()
    expect(readLines(path)).toHaveLength(2)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
