/**
 * Sequential replay of a window of logged recalls and captured episodes
 * against a writable copy of the store.
 *
 * Single-shot benches build a fresh store per question and recall without
 * reconsolidation, so they cannot see an effect that builds over a sequence
 * of recalls (access counts, co-recall edges, priming). Replay re-runs real
 * recall traffic in time order with reconsolidation on, inserting the
 * episodes that arrived in between as rows with their stored embeddings, so
 * ingest is identical across arms and no model is called for it.
 *
 * Everything here is pure or takes its I/O as arguments; replay.ts wires it
 * to the arm's engram dist and the target PostgREST.
 */

import { createHash } from 'node:crypto'
import type { ExpandQueryOpts, IntelligenceAdapter, MemoryType } from '@engram-mem/core'
import { expansionKey } from '../expansion-key.js'

// --- window ---------------------------------------------------------------

export interface WindowEpisode {
  kind: 'episode'
  id: string
  session_id: string
  project_id: string | null
  role: string
  content: string
  /** pgvector text or a number array, sent to PostgREST as stored. */
  embedding: number[] | string | null
  metadata: Record<string, unknown>
  created_at: string
  salience?: number
  entities?: string[]
}

export interface WindowRecall {
  kind: 'recall'
  ts: string
  query: string
  project_id: string | null
  session_id: string | null
  conversation_id: string | null
}

export type WindowEvent = WindowEpisode | WindowRecall

export interface ReplayEvent {
  /** Position in replay order; the step number of the step log. */
  step: number
  at: number
  event: WindowEvent
}

function requireString(obj: Record<string, unknown>, key: string, line: number): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`window line ${line}: ${key} must be a non-empty string`)
  return v
}

function optionalString(obj: Record<string, unknown>, key: string, line: number): string | null {
  const v = obj[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new Error(`window line ${line}: ${key} must be a string or null`)
  return v
}

function parseTime(value: string, key: string, line: number): number {
  const at = Date.parse(value)
  if (Number.isNaN(at)) throw new Error(`window line ${line}: ${key} is not a timestamp: ${JSON.stringify(value)}`)
  return at
}

function requireContent(obj: Record<string, unknown>, line: number): string {
  const v = obj['content']
  if (typeof v !== 'string') throw new Error(`window line ${line}: content must be a string`)
  return v
}

function parseEpisode(obj: Record<string, unknown>, line: number): WindowEpisode {
  const embedding = obj['embedding']
  const embeddingOk =
    embedding === undefined ||
    embedding === null ||
    typeof embedding === 'string' ||
    (Array.isArray(embedding) && embedding.every((n) => typeof n === 'number'))
  if (!embeddingOk) throw new Error(`window line ${line}: embedding must be a number array, a vector string or null`)
  const metadata = obj['metadata'] ?? {}
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error(`window line ${line}: metadata must be an object`)
  }
  const salience = obj['salience']
  if (salience !== undefined && typeof salience !== 'number') throw new Error(`window line ${line}: salience must be a number`)
  const entities = obj['entities']
  if (entities !== undefined && !(Array.isArray(entities) && entities.every((e) => typeof e === 'string'))) {
    throw new Error(`window line ${line}: entities must be a string array`)
  }
  return {
    kind: 'episode',
    id: requireString(obj, 'id', line),
    session_id: requireString(obj, 'session_id', line),
    project_id: optionalString(obj, 'project_id', line),
    role: requireString(obj, 'role', line),
    content: requireContent(obj, line),
    embedding: (embedding ?? null) as WindowEpisode['embedding'],
    metadata: metadata as Record<string, unknown>,
    created_at: requireString(obj, 'created_at', line),
    ...(salience !== undefined ? { salience } : {}),
    ...(entities !== undefined ? { entities: entities as string[] } : {}),
  }
}

function parseRecall(obj: Record<string, unknown>, line: number): WindowRecall {
  const query = requireString(obj, 'query', line)
  if (query.trim().length === 0) throw new Error(`window line ${line}: query is blank`)
  return {
    kind: 'recall',
    ts: requireString(obj, 'ts', line),
    query,
    project_id: optionalString(obj, 'project_id', line),
    session_id: optionalString(obj, 'session_id', line),
    conversation_id: optionalString(obj, 'conversation_id', line),
  }
}

