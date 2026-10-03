/**
 * Recorded model replies for recall evaluation. Chat replies are not
 * deterministic and embedding endpoints drift, so two runs of the same gold
 * set only measure the code under test when every model call recall makes is
 * answered from the same recording.
 *
 * Recall reaches these intelligence methods (retrieval/engine.ts,
 * retrieval/llm-step-cache.ts, memory.ts queryEmbedder, synthesis):
 *   - embedQuery, or embed when the adapter has no embedQuery: the query vector;
 *   - expandQuery: keyword variants, dated by `now`;
 *   - generateHypotheticalDoc, then embed on its document (HyDE);
 *   - rerank, when it is the base adapter's remote reranker (the local ONNX
 *     reranker replaces it after wrapping and runs live);
 *   - selectEvidence, on synthesized recalls.
 * dimensions and expansionReferenceDate are pure and pass through. Every
 * other method is an ingest or consolidation call: it throws and is counted.
 *
 * `fill` calls the model on a miss and records the reply; `strict` answers
 * from the recording and throws on a miss without calling anything. The
 * engine swallows expansion and HyDE errors, so callers check the stats after
 * every recall (assertPinsClean).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IntelligenceAdapter } from '@engram-mem/core'
import { parsePinsMode, sha256, type PinsMode } from '../replay/replay-lib.js'

export { parsePinsMode, type PinsMode }

export const PINNED_METHODS: ReadonlySet<string> = new Set([
  'embed',
  'embedQuery',
  'expandQuery',
  'generateHypotheticalDoc',
  'rerank',
  'selectEvidence',
])

const PASS_THROUGH: ReadonlySet<string> = new Set(['dimensions', 'expansionReferenceDate'])

/** Method name -> canonical JSON of the call's arguments -> recorded reply. */
export type PinTable = Record<string, Record<string, unknown>>

export interface PinStats {
  hits: number
  fills: number
  misses: Array<{ method: string; input: string }>
  /** Intelligence methods that are not recall calls. */
  blocked: Record<string, number>
  /** Fetches to an origin outside the allowlist, by origin (strict mode). */
  fetchBlocked: Record<string, number>
}

export class PinMissError extends Error {
  constructor(method: string) {
    super(`strict pins: no recorded ${method} reply for this input; refusing to call the model`)
    this.name = 'PinMissError'
  }
}

export class PinsViolationError extends Error {
  constructor(problems: string[]) {
    super(`pins: ${problems.join('; ')}`)
    this.name = 'PinsViolationError'
  }
}

// --- canonical keys and the file -------------------------------------------

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

/** JSON with object keys sorted at every level, so equal values serialise to equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** The exact input of a call: every argument, trailing undefined ones dropped. */
export function pinKey(args: readonly unknown[]): string {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return canonicalJson(args.slice(0, end))
}

export function pinTableSha(pins: PinTable): string {
  return sha256(canonicalJson(pins))
}

/** `{"sha256": <sha of the canonical table>, "pins": <table>}`; the sha is what a run records. */
export function serializePinFile(pins: PinTable): { text: string; sha: string } {
  const body = canonicalJson(pins)
  const sha = sha256(body)
  return { text: `{"sha256":${JSON.stringify(sha)},"pins":${body}}\n`, sha }
}

/** Parses a pins file and checks its body against the sha256 header. */
export function parsePinFile(text: string): { pins: PinTable; sha: string } {
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('pins file is not a JSON object')
  const { sha256: header, pins } = raw as { sha256?: unknown; pins?: unknown }
  if (typeof header !== 'string') throw new Error('pins file has no sha256 header')
  if (typeof pins !== 'object' || pins === null || Array.isArray(pins)) throw new Error('pins file has no pins object')
  const table: PinTable = {}
  for (const [method, bucket] of Object.entries(pins)) {
    if (!PINNED_METHODS.has(method)) throw new Error(`pins file records ${method}, which is not a pinned recall call`)
    if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) throw new Error(`pins for ${method} are not an object`)
    table[method] = { ...(bucket as Record<string, unknown>) }
  }
  const sha = pinTableSha(table)
  if (sha !== header) throw new Error(`pins file body has sha256 ${sha} but its header says ${header}; it was edited or truncated`)
  return { pins: table, sha }
}

// --- the wrapper ------------------------------------------------------------

export interface EvalPins {
  readonly mode: PinsMode
  readonly stats: PinStats
  /** Wraps an adapter so its recall calls go through the recording. */
  wrap(intel: IntelligenceAdapter): IntelligenceAdapter
  /** Saves pending fills and returns the sha256 of the recording. */
  flush(): string
}

