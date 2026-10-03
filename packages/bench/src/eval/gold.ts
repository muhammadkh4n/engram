/**
 * Gold labels for recall evaluation, one JSON object per line:
 *
 *   { id, class, query, project_id?, gold_ids, gold_phrases, stale_ids,
 *     stale_phrases, current_phrases, note }
 *
 * A phrase group (string[]) matches when every phrase in it matches; a list of
 * groups (string[][]) matches when any group does. Unknown fields are refused:
 * a misspelled `gold_id` would otherwise score every query as a miss without
 * saying why.
 */

export const GOLD_CLASSES = ['identifier', 'current', 'recall', 'project'] as const
export type GoldClass = (typeof GOLD_CLASSES)[number]

export interface GoldEntry {
  id: string
  class: GoldClass
  query: string
  project_id?: string
  gold_ids: string[]
  gold_phrases: string[][]
  stale_ids: string[]
  stale_phrases: string[][]
  current_phrases: string[][]
  note: string
}

export class GoldFormatError extends Error {
  constructor(lineNo: number, message: string) {
    super(`gold line ${lineNo}: ${message}`)
    this.name = 'GoldFormatError'
  }
}

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'class',
  'query',
  'project_id',
  'gold_ids',
  'gold_phrases',
  'stale_ids',
  'stale_phrases',
  'current_phrases',
  'note',
])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function requireString(raw: Record<string, unknown>, field: string, lineNo: number): string {
  const value = raw[field]
  if (!isNonEmptyString(value)) throw new GoldFormatError(lineNo, `${field} must be a non-empty string`)
  return value
}

function requireIds(raw: Record<string, unknown>, field: string, lineNo: number): string[] {
  const value = raw[field]
  if (!isStringList(value)) throw new GoldFormatError(lineNo, `${field} must be an array of non-empty strings`)
  return [...value]
}

function requireGroups(raw: Record<string, unknown>, field: string, lineNo: number): string[][] {
  const value = raw[field]
  if (!Array.isArray(value)) throw new GoldFormatError(lineNo, `${field} must be an array of phrase groups`)
  return value.map((group, i) => {
    if (!isStringList(group) || group.length === 0) {
      throw new GoldFormatError(lineNo, `${field}[${i}] must be a non-empty array of non-empty strings`)
    }
    return [...group]
  })
}

function requireClass(raw: Record<string, unknown>, lineNo: number): GoldClass {
  const value = raw['class']
  if (typeof value !== 'string' || !(GOLD_CLASSES as readonly string[]).includes(value)) {
    throw new GoldFormatError(lineNo, `class must be one of ${GOLD_CLASSES.join(', ')}`)
  }
  return value as GoldClass
}

function optionalProject(raw: Record<string, unknown>, lineNo: number): { project_id?: string } {
  const value = raw['project_id']
  if (value === undefined || value === null) return {}
  if (!isNonEmptyString(value)) throw new GoldFormatError(lineNo, 'project_id must be a non-empty string when given')
  return { project_id: value }
}

/** Parses and validates one gold line; `lineNo` is its 1-based line in the file. */
export function parseGoldLine(text: string, lineNo: number): GoldEntry {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GoldFormatError(lineNo, 'not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GoldFormatError(lineNo, 'expected a JSON object')
  }
  const raw = parsed as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) throw new GoldFormatError(lineNo, `unknown field ${key}`)
  }

  const id = requireString(raw, 'id', lineNo)
  const cls = requireClass(raw, lineNo)
  const query = requireString(raw, 'query', lineNo)
  const project = optionalProject(raw, lineNo)
  const goldIds = requireIds(raw, 'gold_ids', lineNo)
  const goldPhrases = requireGroups(raw, 'gold_phrases', lineNo)
  const staleIds = requireIds(raw, 'stale_ids', lineNo)
  const stalePhrases = requireGroups(raw, 'stale_phrases', lineNo)
  const currentPhrases = requireGroups(raw, 'current_phrases', lineNo)
  if (typeof raw['note'] !== 'string') throw new GoldFormatError(lineNo, 'note must be a string')
  if (goldIds.length === 0 && goldPhrases.length === 0) {
    throw new GoldFormatError(lineNo, 'needs at least one gold_ids entry or gold_phrases group')
  }

  return {
    id,
    class: cls,
    query,
    ...project,
    gold_ids: goldIds,
    gold_phrases: goldPhrases,
    stale_ids: staleIds,
    stale_phrases: stalePhrases,
    current_phrases: currentPhrases,
    note: raw['note'],
  }
}

/** Parses a gold JSONL file. Blank lines are skipped; ids must be unique. */
export function parseGold(text: string): GoldEntry[] {
  const entries: GoldEntry[] = []
  const firstLine = new Map<string, number>()
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    const lineNo = i + 1
    const entry = parseGoldLine(line, lineNo)
    const seen = firstLine.get(entry.id)
    if (seen !== undefined) throw new GoldFormatError(lineNo, `duplicate id ${entry.id} (first on line ${seen})`)
    firstLine.set(entry.id, lineNo)
    entries.push(entry)
  })
  if (entries.length === 0) throw new Error('gold file has no gold lines')
  return entries
}