/**
 * Window JSONL → events in replay order: by time (episode `created_at`,
 * recall `ts`), ties in file order. Blank lines are skipped; anything else
 * malformed is an error naming its line.
 */
export function parseWindow(text: string): ReplayEvent[] {
  const parsed: Array<{ at: number; index: number; event: WindowEvent }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim()
    if (raw.length === 0) continue
    const lineNo = i + 1
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      throw new Error(`window line ${lineNo}: not JSON`)
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error(`window line ${lineNo}: not an object`)
    const rec = obj as Record<string, unknown>
    if (rec['kind'] === 'episode') {
      const event = parseEpisode(rec, lineNo)
      parsed.push({ at: parseTime(event.created_at, 'created_at', lineNo), index: parsed.length, event })
    } else if (rec['kind'] === 'recall') {
      const event = parseRecall(rec, lineNo)
      parsed.push({ at: parseTime(event.ts, 'ts', lineNo), index: parsed.length, event })
    } else {
      throw new Error(`window line ${lineNo}: kind must be "episode" or "recall"`)
    }
  }
  const ordered = [...parsed].sort((a, b) => a.at - b.at || a.index - b.index)
  return ordered.map((p, step) => ({ step, at: p.at, event: p.event }))
}

// --- conversation keys ----------------------------------------------------

export type ConversationKeyMode = 'logged' | 'sessionize' | 'none'
export const CONVERSATION_KEY_MODES: readonly ConversationKeyMode[] = ['logged', 'sessionize', 'none']

/** Clients send no conversation id today, so `sessionize` approximates one:
 *  recalls of one project with no gap longer than this are one conversation. */
export const SESSIONIZE_GAP_MS = 30 * 60 * 1000

/** The conversation key for every recall step (absent = no key sent). */
export function conversationKeys(events: readonly ReplayEvent[], mode: ConversationKeyMode): Map<number, string> {
  const keys = new Map<number, string>()
  if (mode === 'none') return keys
  const last = new Map<string, { at: number; n: number }>()
  for (const e of events) {
    if (e.event.kind !== 'recall') continue
    if (mode === 'logged') {
      if (e.event.conversation_id) keys.set(e.step, e.event.conversation_id)
      continue
    }
    const project = e.event.project_id ?? ''
    const prev = last.get(project)
    const n = prev && e.at - prev.at <= SESSIONIZE_GAP_MS ? prev.n : (prev?.n ?? 0) + 1
    last.set(project, { at: e.at, n })
    keys.set(e.step, `sessionize:${project || '-'}:${n}`)
  }
  return keys
}

// --- copy guards ----------------------------------------------------------

export const COPY_MARKER_TABLE = 'engram_replay_copy'
const PROD_POSTGREST_PORT = '3001'

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/**
 * Refuses a target that can be prod: the prod PostgREST listens on loopback
 * port 3001 on its host (and is reached on that port through a tunnel), and
 * any host named rexvps is the prod box.
 */
