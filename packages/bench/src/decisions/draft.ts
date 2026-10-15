/**
 * Drafts decision cases from the records that found them: the uninformed-decision
 * incidents, the fact-checked real prompts and the memory-miss table. Every
 * draft has status `draft`; review sets lanes, phrases and channels before any
 * run, and a draft is never scored.
 *
 * Record text is copied into drafts verbatim and never printed: the report
 * carries ids, refs and counts only.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  LANES,
  QUERY_TEXT_MAX,
  type CaseAudit,
  type DecisionCase,
  type HarmfulMemory,
  type Lane,
  type NeededMemory,
  type PhraseGroups,
  type TranscriptRef,
} from './cases.js'

/** The longest MK line a fact ref turns into a proposed phrase group. */
export const PHRASE_LINE_MAX = 300

const BRIEFING_VERDICTS_TO_DRAFT: ReadonlySet<string> = new Set(['harmful', 'misleading'])
const INCIDENT_FACT_FIELDS: ReadonlySet<string> = new Set(['fact_location', 'missing_fact'])
const CLI_TEXT_PREFIXES = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<command-',
  '[Request interrupted',
]

/**
 * A transcript ref: `<session id or 8-hex prefix>:L<n>`, the same with a
 * `.jsonl` suffix and a directory in front, or a bare `L<n>` that points into
 * the record's own decision transcript.
 */
const TRANSCRIPT_REF_RE =
  /(?:\/[^\s:'"`]*\/)?([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)(?:\.jsonl)?:L(\d+)|(?<![A-Za-z0-9_:./-])L(\d+)(?![A-Za-z0-9_])/g
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OFFSET_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

export type ClassLanes = Readonly<Record<string, Lane>>

export interface FactcheckInput {
  /** The fact-checked prompts, one JSON object per line. */
  cases: string
  /** The judges' output files, one JSON object per line each. */
  judgements: readonly string[]
  /** Ids of recalled items a judge marked stale or wrong. */
  markedBad: readonly string[]
}

export interface DraftInput {
  incidents?: string
  classLanes?: ClassLanes
  factcheck?: FactcheckInput
  misses?: string
  /** Claude Code's projects directory: `<dir>/<project>/<session id>.jsonl`. */
  projectsDir: string
  /** The fact-check count the audit gave; a different count is reported, never forced. */
  expectFactcheck?: number
}

export interface UnresolvedRef {
  draft_id: string
  field: string
  ref: string
  reason: string
}

export interface PossibleDuplicate {
  miss_id: string
  date: string
  incident_ids: string[]
}

export interface DraftReport {
  counts: { incidents: number; factcheck: number; misses: number; drafts: number }
  factcheck_skipped: number
  factcheck_expected: number | null
  orphan_judgements: number
  unresolved: UnresolvedRef[]
  possible_duplicates: PossibleDuplicate[]
}

export interface DraftResult {
  drafts: DecisionCase[]
  report: DraftReport
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function jsonLines(text: string, label: string): Json[] {
  return text.split('\n').flatMap((line, i) => {
    if (line.trim() === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`${label} line ${i + 1}: not valid JSON`)
    }
    if (!isRecord(parsed)) throw new Error(`${label} line ${i + 1}: expected a JSON object`)
    return [parsed]
  })
}

function isOffsetTime(value: unknown): value is string {
  return typeof value === 'string' && OFFSET_TIME_RE.test(value) && !Number.isNaN(Date.parse(value))
}

/** A class-to-lane map: `{"<class code or label>": "<lane>"}`. */
export function parseClassLanes(text: string): ClassLanes {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('class-lanes file is not valid JSON')
  }
  if (!isRecord(parsed)) throw new Error('class-lanes file must be a JSON object')
  const lanes: Record<string, Lane> = {}
  for (const [key, lane] of Object.entries(parsed)) {
    if (key.trim() === '') throw new Error('class-lanes file has an empty class')
    if (typeof lane !== 'string' || !(LANES as readonly string[]).includes(lane)) {
      throw new Error(`class-lanes ${key} must map to one of ${LANES.join(', ')}`)
    }
    lanes[key] = lane as Lane
  }
  return lanes
}

/** The lane a class maps to: an exact key, or the longest key the class starts with as a word. */
export function proposeLane(classLanes: ClassLanes, cls: string | undefined): Lane {
  if (cls === undefined) return 'none'
  const exact = classLanes[cls]
  if (exact !== undefined) return exact
  const prefixes = Object.keys(classLanes)
    .filter((key) => cls.startsWith(`${key} `))
    .sort((a, b) => b.length - a.length)
  return prefixes.length > 0 ? classLanes[prefixes[0]!]! : 'none'
}

/** A text over the query limit as its first and last halves, never splitting a surrogate pair. */
export function cutQueryText(text: string): string {
  if (text.length <= QUERY_TEXT_MAX) return text
  const half = QUERY_TEXT_MAX / 2
  let head = text.slice(0, half)
  let tail = text.slice(text.length - half)
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1)
  return head + tail
}

