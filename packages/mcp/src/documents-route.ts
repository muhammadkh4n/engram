/**
 * The `POST /documents/sync` pipeline after auth and body parsing: validate
 * the request, map each vault note to its heading sections, scrub them, and
 * apply one note per store call (one transaction each). HTTP concerns (token,
 * body cap, JSON parse) stay in http-app.ts so this runs without a socket.
 *
 * A malformed request (body, `source`, the `notes` array or a note's keys)
 * answers 400. A note whose fields break a rule is answered `rejected` with
 * `invalid:<field>` and the other notes still run, so one bad note never
 * holds back the rest of a sync. A database error on one note marks it
 * `failed` (the producer retries it); 500 comes only when no note could run.
 *
 * Nothing is stored while the project registry has not synced (the database
 * refuses an unregistered project) or the secret registry is degraded (text
 * scrubbed by a partial registry would keep the secrets it missed).
 *
 * The log carries counts and SQLSTATEs only: a note's path or text never
 * reaches it.
 */

import { Buffer } from 'node:buffer'
import {
  DOCUMENT_SECTION_KINDS,
  DOCUMENT_SECTIONS_MAX,
  PostgresTextKeyCollision,
  scrubSecrets,
  scrubStructured,
  sqlstateOf,
  toPostgresText,
  type CaptureSecretHit,
  type DocumentNoteSyncResult,
  type DocumentNoteWrite,
  type DocumentSectionCounts,
  type DocumentSectionKind,
  type DocumentSectionWrite,
  type ItemStore,
  type ScrubResult,
  type SecretRegistryStatus,
} from '@engram-mem/core'
import { degradedReason } from './capture-events/route.js'
import { parseRfc3339 } from './capture-events/validate.js'
import { canonicalFolderScope, type ProjectRegistry } from './capture-events/project-registry.js'

/** 8 MiB holds the vault's largest note (465 KB) many times over, even with JSON escaping. */
export const DOCUMENTS_BODY_MAX_BYTES = 8 * 1024 * 1024
export const DOCUMENTS_NOTES_MAX = 200
export const DOCUMENT_PATH_MAX_CHARS = 1024
/** `memory_document_notes.path` is its primary key; a btree row holds at most 2,704 bytes. */
export const DOCUMENT_PATH_MAX_BYTES = 2600
export const DOCUMENT_NOTE_VERSION_MAX_CHARS = 128
export const DOCUMENT_TIME_MAX_FUTURE_MS = 5 * 60 * 1000
export const DOCUMENT_FRONTMATTER_MAX_CHARS = 16_000
export const DOCUMENT_HEADINGS_MAX = 6
export const DOCUMENT_HEADING_MAX_CHARS = 500
export const DOCUMENT_TEXT_MAX_CHARS = 1_000_000
/** The database stores a section index as at most nine digits. */
export const DOCUMENT_INDEX_MAX = 999_999_999

export const DOCUMENTS_FAILED_MESSAGE = 'documents sync failed; retry later'
export const DOCUMENTS_NOT_READY_MESSAGE = 'documents sync is not ready; retry later'
export const DOCUMENTS_DISABLED_MESSAGE = 'documents sync is not enabled on this server'

const NOTE_FIELDS = ['path', 'note_version', 'seen_at', 'mtime', 'deleted', 'frontmatter', 'sections'] as const
const SECTION_FIELDS = ['heading_path', 'index', 'text', 'kind_hint'] as const
const PLAN_BUCKETS: ReadonlySet<string> = new Set(['Active', 'Delivered', 'Design Records'])
/** Same rule as `memory_items.plan_slug`; a folder name outside it is not a plan slug. */
const PLAN_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/
/** Hub folders generated from tickets; register notes reach memory as register entries. */
const EXCLUDED_FOLDER = 'tickets'
const EXCLUDED_FILE = 'rulings.md'
/** 0001-01-01T00:00Z; the store refuses a time before year 1. Date.UTC would read year 1 as 1901. */
const YEAR_ONE_MS = new Date(0).setUTCFullYear(1, 0, 1)

type NoteField = (typeof NOTE_FIELDS)[number] | (typeof SECTION_FIELDS)[number]
export type DocumentNoteStatusOut = 'applied' | 'unchanged' | 'stale' | 'rejected' | 'failed'

