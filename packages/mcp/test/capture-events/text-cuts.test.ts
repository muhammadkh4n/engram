/**
 * Every text cut on the write path goes through cutWholeChars or
 * tailWholeChars: the capture route, the PostgREST store, core's ingestion,
 * text, utility and extraction code and the OpenAI adapter. A raw `.slice(`, `.substring(` or
 * `.substr(` on a string counts UTF-16 units and can keep one half of a
 * surrogate pair, which PostgreSQL refuses and an embedding provider receives
 * as malformed text. A raw cut is allowed only where the allowlist names it
 * with the reason it cannot split a pair.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const SCANNED = [
  'packages/mcp/src/capture-events',
  'packages/postgrest/src',
  'packages/core/src/ingestion',
  'packages/core/src/text',
  'packages/core/src/utils',
  'packages/core/src/extraction',
  'packages/openai/src',
]
const RAW_CUT = /\.(?:slice|substring|substr)\(/

interface Allowed {
  file: string
  /** Text the matching line contains. */
  line: string
  reason: string
}

const ALLOWED: readonly Allowed[] = [
  {
    file: 'packages/core/src/extraction/decide.ts',
    line: 'read.candidates.slice(0, DECISION_CANDIDATES_MAX)',
    reason: 'cuts an array of candidates, not a string',
  },
  {
    file: 'packages/core/src/extraction/decide.ts',
    line: 'item.occurredAt.slice(0, 10)',
    reason: 'an ISO 8601 timestamp is ASCII; its first ten characters are the date',
  },
  {
    file: 'packages/core/src/extraction/decide.ts',
    line: 'c.occurredAt.slice(0, 10)',
    reason: 'an ISO 8601 timestamp is ASCII; its first ten characters are the date',
  },
  {
    file: 'packages/core/src/extraction/decide.ts',
    line: "points.slice(0, max).join('')",
    reason: 'cuts an array of code points, so no pair is split',
  },
  {
    file: 'packages/core/src/extraction/retractions.ts',
    line: 'sentence.slice(0, match.index)',
    reason: 'ends where an ASCII retraction phrase matched, and the cut text is only read for negation words, never stored',
  },
  {
    file: 'packages/core/src/extraction/retractions.ts',
    line: 'split(/\\s+/).slice(-NEGATION_LOOKBACK_WORDS)',
    reason: 'cuts an array of words, not a string',
  },
  {
    file: 'packages/core/src/extraction/session-index.ts',
    line: 'at.toISOString().slice(0, 19)',
    reason: 'an ISO 8601 timestamp is ASCII; its first nineteen characters are the time to the second',
  },
  {
    file: 'packages/core/src/extraction/session-index.ts',
    line: ".trim()).slice(0, max).join('')",
    reason: 'cuts an array of code points, so no pair is split',
  },
  {
    file: 'packages/core/src/extraction/session-index.ts',
    line: 's.sha.slice(0, SHA_SHOWN)',
    reason: 'a commit sha is ASCII hex',
  },
  {
    file: 'packages/core/src/extraction/window.ts',
    line: '[...firsts.values()].slice(0, SHOWN_LISTING_LIMIT)',
    reason: 'cuts an array of listed items, not a string',
  },
  {
    file: 'packages/core/src/utils/event-date.ts',
    line: 'd.toISOString().slice(0, 10)',
    reason: 'an ISO 8601 timestamp is ASCII; its first ten characters are the date',
  },
  {
    file: 'packages/core/src/extraction/entities.ts',
    line: "m[0].slice(0, m[0].indexOf('-'))",
    reason: 'ends at an ASCII hyphen found by indexOf',
  },
  {
    file: 'packages/core/src/extraction/gate.ts',
    line: 'frac.slice(0, 3)',
    reason: 'the fraction is ASCII digits matched by the timestamp pattern',
  },
  {
    file: 'packages/core/src/extraction/gate.ts',
    line: 'zone.slice(1)',
    reason: 'the zone is an ASCII offset matched by the timestamp pattern',
  },
  {
    file: 'packages/core/src/extraction/gate.ts',
    line: 'digits.slice(0, 2)',
    reason: 'the offset digits are ASCII',
  },
  {
    file: 'packages/core/src/extraction/normalize.ts',
    line: "chars.slice(start, end).join('')",
    reason: 'cuts arrays of characters and of positions, not a string',
  },
  {
    file: 'packages/core/src/extraction/normalize.ts',
    line: 'haystack.slice(span.start, span.end)',
    reason: "the span's ends are the haystack positions of a whole quote's first and last units, so a well-formed quote only matches on character boundaries",
  },
  {
    file: 'packages/core/src/extraction/run.ts',
    line: 'id.slice(0, ID_PREFIX_CHARS)',
    reason: 'an item id is a uuid, which is ASCII',
  },
  {
    file: 'packages/core/src/extraction/subjects.ts',
    line: 'ranked.slice(0, Math.max(0, limit))',
    reason: 'cuts an array of subjects, not a string',
  },
  {
    file: 'packages/core/src/extraction/window.ts',
    line: 'text.slice(start)',
    reason: 'the tail cut moves start forward off a low surrogate first',
  },
  {
    file: 'packages/core/src/extraction/window.ts',
    line: 'ranked.slice(0, RECENT_LISTING_LIMIT)',
    reason: 'cuts an array of listed items, not a string',
  },
  {
    file: 'packages/core/src/extraction/window.ts',
    line: 'item.occurredAt.slice(0, 10)',
    reason: 'an ISO 8601 timestamp is ASCII; its first ten characters are the date',
  },
  {
    file: 'packages/core/src/extraction/window.ts',
    line: "points.slice(0, max).join('')",
    reason: 'cuts an array of code points, so no pair is split',
  },
  {
    file: 'packages/mcp/src/capture-events/route.ts',
    line: 'code.slice(0, 2)',
    reason: 'a SQLSTATE is five ASCII characters; the first two are its class',
  },
  {
    file: 'packages/mcp/src/capture-events/validate.ts',
    line: 'm.slice(1, 7)',
    reason: 'cuts the array of regular-expression groups, not a string',
  },
  {
    file: 'packages/mcp/src/capture-events/validate.ts',
    line: ".padEnd(3, '0').slice(0, 3)",
    reason: 'the fraction-of-second digits of a timestamp the pattern matched, ASCII only',
  },
  {
    file: 'packages/mcp/src/capture-events/validate.ts',
    line: ".slice('internal:'.length)",
    reason: 'starts after an ASCII prefix it matched, so the cut sits between two whole characters',
  },
  {
    file: 'packages/postgrest/src/adapter.ts',
    line: 'ids.slice(i, i + GET_BY_IDS_BATCH_SIZE)',
    reason: 'cuts an array of ids, not a string',
  },
  {
    file: 'packages/postgrest/src/items.ts',
    line: 'wanted.slice(i, i + GET_CHUNK_SIZE)',
    reason: 'cuts an array of ids, not a string',
  },
  {
    file: 'packages/postgrest/src/semantic.ts',
    line: '.split(/\\s+/).slice(0, 5)',
    reason: 'cuts an array of words, not a string',
  },
  {
    file: 'packages/postgrest/src/semantic.ts',
    line: 'updates.slice(start, start + GRADIENT_CHUNK_SIZE)',
    reason: 'cuts an array of updates, not a string',
  },
  {
    file: 'packages/postgrest/src/semantic.ts',
    line: '}).slice(0, opts?.limit ?? 10)',
    reason: 'cuts an array of results, not a string',
  },
  {
    file: 'packages/core/src/text/cut-text.ts',
    line: 'return text.slice(0, end)',
    reason: 'the head cut itself: end is moved back off a high surrogate',
  },
  {
    file: 'packages/core/src/text/cut-text.ts',
    line: 'return text.slice(start)',
    reason: 'the tail cut itself: start is moved forward off a low surrogate',
  },
  {
    file: 'packages/openai/src/summarizer.ts',
    line: 'documents.slice(0, RERANK_MAX_CANDIDATES)',
    reason: 'cuts an array of documents, not a string',
  },
  {
    file: 'packages/openai/src/summarizer.ts',
    line: '.slice(0, MAX_EXPANSION_TERMS)',
    reason: 'cuts an array of terms, not a string',
  },
  {
    file: 'packages/core/src/utils/json-reply.ts',
    line: 'text.slice(open + FENCE.length, close)',
    reason: 'both ends sit at an ASCII code fence found by indexOf',
  },
  {
    file: 'packages/core/src/utils/json-reply.ts',
    line: 'inner.slice(0, newline)',
    reason: 'ends at a newline found by indexOf',
  },
  {
    file: 'packages/core/src/utils/json-reply.ts',
    line: 'inner.slice(newline + 1)',
    reason: 'starts after a newline found by indexOf',
  },
  {
    file: 'packages/core/src/utils/json-reply.ts',
    line: 'text.slice(start, end + 1)',
    reason: 'starts at an ASCII bracket and ends after its ASCII match',
  },
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

function rawCuts(): Array<{ file: string; line: string; at: string }> {
  return SCANNED.flatMap((dir) =>
    sourceFiles(join(REPO, dir)).flatMap((path) => {
      const file = relative(REPO, path)
      return readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, i) => (RAW_CUT.test(line) ? [{ file, line, at: `${file}:${i + 1}` }] : []))
    }),
  )
}

describe('text cuts on the write path', () => {
  it('finds source files to scan in every directory', () => {
    for (const dir of SCANNED) expect(sourceFiles(join(REPO, dir)).length).toBeGreaterThan(0)
  })

  it('cut strings only through cutWholeChars or tailWholeChars, outside the allowlist', () => {
    const unexplained = rawCuts()
      .filter((cut) => !ALLOWED.some((a) => a.file === cut.file && cut.line.includes(a.line)))
      .map((cut) => `${cut.at}: ${cut.line.trim()}`)
    expect(unexplained).toEqual([])
  })

  it('names in the allowlist only raw cuts that still exist', () => {
    const cuts = rawCuts()
    const stale = ALLOWED.filter((a) => !cuts.some((cut) => cut.file === a.file && cut.line.includes(a.line)))
    expect(stale).toEqual([])
  })
})