// ── Transcripts ──────────────────────────────────────────────────────────

interface FoundRef {
  text: string
  /** A session id or its 8-hex prefix; null for a bare `L<n>`. */
  session: string | null
  line: number
}

export function findTranscriptRefs(text: string): FoundRef[] {
  return [...text.matchAll(TRANSCRIPT_REF_RE)].map((m) =>
    m[1] !== undefined
      ? { text: m[0], session: m[1], line: Number(m[2]) }
      : { text: m[0], session: null, line: Number(m[3]) },
  )
}

type LineResult = { ok: true; entry: Json } | { ok: false; reason: string }
type FileResult = { ok: true; file: string } | { ok: false; reason: string }

/**
 * Main-session transcripts only: `<projectsDir>/<project>/<id>*.jsonl`. A
 * subagent's transcript sits a level deeper and is never matched.
 */
class TranscriptIndex {
  private readonly listings = new Map<string, string[]>()
  private readonly lines = new Map<string, string[]>()

  constructor(private readonly projectsDir: string) {}

  private projectDirs(): string[] {
    if (!fs.existsSync(this.projectsDir)) return []
    return fs
      .readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(this.projectsDir, d.name))
  }

  private listing(dir: string): string[] {
    let files = this.listings.get(dir)
    if (files === undefined) {
      files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => d.name)
      this.listings.set(dir, files)
    }
    return files
  }

  findFile(session: string): FileResult {
    const matches = this.projectDirs().flatMap((dir) =>
      this.listing(dir)
        .filter((name) => name.startsWith(session))
        .map((name) => path.join(dir, name)),
    )
    if (matches.length === 0) return { ok: false, reason: 'no main-session transcript matches' }
    if (matches.length > 1) return { ok: false, reason: `${matches.length} transcripts match` }
    return { ok: true, file: matches[0]! }
  }

  line(file: string, lineNo: number): LineResult {
    let lines = this.lines.get(file)
    if (lines === undefined) {
      lines = fs.readFileSync(file, 'utf8').split('\n')
      this.lines.set(file, lines)
    }
    const text = lines[lineNo - 1]
    if (text === undefined || text.trim() === '') return { ok: false, reason: 'line is past the end of the transcript' }
    try {
      const entry: unknown = JSON.parse(text)
      return isRecord(entry) ? { ok: true, entry } : { ok: false, reason: 'line is not a JSON object' }
    } catch {
      return { ok: false, reason: 'line is not valid JSON' }
    }
  }
}

function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  if (content.some((b) => isRecord(b) && b.type === 'tool_result')) return null
  const texts = content.filter((b): b is Json => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
  return texts.length > 0 ? texts.map((b) => b.text as string).join('\n') : null
}

/** The text MK typed, when the transcript entry is his prompt; null for any other entry. */
export function mkLineText(entry: Json): string | null {
  if (entry.type !== 'user' || entry.isSidechain === true || entry.isMeta === true) return null
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return null
  if (isRecord(entry.origin) && entry.origin.kind !== 'human') return null
  const text = contentText(isRecord(entry.message) ? entry.message.content : undefined)
  if (text === null || text.trim() === '') return null
  const lead = text.trimStart()
  return CLI_TEXT_PREFIXES.some((p) => lead.startsWith(p)) ? null : text.trim()
}

// ── Incidents ────────────────────────────────────────────────────────────

interface StringField {
  field: string
  value: string
}

function stringFields(value: unknown, field: string): StringField[] {
  if (typeof value === 'string') return [{ field, value }]
  if (Array.isArray(value)) return value.flatMap((v, i) => stringFields(v, `${field}[${i}]`))
  if (isRecord(value)) return Object.entries(value).flatMap(([k, v]) => stringFields(v, field === '' ? k : `${field}.${k}`))
  return []
}