export function assertTargetNotProd(target: string): URL {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error(`--target is not a URL: ${target}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`--target must be http(s): ${target}`)
  if (isLoopback(url.hostname) && url.port === PROD_POSTGREST_PORT) {
    throw new Error(`--target ${url.host} is the prod PostgREST address; replay writes and runs only against a copy`)
  }
  if (/rexvps/i.test(url.hostname)) {
    throw new Error(`--target host ${url.hostname} is the prod host; replay runs only against a copy`)
  }
  return url
}

export type MarkerRead = { rows: Array<Record<string, unknown>> } | { error: string }

/**
 * The target must carry the marker table with one row whose `arm` is this
 * arm: prod never has the table, and each arm writes to its own copy.
 */
export function assertCopyMarker(read: MarkerRead, arm: string): void {
  if ('error' in read) {
    throw new Error(`target has no readable ${COPY_MARKER_TABLE} table (${read.error}); refusing: only a marked copy may be replayed into`)
  }
  if (read.rows.length !== 1) {
    throw new Error(`${COPY_MARKER_TABLE} must hold exactly one row, found ${read.rows.length}`)
  }
  const markerArm = read.rows[0]!['arm']
  if (markerArm !== arm) {
    throw new Error(`${COPY_MARKER_TABLE}.arm is ${JSON.stringify(markerArm)}, this arm is ${JSON.stringify(arm)}; each arm needs its own copy`)
  }
}

// --- pins -----------------------------------------------------------------

export type PinsMode = 'fill' | 'strict'

/** One bucket per memoised method, keyed by input text. */
export interface PinsData {
  expand: Record<string, unknown>
  hyde: Record<string, unknown>
  embed: Record<string, unknown>
  embedQuery: Record<string, unknown>
}

export const NO_PINS_FILE_SHA = 'none'

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function parsePins(text: string | null): PinsData {
  const pins: PinsData = { expand: {}, hyde: {}, embed: {}, embedQuery: {} }
  if (text === null) return pins
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('pins file is not a JSON object')
  for (const [bucket, value] of Object.entries(raw)) {
    if (!(bucket in pins)) throw new Error(`pins file has an unknown bucket ${bucket}`)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`pins bucket ${bucket} is not an object`)
    pins[bucket as keyof PinsData] = { ...(value as Record<string, unknown>) }
  }
  return pins
}

export interface PinStats {
  hits: number
  fills: number
  /** `now` is the reference date of a dated expansion miss. */
  misses: Array<{ bucket: keyof PinsData; text: string; now?: string }>
  blocked: Record<string, number>
}

export interface Pins {
  wrap(intel: IntelligenceAdapter): IntelligenceAdapter
  stats: PinStats
  /** Writes pending fills (fill mode) and returns the pins file's sha256. */
  flush(): string
}

const PINNED_METHODS: Record<string, keyof PinsData> = {
  expandQuery: 'expand',
  generateHypotheticalDoc: 'hyde',
  embed: 'embed',
  embedQuery: 'embedQuery',
}
/** Not model calls: the wrapper passes them through. `rerank` is replaced by
 *  the local reranker after wrapping. */
const PASS_THROUGH = new Set(['dimensions', 'rerank'])

/**
 * Memoises the recall-time model calls per input text so every arm sees the
 * same expansion, HyDE document and vectors (chat replies are not
 * deterministic). Expansion is keyed by text plus reference date and its
 * options are forwarded, so a pins file written with text-only keys still
 * serves calls that carry no date. `fill` calls the model on a miss and records it; `strict`
 * throws on a miss without calling anything. Every other model method throws
 * and is counted, so no ingest-side or chat call can run unseen. The engine
 * swallows expansion and HyDE errors, so callers check `stats` after each
 * recall.
 */
export function createPins(
  initial: PinsData,
  initialSha: string,
  mode: PinsMode,
  save: (json: string) => void,
): Pins {
  const pins: PinsData = {
    expand: { ...initial.expand },
    hyde: { ...initial.hyde },
    embed: { ...initial.embed },
    embedQuery: { ...initial.embedQuery },
  }
  const stats: PinStats = { hits: 0, fills: 0, misses: [], blocked: {} }
  let dirty = false
  let currentSha = initialSha

  const memo = (bucket: keyof PinsData, fn: (...args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
    const text = args[0] as string
    const opts = bucket === 'expand' ? (args[1] as ExpandQueryOpts | undefined) : undefined
    const key = expansionKey(text, opts)
    const store = pins[bucket]
    if (Object.prototype.hasOwnProperty.call(store, key)) {
      stats.hits++
      return structuredClone(store[key])
    }
    if (mode === 'strict') {
      stats.misses.push({ bucket, text: text.slice(0, 120), ...(key !== text ? { now: opts!.now!.toISOString() } : {}) })
      throw new Error(`strict pins: no pinned ${bucket} for this text; refusing to call the model`)
    }
    const out = await fn(...args)
    store[key] = out
    stats.fills++
    dirty = true
    return structuredClone(out)
  }

  const wrap = (intel: IntelligenceAdapter): IntelligenceAdapter => {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(intel)) {
      if (typeof value !== 'function' || PASS_THROUGH.has(name)) {
        out[name] = value
        continue
      }
      const bucket = PINNED_METHODS[name]
      if (bucket) {
        out[name] = memo(bucket, (...args) => (value as (...a: unknown[]) => Promise<unknown>).apply(intel, args))
        continue
      }
      out[name] = () => {
        stats.blocked[name] = (stats.blocked[name] ?? 0) + 1
        throw new Error(`replay: intelligence.${name} is not a pinned recall call; blocked`)
      }
    }
    return out as IntelligenceAdapter
  }

  const flush = (): string => {
    if (!dirty) return currentSha
    const json = JSON.stringify(pins)
    save(json)
    currentSha = sha256(json)
    dirty = false
    return currentSha
  }

  return { wrap, stats, flush }
}

// --- arm env --------------------------------------------------------------

export function parseEnvAssignment(raw: string): [string, string] {
  const eq = raw.indexOf('=')
  if (eq <= 0) throw new Error(`--env expects K=V, got ${JSON.stringify(raw)}`)
  const key = raw.slice(0, eq)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`--env key is not a variable name: ${key}`)
  return [key, raw.slice(eq + 1)]
}

/**
 * Runs `fn` with the arm's variables set in `env`, then puts every variable
 * back as it was (deleted when it was unset), whatever `fn` does. The engine
 * reads its switches per recall, so this switches exactly the wrapped call.
 */
export async function withEnv<T>(
  vars: Readonly<Record<string, string>>,
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const saved = Object.keys(vars).map((k) => [k, Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined] as const)
  for (const [k, v] of Object.entries(vars)) env[k] = v
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
  }
}

// --- arguments ------------------------------------------------------------

export interface ReplayArgs {
  window: string
  target: string
  keyEnv: string
  engramDist: string
  arm: string
  env: Record<string, string>
  conversationKey: ConversationKeyMode
  pins: string
  pinsMode: PinsMode
  out: string
}

const VALUE_FLAGS = new Set([
  '--window', '--target', '--key-env', '--engram-dist', '--arm', '--env', '--conversation-key', '--pins', '--pins-mode', '--out',
])

export interface ParsedFlags {
  one: Record<string, string>
  env: Record<string, string>
}

/**
 * `--flag value` pairs: every flag takes a value, `--env K=V` repeats, any
 * other flag may appear once, and each of `required` must be present.
 */
export function parseFlagValues(
  argv: readonly string[],
  flags: ReadonlySet<string>,
  required: readonly string[],
): ParsedFlags {
  const one: Record<string, string> = {}
  const env: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (!flags.has(flag)) throw new Error(`unknown flag ${flag}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    if (flag === '--env') {
      const [k, v] = parseEnvAssignment(value)
      if (k in env) throw new Error(`--env sets ${k} twice`)
      env[k] = v
      continue
    }
    if (flag in one) throw new Error(`${flag} given twice`)
    one[flag] = value
  }
  for (const r of required) {
    if (!one[r]) throw new Error(`${r} is required`)
  }
  return { one, env }
}