export interface DocumentsRouteDeps {
  store: Pick<ItemStore, 'syncDocumentNote'>
  /** The project registry once its rows are synced to the database, else null. */
  ready: () => ProjectRegistry | null
  /** The secret registry's state; the scrubber reads the same registry. */
  status: () => SecretRegistryStatus
  log: (line: string) => void
  now?: () => Date
  /** Defaults to the server's scrubSecrets. */
  scrub?: (text: string) => Promise<ScrubResult>
}

export interface DocumentSectionCountsOut {
  created: number
  superseded: number
  unchanged: number
  retired: number
  restored: number
  kept_forgotten: number
  kept_retired: number
  skipped_empty: number
}

export interface DocumentNoteResult {
  path: string
  status: DocumentNoteStatusOut
  reason?: string
  sections?: DocumentSectionCountsOut
}

export interface DocumentsTotals {
  notes: number
  applied: number
  unchanged: number
  stale: number
  rejected: number
  failed: number
  created: number
  superseded: number
  retired: number
  restored: number
}

export interface DocumentsAccepted {
  results: DocumentNoteResult[]
  totals: DocumentsTotals
}

export type DocumentsBody = DocumentsAccepted | { error: string; retryable: boolean }

export interface DocumentsResponse {
  status: number
  body: DocumentsBody
}

type Parsed<T> = { value: T } | { error: string }

export function invalidDocumentsResponse(error: string, status = 400): DocumentsResponse {
  return { status, body: { error, retryable: false } }
}

export function failedDocumentsResponse(): DocumentsResponse {
  return { status: 500, body: { error: DOCUMENTS_FAILED_MESSAGE, retryable: true } }
}