function emptyDraft(id: string, source: DecisionCase['source']): DecisionCase {
  return {
    id,
    source,
    status: 'draft',
    decided_at: null,
    agent: null,
    channel: null,
    session_id: null,
    transcript: null,
    cwd: null,
    project_id: null,
    workspace_id: null,
    at_root: false,
    plan_dirs: [],
    query_text: null,
    prior_prompts: [],
    decision_kind: null,
    tool_text: null,
    expect_contradiction: false,
    needed: [],
    harmful: [],
    audit: null,
    note: '',
  }
}

function needed(key: string, lane: Lane | null, phrases: PhraseGroups = []): NeededMemory {
  return { key, kind: 'fact', expected_lane: lane, phrases, register_ids: [], item_ids: [], legacy_ids: [] }
}

interface DecisionLine {
  decided_at: string
  session_id: string
  cwd: string | null
  transcript: TranscriptRef
}

function decisionRef(rec: Json): { field: string; ref: FoundRef } | null {
  for (const field of ['session', 'decision']) {
    const value = str(rec[field])
    const ref = value === null ? undefined : findTranscriptRefs(value).find((r) => r.session !== null)
    if (ref !== undefined) return { field, ref }
  }
  return null
}

class IncidentDrafter {
  constructor(
    private readonly index: TranscriptIndex,
    private readonly classLanes: ClassLanes,
    private readonly unresolved: UnresolvedRef[],
  ) {}

  private miss(draftId: string, field: string, ref: string, reason: string): void {
    this.unresolved.push({ draft_id: draftId, field, ref, reason })
  }

  private resolveDecision(draftId: string, rec: Json): { file: string | null; line: DecisionLine | null } {
    const found = decisionRef(rec)
    if (found === null) {
      this.miss(draftId, 'session', '', 'no transcript ref for the decision')
      return { file: null, line: null }
    }
    const file = this.index.findFile(found.ref.session!)
    if (!file.ok) {
      this.miss(draftId, found.field, found.ref.text, file.reason)
      return { file: null, line: null }
    }
    const line = this.index.line(file.file, found.ref.line)
    if (!line.ok) {
      this.miss(draftId, found.field, found.ref.text, line.reason)
      return { file: file.file, line: null }
    }
    const timestamp = line.entry.timestamp
    if (!isOffsetTime(timestamp)) {
      this.miss(draftId, found.field, found.ref.text, 'decision line has no timestamp with an offset')
      return { file: file.file, line: null }
    }
    const sessionId = str(line.entry.sessionId) ?? path.basename(file.file, '.jsonl')
    return {
      file: file.file,
      line: { decided_at: timestamp, session_id: sessionId, cwd: str(line.entry.cwd), transcript: { file: file.file, line: found.ref.line } },
    }
  }

  /** Resolves every ref in the record; MK lines under a fact ref become phrase groups. */
  private resolveRefs(draftId: string, rec: Json, decisionFile: string | null): PhraseGroups {
    const phrases: PhraseGroups = []
    for (const { field, value } of stringFields(rec, '')) {
      for (const ref of findTranscriptRefs(value)) {
        let file = decisionFile
        if (ref.session !== null) {
          const found = this.index.findFile(ref.session)
          if (!found.ok) {
            this.miss(draftId, field, ref.text, found.reason)
            continue
          }
          file = found.file
        }
        if (file === null) {
          this.miss(draftId, field, ref.text, 'a bare line ref with no decision transcript')
          continue
        }
        const line = this.index.line(file, ref.line)
        if (!line.ok) {
          this.miss(draftId, field, ref.text, line.reason)
          continue
        }
        if (!INCIDENT_FACT_FIELDS.has(field)) continue
        const text = mkLineText(line.entry)
        if (text !== null && text.length <= PHRASE_LINE_MAX && !phrases.some((g) => g[0] === text)) phrases.push([text])
      }
    }
    return phrases
  }