export function parsePinsMode(raw: string | undefined): PinsMode {
  const pinsMode = (raw ?? 'fill') as PinsMode
  if (pinsMode !== 'fill' && pinsMode !== 'strict') throw new Error('--pins-mode must be fill or strict')
  return pinsMode
}

export function assertArmName(arm: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(arm)) throw new Error('--arm may hold only letters, digits, ".", "_" and "-"')
}

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const { one, env } = parseFlagValues(argv, VALUE_FLAGS, [
    '--window', '--target', '--key-env', '--engram-dist', '--arm', '--pins', '--out',
  ])
  const conversationKey = (one['--conversation-key'] ?? 'none') as ConversationKeyMode
  if (!CONVERSATION_KEY_MODES.includes(conversationKey)) {
    throw new Error(`--conversation-key must be one of ${CONVERSATION_KEY_MODES.join('|')}`)
  }
  const pinsMode = parsePinsMode(one['--pins-mode'])
  assertArmName(one['--arm']!)
  return {
    window: one['--window']!,
    target: one['--target']!,
    keyEnv: one['--key-env']!,
    engramDist: one['--engram-dist']!,
    arm: one['--arm']!,
    env,
    conversationKey,
    pins: one['--pins']!,
    pinsMode,
    out: one['--out']!,
  }
}