export function unavailableDocumentsResponse(message = DOCUMENTS_NOT_READY_MESSAGE): DocumentsResponse {
  return { status: 503, body: { error: message, retryable: true } }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Null when `value` has exactly `fields` as keys, else the first unknown or missing key. */
function keyProblem(value: Record<string, unknown>, fields: readonly string[]): string | null {
  const unknown = Object.keys(value).find((key) => !fields.includes(key))
  if (unknown !== undefined) return `unknown field ${JSON.stringify(unknown.slice(0, 64))}`
  const missing = fields.find((key) => !Object.hasOwn(value, key))
  return missing === undefined ? null : `missing field ${missing}`
}

/** A note that passed the request's shape rules; its fields are still unchecked. */
interface RawNote {
  /** The note's path as sent, after U+FFFD replacement; null when it is not a string. */
  path: string | null
  fields: Record<string, unknown>
}

/**
 * The request rows answered with 400: the body, `source` and `notes[]`.
 * Every string and key of a note becomes Postgres-safe text first, so no
 * rule judges, and no note stores, text PostgreSQL cannot hold.
 */
export function parseDocumentsRequest(body: unknown): Parsed<RawNote[]> {
  if (!isPlainObject(body)) return { error: 'the body must be a JSON object' }
  const bodyProblem = keyProblem(body, ['source', 'notes'])
  if (bodyProblem !== null) return { error: `body: ${bodyProblem}` }
  if (body.source !== 'vault') return { error: 'source: must be "vault"' }
  if (!Array.isArray(body.notes) || body.notes.length < 1 || body.notes.length > DOCUMENTS_NOTES_MAX) {
    return { error: `notes: must be an array of 1 to ${DOCUMENTS_NOTES_MAX} notes` }
  }
  const notes: RawNote[] = []
  const paths = new Set<string>()
  for (const [i, raw] of body.notes.entries()) {
    if (!isPlainObject(raw)) return { error: `notes[${i}]: must be an object` }
    const problem = keyProblem(raw, NOTE_FIELDS)
    if (problem !== null) return { error: `notes[${i}]: ${problem}` }
    const path = typeof raw.path === 'string' ? toPostgresText(raw.path) : null
    if (path !== null) {
      if (paths.has(path)) return { error: `notes[${i}]: path is sent twice` }
      paths.add(path)
    }
    notes.push({ path, fields: raw })
  }
  return { value: notes }
}

class InvalidField extends Error {
  constructor(readonly field: NoteField) {
    super(`invalid:${field}`)
  }
}

function check(ok: boolean, field: NoteField): void {
  if (!ok) throw new InvalidField(field)
}

/** U+0000 and unpaired surrogates become U+FFFD; two keys equal once replaced break the field. */
function safeText<T>(value: T, field: NoteField): T {
  try {
    return toPostgresText(value)
  } catch (err) {
    if (err instanceof PostgresTextKeyCollision) throw new InvalidField(field)
    throw err
  }
}

function isExcluded(segments: readonly string[]): boolean {
  const folders = segments.slice(0, -1)
  return folders.some((s) => s.toLowerCase() === EXCLUDED_FOLDER) || segments.at(-1)!.toLowerCase() === EXCLUDED_FILE
}

function checkPath(path: string | null): string[] {
  check(path !== null && path.length >= 1 && path.length <= DOCUMENT_PATH_MAX_CHARS, 'path')
  const text = path!
  check(Buffer.byteLength(text, 'utf8') <= DOCUMENT_PATH_MAX_BYTES, 'path')
  check(text.endsWith('.md') && !text.startsWith('/') && !text.includes('\\'), 'path')
  const segments = text.split('/')
  check(segments.every((s) => s !== '' && s !== '..'), 'path')
  return segments
}

function checkTime(value: unknown, field: 'seen_at' | 'mtime', now: Date): Date {
  check(typeof value === 'string', field)
  const ms = parseRfc3339(value as string)
  check(ms !== null && ms >= YEAR_ONE_MS && ms <= now.getTime() + DOCUMENT_TIME_MAX_FUTURE_MS, field)
  return new Date(ms!)
}

function checkFrontmatter(value: unknown): Record<string, unknown> | null {
  if (value === null) return null
  check(isPlainObject(value), 'frontmatter')
  const safe = safeText(value as Record<string, unknown>, 'frontmatter')
  check(JSON.stringify(safe).length <= DOCUMENT_FRONTMATTER_MAX_CHARS, 'frontmatter')
  return safe
}

interface CheckedSection {
  headingPath: string[]
  index: number
  text: string
  kind: DocumentSectionKind
}

function checkSections(value: unknown): CheckedSection[] {
  check(Array.isArray(value) && value.length <= DOCUMENT_SECTIONS_MAX, 'sections')
  const sections: CheckedSection[] = []
  let previous = -1
  for (const raw of value as unknown[]) {
    check(isPlainObject(raw) && keyProblem(raw, SECTION_FIELDS) === null, 'sections')
    const s = raw as Record<string, unknown>
    const headings = s.heading_path
    check(Array.isArray(headings) && headings.length <= DOCUMENT_HEADINGS_MAX, 'heading_path')
    for (const h of headings as unknown[]) {
      check(typeof h === 'string' && h.length >= 1 && h.length <= DOCUMENT_HEADING_MAX_CHARS, 'heading_path')
    }
    const index = s.index
    check(Number.isSafeInteger(index) && (index as number) > previous && (index as number) <= DOCUMENT_INDEX_MAX, 'index')
    previous = index as number
    check(typeof s.text === 'string' && s.text.length <= DOCUMENT_TEXT_MAX_CHARS, 'text')
    const kind = DOCUMENT_SECTION_KINDS.find((k) => k === s.kind_hint)
    check(kind !== undefined, 'kind_hint')
    sections.push({
      headingPath: safeText(headings as string[], 'heading_path'),
      index: index as number,
      text: safeText(s.text as string, 'text'),
      kind: kind!,
    })
  }
  return sections
}

interface CheckedNote {
  path: string
  segments: string[]
  noteVersion: string
  seenAt: Date
  mtime: Date
  deleted: boolean
  frontmatter: Record<string, unknown> | null
  sections: CheckedSection[]
}

/** The note's fields checked in table order; the first one that breaks its rule names the rejection. */
function checkNote(raw: RawNote, now: Date): CheckedNote | { reason: string } {
  try {
    const segments = checkPath(raw.path)
    if (isExcluded(segments)) return { reason: 'excluded' }
    const f = raw.fields
    const version = f.note_version
    check(typeof version === 'string' && version.length >= 1 && version.length <= DOCUMENT_NOTE_VERSION_MAX_CHARS, 'note_version')
    const seenAt = checkTime(f.seen_at, 'seen_at', now)
    const mtime = checkTime(f.mtime, 'mtime', now)
    check(typeof f.deleted === 'boolean', 'deleted')
    const frontmatter = checkFrontmatter(f.frontmatter)
    const sections = checkSections(f.sections)
    if (f.deleted === true) check(sections.length === 0 && frontmatter === null, 'deleted')
    return {
      path: raw.path!,
      segments,
      noteVersion: safeText(version as string, 'note_version'),
      seenAt,
      mtime,
      deleted: f.deleted as boolean,
      frontmatter,
      sections,
    }
  } catch (err) {
    if (err instanceof InvalidField) return { reason: err.message }
    throw err
  }
}

/**
 * The note's scope from its top folder: the folder's canonical scope, the one
 * its register is stored under (`canonicalFolderScope`), so a vault folder's
 * notes and its rulings share one scope. None for a note at the vault root
 * or under a folder no registry entry files under.
 */
export function resolveNoteScope(
  registry: ProjectRegistry,
  segments: readonly string[],
): { projectId: string | null; workspaceId: string | null } {
  if (segments.length < 2) return { projectId: null, workspaceId: null }
  return canonicalFolderScope(registry, segments[0]!) ?? { projectId: null, workspaceId: null }
}

/** `<Folder>/Plans/<bucket>/<slug>/…` or `<Folder>/Plans/<bucket>/<slug>.md`; null for any other note. */
export function planSlugOf(segments: readonly string[]): string | null {
  if (segments.length < 4 || segments[1] !== 'Plans' || !PLAN_BUCKETS.has(segments[2]!)) return null
  const slug = segments.length === 4 ? segments[3]!.slice(0, -'.md'.length) : segments[3]!
  return PLAN_SLUG_PATTERN.test(slug) ? slug : null
}

type Scrub = (text: string) => Promise<ScrubResult>

async function scrubInto(text: string, field: string, scrub: Scrub, hits: CaptureSecretHit[]): Promise<string> {
  const result = await scrub(text)
  for (const r of result.redactions) hits.push({ field, detector: r.kind, secretName: r.name ?? null })
  return result.text
}

/**
 * One section per heading section, scrubbed. Its ordinal counts the earlier
 * sections with the same (scrubbed) heading path, so a section added above
 * another heading does not move it. Hits are named by the item field they
 * landed in: `content`, or `source.heading_path[<i>]`.
 */
async function mapSections(path: string, sections: readonly CheckedSection[], scrub: Scrub): Promise<DocumentSectionWrite[]> {
  const seen = new Map<string, number>()
  const out: DocumentSectionWrite[] = []
  for (const section of sections) {
    const hits: CaptureSecretHit[] = []
    const headingPath: string[] = []
    for (const [i, heading] of section.headingPath.entries()) {
      headingPath.push(await scrubInto(heading, `source.heading_path[${i}]`, scrub, hits))
    }
    const text = await scrubInto(section.text, 'content', scrub, hits)
    const key = JSON.stringify(headingPath)
    const ordinal = seen.get(key) ?? 0
    seen.set(key, ordinal + 1)
    const prefix = headingPath.length > 0 ? `${path} > ${headingPath.join(' > ')}` : path
    out.push({ headingPath, ordinal, index: section.index, text, kind: section.kind, searchText: `${prefix}: ${text}`, hits })
  }
  return out
}

/**
 * The note's write, or the rule it breaks. Frontmatter passes every scrub
 * view: a value under a credential-named key is masked by its key, every other
 * string, number and key is scrubbed on its own text, and the result is
 * scrubbed once more as one JSON text. A refusal (two keys masked into one, or
 * a secret only the whole-text pass found) rejects the note, since storing the
 * unscrubbed object would keep the secrets and a retry would fail the same way.
 */
async function mapNote(note: CheckedNote, registry: ProjectRegistry, scrub: Scrub): Promise<DocumentNoteWrite | { reason: string }> {
  let frontmatter: Record<string, unknown> | null = null
  if (note.frontmatter !== null) {
    const scrubbed = await scrubStructured(note.frontmatter, scrub)
    if (!scrubbed.ok) return { reason: 'invalid:frontmatter' }
    frontmatter = scrubbed.value as Record<string, unknown>
  }
  const scope = resolveNoteScope(registry, note.segments)
  return {
    path: note.path,
    noteVersion: note.noteVersion,
    seenAt: note.seenAt,
    mtime: note.mtime,
    deleted: note.deleted,
    frontmatter,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    planSlug: planSlugOf(note.segments),
    sections: await mapSections(note.path, note.sections, scrub),
  }
}

function countsOut(c: DocumentSectionCounts): DocumentSectionCountsOut {
  return {
    created: c.created,
    superseded: c.superseded,
    unchanged: c.unchanged,
    retired: c.retired,
    restored: c.restored,
    kept_forgotten: c.keptForgotten,
    kept_retired: c.keptRetired,
    skipped_empty: c.skippedEmpty,
  }
}

function totalsOf(results: readonly DocumentNoteResult[]): DocumentsTotals {
  const totals: DocumentsTotals = {
    notes: results.length,
    applied: 0,
    unchanged: 0,
    stale: 0,
    rejected: 0,
    failed: 0,
    created: 0,
    superseded: 0,
    retired: 0,
    restored: 0,
  }
  for (const r of results) {
    totals[r.status]++
    if (r.sections === undefined) continue
    totals.created += r.sections.created
    totals.superseded += r.sections.superseded
    totals.retired += r.sections.retired
    totals.restored += r.sections.restored
  }
  return totals
}

function storedResult(path: string, result: DocumentNoteSyncResult): DocumentNoteResult {
  const out: DocumentNoteResult = { path, status: result.status }
  if (result.sections !== null) out.sections = countsOut(result.sections)
  return out
}

/** The SQLSTATE, or the error class name; never the message, which can quote the note. */
function errorLabel(err: unknown): string {
  return sqlstateOf(err) ?? (err instanceof Error ? err.name : 'unknown error')
}

/** One note through check, map and store; a store error is that note's `failed`, never the request's. */
async function runNote(
  deps: DocumentsRouteDeps,
  registry: ProjectRegistry,
  raw: RawNote,
  position: number,
  now: Date,
): Promise<{ result: DocumentNoteResult; ran: boolean }> {
  const path = raw.path ?? ''
  const checked = checkNote(raw, now)
  if ('reason' in checked) return { result: { path, status: 'rejected', reason: checked.reason }, ran: false }
  try {
    const note = await mapNote(checked, registry, deps.scrub ?? scrubSecrets)
    if ('reason' in note) return { result: { path, status: 'rejected', reason: note.reason }, ran: false }
    return { result: storedResult(path, await deps.store.syncDocumentNote(note)), ran: true }
  } catch (err) {
    deps.log(`documents sync: note ${position} failed: ${errorLabel(err)}`)
    return { result: { path, status: 'failed' }, ran: true }
  }
}

export async function runDocumentsRequest(deps: DocumentsRouteDeps, body: unknown): Promise<DocumentsResponse> {
  const parsed = parseDocumentsRequest(body)
  if ('error' in parsed) return invalidDocumentsResponse(parsed.error)

  const registry = deps.ready()
  const degraded = degradedReason(deps.status())
  if (registry === null || degraded !== null) {
    deps.log(registry === null ? 'documents sync refused: the project registry has not synced' : `documents sync refused: ${degraded}`)
    return unavailableDocumentsResponse()
  }

  const now = (deps.now ?? (() => new Date()))()
  const results: DocumentNoteResult[] = []
  let ran = 0
  for (const [position, raw] of parsed.value.entries()) {
    const outcome = await runNote(deps, registry, raw, position, now)
    results.push(outcome.result)
    if (outcome.ran) ran++
  }
  const totals = totalsOf(results)
  deps.log(
    `documents sync: ${totals.notes} notes, ${totals.applied} applied, ${totals.unchanged} unchanged, ${totals.stale} stale, ` +
      `${totals.rejected} rejected, ${totals.failed} failed; sections ${totals.created} created, ` +
      `${totals.superseded} superseded, ${totals.retired} retired, ${totals.restored} restored`,
  )
  if (ran > 0 && totals.failed === ran) return failedDocumentsResponse()
  return { status: 200, body: { results, totals } }
}