  draft(rec: Json, lineNo: number): DecisionCase {
    const id = str(rec.id)
    if (id === null || id.trim() === '') throw new Error(`incidents line ${lineNo}: id must be a non-empty string`)
    const draftId = `incident:${id}`
    const { file, line } = this.resolveDecision(draftId, rec)
    const phrases = this.resolveRefs(draftId, rec, file)
    const primary = str(rec.failure_class_primary)
    const secondary = Array.isArray(rec.failure_class_secondary) ? rec.failure_class_secondary.filter((c): c is string => typeof c === 'string') : []
    const audit: CaseAudit = {
      classes: primary === null ? secondary : [primary, ...secondary],
      retrievable_by_that_query: str(rec.retrievable_by_that_query),
      context_at_decision: str(rec.context_at_decision),
    }
    const note = ['decision', 'missing_fact', 'fact_location'].map((f) => `${f}: ${str(rec[f]) ?? ''}`).join('\n')
    // A record that names its session without a line still tells review which transcript to open.
    const bareSession = str(rec.session)
    const sessionOnly = bareSession !== null && SESSION_UUID_RE.test(bareSession) ? { session_id: bareSession } : {}
    return {
      ...emptyDraft(draftId, { kind: 'incident', ref: id }),
      ...(line === null ? sessionOnly : { ...line, agent: 'main' as const }),
      needed: [needed('missing-fact', proposeLane(this.classLanes, primary ?? undefined), phrases)],
      audit,
      note,
    }
  }
}

// ── Fact-checks ──────────────────────────────────────────────────────────

function recalledIds(c: Json): Set<string> {
  const recalls = Array.isArray(c.recalls) ? c.recalls : []
  const ids = recalls.flatMap((r) => {
    if (!isRecord(r)) return []
    return [r.emitted, r.associated].flatMap((list) => (Array.isArray(list) ? list : []))
  })
  return new Set(ids.flatMap((item) => (isRecord(item) && typeof item.id === 'string' ? [item.id] : [])))
}

function judgementWantsDraft(j: Json): boolean {
  const missing = Array.isArray(j.missing) ? j.missing : []
  return missing.length > 0 || BRIEFING_VERDICTS_TO_DRAFT.has(str(j.briefing_verdict) ?? '')
}

function factcheckDraft(c: Json, id: string, judges: readonly Json[], markedBad: ReadonlySet<string>, unresolved: UnresolvedRef[]): DecisionCase {
  const draftId = `factcheck:${id}`
  const missing = judges.flatMap((j) => (Array.isArray(j.missing) ? j.missing.filter((m): m is string => typeof m === 'string') : []))
  const recalled = recalledIds(c)
  const bad = [...markedBad].filter((itemId) => recalled.has(itemId)).sort()
  const harmful: HarmfulMemory[] = bad.length === 0 ? [] : [{ key: 'judged-stale-or-wrong', phrases: [], current_phrases: [], item_ids: [], legacy_ids: bad }]
  const prompt = str(c.prompt)
  const promptTs = c.prompt_ts
  if (!isOffsetTime(promptTs)) unresolved.push({ draft_id: draftId, field: 'prompt_ts', ref: '', reason: 'prompt time has no offset' })
  const note = judges
    .flatMap((j, i) => [
      `judge ${i + 1} verdict: ${str(j.briefing_verdict) ?? ''}`,
      `judge ${i + 1} note: ${str(j.note) ?? ''}`,
      ...(Array.isArray(j.missing) ? j.missing.filter((m): m is string => typeof m === 'string').map((m) => `judge ${i + 1} missing: ${m}`) : []),
    ])
    .join('\n')
  const hasPrompt = prompt !== null && prompt.trim() !== ''
  return {
    ...emptyDraft(draftId, { kind: 'factcheck', ref: id }),
    decided_at: isOffsetTime(promptTs) ? promptTs : null,
    agent: 'main',
    channel: hasPrompt ? 'prompt' : null,
    session_id: str(c.session),
    cwd: str(c.cwd),
    query_text: hasPrompt ? cutQueryText(prompt) : null,
    needed: missing.map((_, i) => needed(`missing-${i + 1}`, null)),
    harmful,
    note,
  }
}

function draftFactchecks(input: FactcheckInput, unresolved: UnresolvedRef[]): { drafts: DecisionCase[]; skipped: number; orphans: number } {
  const cases = jsonLines(input.cases, 'fact-check cases')
  const byId = new Map<string, Json>()
  for (const c of cases) {
    const id = str(c.id)
    if (id !== null) byId.set(id, c)
  }
  const judges = new Map<string, Json[]>()
  let orphans = 0
  input.judgements.forEach((text, f) => {
    for (const j of jsonLines(text, `judgement file ${f + 1}`)) {
      const id = str(j.id)
      if (id === null || !byId.has(id)) {
        orphans += 1
        continue
      }
      judges.set(id, [...(judges.get(id) ?? []), j])
    }
  })
  const markedBad = new Set(input.markedBad)
  const drafts: DecisionCase[] = []
  let skipped = 0
  for (const [id, c] of byId) {
    const js = judges.get(id) ?? []
    if (!js.some(judgementWantsDraft)) {
      skipped += 1
      continue
    }
    drafts.push(factcheckDraft(c, id, js, markedBad, unresolved))
  }
  return { drafts, skipped, orphans }
}