// --- run identity and resume ----------------------------------------------

export interface ReplayIdentity {
  arm: string
  target: string
  engram_dist: string
  env: Record<string, string>
  conversation_key: ConversationKeyMode
  window_sha256: string
  pins_path: string
  pins_mode: PinsMode
}

export function identityDiff(a: ReplayIdentity, b: ReplayIdentity): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ReplayIdentity>
  const canon = (v: unknown) =>
    JSON.stringify(v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y))) : v)
  return [...keys].filter((k) => canon(a[k]) !== canon(b[k]))
}

/**
 * Where a run resumes. No step log (or an empty one) starts at 0. Otherwise
 * the recorded identity must equal this run's and the pins file must be the
 * one the last step left, or the run is refused: a resumed arm that changed
 * its dist, env, window or pins would mix two arms in one log.
 */
export function resumeStep(opts: {
  stepsText: string | null
  recorded: ReplayIdentity | null
  identity: ReplayIdentity
  pinsSha: string
}): number {
  const lines = (opts.stepsText ?? '').split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return 0
  if (!opts.recorded) throw new Error('step log exists but run-meta.json has no identity; refusing to resume')
  const diff = identityDiff(opts.recorded, opts.identity)
  if (diff.length > 0) {
    throw new Error(`refusing to resume: this run differs from the logged one in ${diff.join(', ')}`)
  }
  const steps = lines.map((l, i) => {
    try {
      return JSON.parse(l) as StepLine
    } catch {
      throw new Error(`step log line ${i + 1} is not JSON (a torn write); refusing to resume`)
    }
  })
  steps.forEach((s, i) => {
    if (s.step !== i) throw new Error(`step log line ${i + 1} is step ${s.step}; expected ${i}`)
  })
  const last = steps[steps.length - 1]!
  if (last.pins_sha256 !== opts.pinsSha) {
    throw new Error(`refusing to resume: the pins file changed since step ${last.step} (sha ${opts.pinsSha}, logged ${last.pins_sha256})`)
  }
  return last.step + 1
}

// --- the replay loop ------------------------------------------------------

/** The columns an episode row carries; absent optional fields take the
 *  table's defaults, as an ingested row would. */
export interface EpisodeRow {
  id: string
  session_id: string
  role: string
  content: string
  embedding: number[] | string | null
  metadata: Record<string, unknown>
  project_id: string | null
  created_at: string
  salience?: number
  entities?: string[]
}

export function episodeRow(e: WindowEpisode): EpisodeRow {
  return {
    id: e.id,
    session_id: e.session_id,
    role: e.role,
    content: e.content,
    embedding: e.embedding,
    metadata: e.metadata,
    project_id: e.project_id,
    created_at: e.created_at,
    ...(e.salience !== undefined ? { salience: e.salience } : {}),
    ...(e.entities !== undefined ? { entities: e.entities } : {}),
  }
}

export interface ReplayRecallOptions {
  projectId?: string
  conversationKey?: string
  reconsolidate: true
  /** The logged recall's own time, as the server passes the request time. */
  now: Date
}

interface RecallMemoryLike {
  id: string
  type: MemoryType
}

export interface ReplayRecallResult {
  memories: RecallMemoryLike[]
  associations: RecallMemoryLike[]
  faintAssociations?: RecallMemoryLike[]
  payload?: { items: Array<{ section: string; id?: string }> }
  timings?: Record<string, number>
  degraded?: unknown
}

export interface StepLine {
  step: number
  at: string
  kind: 'episode' | 'recall'
  pins_sha256: string
  /** episode steps */
  id?: string
  inserted?: boolean
  embedding?: 'stored' | 'null'
  /** recall steps */
  query_id?: string
  project_id?: string | null
  conversation_key?: string | null
  emitted?: Array<{ id: string; tier: MemoryType | null; rank: number }>
  associated?: Array<{ id: string; tier: MemoryType | null; section: string }>
  timings?: Record<string, number> | null
  degraded?: unknown
  wall_ms?: number
}

/** Ids in the order the payload displayed them: the recalled section is
 *  ranked, every other section is associated context. */