export function createPins(initial: PinTable, mode: PinsMode, save: (text: string) => void = () => undefined): EvalPins {
  const pins: PinTable = Object.fromEntries(Object.entries(initial).map(([m, b]) => [m, { ...b }]))
  const stats: PinStats = { hits: 0, fills: 0, misses: [], blocked: {}, fetchBlocked: {} }
  let sha = pinTableSha(pins)
  let dirty = false

  const pinned = (method: string, call: (args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
    const key = pinKey(args)
    const bucket = (pins[method] ??= {})
    if (Object.prototype.hasOwnProperty.call(bucket, key)) {
      stats.hits++
      return structuredClone(bucket[key])
    }
    if (mode === 'strict') {
      stats.misses.push({ method, input: key.slice(0, 160) })
      throw new PinMissError(method)
    }
    const reply = canonicalize(await call(args))
    bucket[key] = reply
    stats.fills++
    dirty = true
    return structuredClone(reply)
  }

  const wrap = (intel: IntelligenceAdapter): IntelligenceAdapter => {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(intel)) {
      if (typeof value !== 'function' || PASS_THROUGH.has(name)) {
        out[name] = typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(intel) : value
      } else if (PINNED_METHODS.has(name)) {
        out[name] = pinned(name, (args) => (value as (...a: unknown[]) => Promise<unknown>).apply(intel, args))
      } else {
        out[name] = () => {
          stats.blocked[name] = (stats.blocked[name] ?? 0) + 1
          throw new Error(`pins: intelligence.${name} is not a recall call; blocked`)
        }
      }
    }
    return out as IntelligenceAdapter
  }

  const flush = (): string => {
    if (!dirty) return sha
    const file = serializePinFile(pins)
    save(file.text)
    sha = file.sha
    dirty = false
    return sha
  }

  return { mode, stats, wrap, flush }
}

/**
 * Opens a pins file. In fill mode a missing file starts an empty recording
 * and flush writes it (via a temp file and rename); strict mode needs the file.
 */
export function openPins(file: string, mode: PinsMode): EvalPins {
  const exists = fs.existsSync(file)
  if (!exists && mode === 'strict') throw new Error(`strict pins need an existing pins file; ${file} does not exist`)
  const initial = exists ? parsePinFile(fs.readFileSync(file, 'utf8')).pins : {}
  return createPins(initial, mode, (text) => {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  })
}

/** Throws when a strict miss, a blocked method or a blocked fetch happened, even if the engine swallowed the error. */
export function assertPinsClean(pins: EvalPins): void {
  const { misses, blocked, fetchBlocked } = pins.stats
  const problems: string[] = []
  if (misses.length > 0) problems.push(`${misses.length} strict miss(es): ${misses.map((m) => m.method).join(', ')}`)
  if (Object.keys(blocked).length > 0) problems.push(`blocked intelligence calls ${JSON.stringify(blocked)}`)
  if (Object.keys(fetchBlocked).length > 0) problems.push(`blocked fetches ${JSON.stringify(fetchBlocked)}`)
  if (problems.length > 0) throw new PinsViolationError(problems)
}

// --- the fetch guard ----------------------------------------------------------

const HF_HOSTS = /(^|\.)(huggingface\.co|hf\.co|xethub\.hf\.co)$/

function requestUrl(input: unknown): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL((input as { url: string }).url)
}

/**
 * Replaces globalThis.fetch so only `allowOrigins` (the storage endpoint) and
 * Hugging Face hosts (the local reranker's model files) are reachable; any
 * other origin, a model API among them, is counted in `stats.fetchBlocked` and
 * rejected. Install it before the clients are built: the OpenAI and PostgREST
 * clients capture fetch when they are constructed. Returns the restore function.
 */
export function installFetchGuard(
  allowOrigins: readonly string[],
  stats: Pick<PinStats, 'fetchBlocked'>,
  target: { fetch: typeof fetch } = globalThis,
): () => void {
  const orig = target.fetch
  const allow = new Set(allowOrigins)
  target.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = requestUrl(input)
    if (allow.has(u.origin) || (u.protocol === 'https:' && HF_HOSTS.test(u.hostname))) return orig(input, init)
    stats.fetchBlocked[u.origin] = (stats.fetchBlocked[u.origin] ?? 0) + 1
    return Promise.reject(new Error(`pins: fetch to ${u.origin} blocked in strict mode`))
  }) as typeof fetch
  return () => {
    target.fetch = orig
  }
}