// ── Memory misses ────────────────────────────────────────────────────────

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/** The rows of the first markdown table whose first header is `Date`. */
export function missRows(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim().startsWith('|') && tableCells(l)[0] === 'Date')
  if (start < 0) throw new Error('miss note has no table with a Date column')
  const header = tableCells(lines[start]!)
  const rows: string[][] = []
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break
    const cells = tableCells(line)
    const fitted = cells.length > header.length ? [...cells.slice(0, header.length - 1), cells.slice(header.length - 1).join(' | ')] : cells
    rows.push(fitted)
  }
  return { header, rows }
}

interface MissDraft {
  draft: DecisionCase
  date: string
}

function missDrafts(text: string): MissDraft[] {
  const { header, rows } = missRows(text)
  return rows.map((cells, i) => ({
    draft: {
      ...emptyDraft(`miss:${i + 1}`, { kind: 'miss', ref: `row ${i + 1}` }),
      note: header.map((h, j) => `${h}: ${cells[j] ?? ''}`).join('\n'),
    },
    date: cells[0] ?? '',
  }))
}

function possibleDuplicates(misses: readonly MissDraft[], incidents: readonly Json[]): PossibleDuplicate[] {
  return misses.flatMap(({ draft, date }) => {
    const incidentIds = incidents.filter((r) => date !== '' && str(r.date) === date).map((r) => `incident:${str(r.id)}`)
    return incidentIds.length > 0 ? [{ miss_id: draft.id, date, incident_ids: incidentIds }] : []
  })
}

// ── Entry point ──────────────────────────────────────────────────────────

export function draftCases(input: DraftInput): DraftResult {
  const unresolved: UnresolvedRef[] = []
  const index = new TranscriptIndex(input.projectsDir)
  const incidentRecords = input.incidents === undefined ? [] : jsonLines(input.incidents, 'incidents')
  if (incidentRecords.length > 0 && input.classLanes === undefined) throw new Error('incidents need a class-lanes map')
  const drafter = new IncidentDrafter(index, input.classLanes ?? {}, unresolved)
  const incidents = incidentRecords.map((rec, i) => drafter.draft(rec, i + 1))
  const factcheck = input.factcheck === undefined ? { drafts: [], skipped: 0, orphans: 0 } : draftFactchecks(input.factcheck, unresolved)
  const misses = input.misses === undefined ? [] : missDrafts(input.misses)
  const drafts = [...incidents, ...factcheck.drafts, ...misses.map((m) => m.draft)]
  const seen = new Set<string>()
  for (const d of drafts) {
    if (seen.has(d.id)) throw new Error(`two records draft the same case id ${d.id}`)
    seen.add(d.id)
  }
  return {
    drafts,
    report: {
      counts: { incidents: incidents.length, factcheck: factcheck.drafts.length, misses: misses.length, drafts: drafts.length },
      factcheck_skipped: factcheck.skipped,
      factcheck_expected: input.expectFactcheck ?? null,
      orphan_judgements: factcheck.orphans,
      unresolved,
      possible_duplicates: possibleDuplicates(misses, incidentRecords),
    },
  }
}

export function serializeCases(cases: readonly DecisionCase[]): string {
  return cases.map((c) => JSON.stringify(c)).join('\n') + '\n'
}

/** Builds a fact-check input from the judges' directory and the marked-ids file. */
export function readFactcheckInput(casesFile: string, judgementsDir: string, markedFile: string): FactcheckInput {
  const judgementFiles = fs
    .readdirSync(judgementsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
  let marked: unknown
  try {
    marked = JSON.parse(fs.readFileSync(markedFile, 'utf8'))
  } catch {
    throw new Error('marked-ids file is not valid JSON')
  }
  if (!isRecord(marked) || !Array.isArray(marked.bad) || !marked.bad.every((id) => typeof id === 'string')) {
    throw new Error('marked-ids file must be an object whose bad field is an array of ids')
  }
  return {
    cases: fs.readFileSync(casesFile, 'utf8'),
    judgements: judgementFiles.map((f) => fs.readFileSync(path.join(judgementsDir, f), 'utf8')),
    markedBad: marked.bad as string[],
  }
}