export function displayedIds(result: ReplayRecallResult): Pick<StepLine, 'emitted' | 'associated'> {
  const all = [...result.memories, ...result.associations, ...(result.faintAssociations ?? [])]
  const tierOf = new Map(all.map((m) => [m.id, m.type] as const))
  const items = result.payload?.items
  if (!items) {
    return {
      emitted: result.memories.map((m, i) => ({ id: m.id, tier: m.type, rank: i + 1 })),
      associated: result.associations.map((m) => ({ id: m.id, tier: m.type, section: 'associations' })),
    }
  }
  const emitted: NonNullable<StepLine['emitted']> = []
  const associated: NonNullable<StepLine['associated']> = []
  for (const item of items) {
    if (!item.id) continue
    const tier = tierOf.get(item.id) ?? null
    if (item.section === 'recalled') emitted.push({ id: item.id, tier, rank: emitted.length + 1 })
    else associated.push({ id: item.id, tier, section: item.section })
  }
  return { emitted, associated }
}

export interface ReplayDeps {
  events: readonly ReplayEvent[]
  keys: ReadonlyMap<number, string>
  startStep: number
  insertEpisode(row: EpisodeRow): Promise<'inserted' | 'present'>
  recall(query: string, opts: ReplayRecallOptions): Promise<ReplayRecallResult>
  /** Wraps each recall: the arm's env is set for that call only. */
  aroundRecall<T>(fn: () => Promise<T>): Promise<T>
  /** Problems that must stop the run, checked after every recall. */
  violations(): string[]
  /** Flushes the pins and returns their sha256 for the step line. */
  pinsSha(): string
  writeStep(line: StepLine): void
  clock?: () => number
}

export interface ReplayCounts {
  episodesInserted: number
  episodesPresent: number
  nullEmbeddings: number
  recalls: number
}

export class ReplayStopped extends Error {
  constructor(readonly step: number, readonly reasons: string[]) {
    super(`replay stopped at step ${step}: ${reasons.join('; ')}`)
    this.name = 'ReplayStopped'
  }
}

export async function runReplay(deps: ReplayDeps): Promise<ReplayCounts> {
  const clock = deps.clock ?? (() => performance.now())
  const counts: ReplayCounts = { episodesInserted: 0, episodesPresent: 0, nullEmbeddings: 0, recalls: 0 }
  let recallOrdinal = 0
  for (const e of deps.events) {
    const isRecall = e.event.kind === 'recall'
    if (e.step < deps.startStep) {
      if (isRecall) recallOrdinal++
      continue
    }
    const at = new Date(e.at).toISOString()
    if (e.event.kind === 'episode') {
      const row = episodeRow(e.event)
      const outcome = await deps.insertEpisode(row)
      if (outcome === 'inserted') counts.episodesInserted++
      else counts.episodesPresent++
      if (row.embedding === null) counts.nullEmbeddings++
      deps.writeStep({
        step: e.step, at, kind: 'episode', pins_sha256: deps.pinsSha(),
        id: row.id, inserted: outcome === 'inserted', embedding: row.embedding === null ? 'null' : 'stored',
      })
      continue
    }
    const recall = e.event
    const key = deps.keys.get(e.step)
    const opts: ReplayRecallOptions = {
      ...(recall.project_id ? { projectId: recall.project_id } : {}),
      ...(key !== undefined ? { conversationKey: key } : {}),
      reconsolidate: true,
      now: new Date(e.at),
    }
    const t0 = clock()
    const result = await deps.aroundRecall(() => deps.recall(recall.query.trim(), opts))
    const wallMs = Math.round(clock() - t0)
    counts.recalls++
    const reasons = deps.violations()
    if (reasons.length > 0) throw new ReplayStopped(e.step, reasons)
    deps.writeStep({
      step: e.step, at, kind: 'recall', pins_sha256: deps.pinsSha(),
      query_id: `r${recallOrdinal}`,
      project_id: recall.project_id,
      conversation_key: key ?? null,
      ...displayedIds(result),
      timings: result.timings ?? null,
      degraded: result.degraded ?? null,
      wall_ms: wallMs,
    })
    recallOrdinal++
  }
  return counts
}
