/**
 * Deterministic entities: tickets, repositories, paths, commit shas, URLs and
 * scoped packages, found by fixed rules with no model call. Each item stores
 * an entity string once (the entity table's key is item id plus entity), so
 * the first type found for a string wins.
 */

import type { ProposedEvidence } from './reply.js'

export const ENTITY_TYPES = ['ticket', 'repo', 'path', 'sha', 'url', 'package'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export interface ExtractedEntity {
  entity: string
  entity_type: EntityType
}

/** A row of the project registry; only kind `project` names a repository. */
export interface EntityProject {
  id: string
  kind: string
}

/** Uppercase prefixes of standard names (UTF-8, SHA-256, HTTP-2) that look like ticket keys. */
const NON_TICKET_PREFIXES = new Set(['UTF', 'SHA', 'ISO', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'AES', 'RSA'])
/** A short sha counts only when it starts at most this many characters after a context word ends. */
const SHA_CONTEXT_REACH = 20
const FULL_SHA_LENGTH = 40

const TICKET_RE = /\b[A-Z][A-Z0-9]+-[0-9]+\b/g
const URL_RE = /https?:\/\/[^\s<>()"'\]]+/g
const URL_TRAILING_RE = /[.,;:!?)]+$/
const URL_SCHEME_RE = /^https?:\/\/$/
/**
 * The extension may not run on into more word characters, so a long suffix is
 * not cut down to its first eight; the `:line` suffix is outside the match.
 */
const PATH_RE = /~?\.{0,2}\/?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_])/g
/** A hyphen on either side means a uuid segment or a slug, not a sha. */
const SHA_RE = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g
const SHA_CONTEXT_RE =
  /@|(?<![A-Za-z0-9])(?:commit(?:s|ted)?|sha|rev|head|merge[sd]?|revert(?:s|ed)?|cherry-pick(?:s|ed)?)(?![A-Za-z])/gi
const PACKAGE_RE = /(?<![\w@])@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi
const LINE_SUFFIX_RE = /(?::\d+){1,2}$/

interface Found {
  at: number
  entity: string
  entity_type: EntityType
}

interface Span {
  start: number
  end: number
}

/** Every entity in `text`, each once, in order of appearance. */
export function extractEntities(text: string, projects: readonly EntityProject[]): ExtractedEntity[] {
  const urls = findUrls(text)
  const found: Found[] = [
    ...findTickets(text),
    ...findRepos(text, projects),
    ...findPaths(text, urls),
    ...findShas(text),
    ...urls.map((u) => u.found),
    ...findPackages(text),
  ]
  const ordered = found
    .map((f, order) => ({ f, order }))
    .sort((a, b) => a.f.at - b.f.at || a.order - b.order)
    .map(({ f }) => ({ entity: f.entity, entity_type: f.entity_type }))
  return uniqueEntities(ordered)
}

/** A statement's entities: those of MK's words, then those of the question he answered. */
export function statementEntities(
  content: string,
  context: string | null,
  projects: readonly EntityProject[],
): ExtractedEntity[] {
  const fromContext = context === null ? [] : extractEntities(context, projects)
  return uniqueEntities([...extractEntities(content, projects), ...fromContext])
}

/**
 * An observation's entities: those of its claim, then each evidence ref typed
 * by its evidence type. The ref is already pinned to a commit, file, PR or
 * URL, so no context rule applies to it.
 */
export function observationEntities(
  claim: string,
  evidence: readonly ProposedEvidence[],
  projects: readonly EntityProject[],
): ExtractedEntity[] {
  const fromEvidence = evidence.map(evidenceEntity).filter((e): e is ExtractedEntity => e !== null)
  return uniqueEntities([...extractEntities(claim, projects), ...fromEvidence])
}

function evidenceEntity(evidence: ProposedEvidence): ExtractedEntity | null {
  const ref = evidence.ref.trim()
  if (ref === '') return null
  switch (evidence.type) {
    case 'commit':
      return { entity: ref.toLowerCase(), entity_type: 'sha' }
    case 'file':
      return { entity: ref.replace(LINE_SUFFIX_RE, ''), entity_type: 'path' }
    case 'pr':
    case 'url':
      return { entity: ref, entity_type: 'url' }
  }
}

function uniqueEntities(entities: readonly ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>()
  const out: ExtractedEntity[] = []
  for (const e of entities) {
    if (seen.has(e.entity)) continue
    seen.add(e.entity)
    out.push(e)
  }
  return out
}

function findTickets(text: string): Found[] {
  return [...text.matchAll(TICKET_RE)]
    .filter((m) => !NON_TICKET_PREFIXES.has(m[0].slice(0, m[0].indexOf('-'))))
    .map((m) => ({ at: m.index, entity: m[0], entity_type: 'ticket' }))
}

function findRepos(text: string, projects: readonly EntityProject[]): Found[] {
  return projects
    .filter((p) => p.kind === 'project' && p.id !== '')
    .flatMap((p) => {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(p.id)}(?![\\p{L}\\p{N}_-])`, 'giu')
      return [...text.matchAll(re)].map((m) => ({ at: m.index, entity: p.id, entity_type: 'repo' as const }))
    })
}

function findUrls(text: string): Array<{ span: Span; found: Found }> {
  const out: Array<{ span: Span; found: Found }> = []
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(URL_TRAILING_RE, '')
    if (URL_SCHEME_RE.test(url)) continue
    out.push({
      span: { start: m.index, end: m.index + m[0].length },
      found: { at: m.index, entity: url, entity_type: 'url' },
    })
  }
  return out
}

function findPaths(text: string, urls: ReadonlyArray<{ span: Span }>): Found[] {
  return [...text.matchAll(PATH_RE)]
    .filter((m) => !urls.some(({ span }) => m.index < span.end && m.index + m[0].length > span.start))
    .map((m) => ({ at: m.index, entity: m[0], entity_type: 'path' }))
}

function findShas(text: string): Found[] {
  const contextEnds = [...text.matchAll(SHA_CONTEXT_RE)].map((m) => m.index + m[0].length)
  return [...text.matchAll(SHA_RE)]
    .filter((m) => /[0-9]/.test(m[0]) && /[a-f]/.test(m[0]))
    .filter(
      (m) =>
        m[0].length === FULL_SHA_LENGTH ||
        contextEnds.some((end) => end <= m.index && m.index - end <= SHA_CONTEXT_REACH),
    )
    .map((m) => ({ at: m.index, entity: m[0], entity_type: 'sha' }))
}

function findPackages(text: string): Found[] {
  return [...text.matchAll(PACKAGE_RE)].map((m) => ({ at: m.index, entity: m[0].toLowerCase(), entity_type: 'package' }))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}
