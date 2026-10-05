/**
 * Every text cut in the capture route and the PostgREST store goes through
 * cutWholeChars: a raw `.slice(0, n)` or `.substring(0, n)` on a string counts
 * UTF-16 units and can keep the first half of a surrogate pair, which
 * PostgreSQL refuses. A raw cut is allowed only where the allowlist names it
 * with the reason it cannot split a pair.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const SCANNED = ['packages/mcp/src/capture-events', 'packages/postgrest/src']
const RAW_CUT = /\.(?:slice|substring)\(\s*0\s*,/

interface Allowed {
  file: string
  /** Text the matching line contains. */
  line: string
  reason: string
}

const ALLOWED: readonly Allowed[] = [
  {
    file: 'packages/mcp/src/capture-events/route.ts',
    line: 'code.slice(0, 2)',
    reason: 'a SQLSTATE is five ASCII characters; the first two are its class',
  },
  {
    file: 'packages/mcp/src/capture-events/validate.ts',
    line: ".padEnd(3, '0').slice(0, 3)",
    reason: 'the fraction-of-second digits of a timestamp the pattern matched, ASCII only',
  },
  {
    file: 'packages/postgrest/src/semantic.ts',
    line: '.split(/\\s+/).slice(0, 5)',
    reason: 'cuts an array of words, not a string',
  },
  {
    file: 'packages/postgrest/src/semantic.ts',
    line: '}).slice(0, opts?.limit ?? 10)',
    reason: 'cuts an array of results, not a string',
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

describe('text cuts in the capture route and the PostgREST store', () => {
  it('finds source files to scan in both directories', () => {
    for (const dir of SCANNED) expect(sourceFiles(join(REPO, dir)).length).toBeGreaterThan(0)
  })

  it('cut strings only through cutWholeChars, outside the allowlist', () => {
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
