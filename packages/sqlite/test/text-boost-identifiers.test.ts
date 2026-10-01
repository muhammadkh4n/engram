/**
 * textBoost feeds the lexical leg of recall. Identifier terms carry FTS5
 * operator characters ('-', '.', '+'): unquoted, FTS5 parses `aca-2613` as a
 * column filter and `node.js` as a syntax error, and a single such term used
 * to fail the whole MATCH for every tier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteStorageAdapter } from '../src/adapter.js'

const CONTENTS = [
  'ACA-2613 ready for QA',
  'switched the judge to gpt-4o',
  'upgrade node.js',
  'C++ build flags',
  'deploy the worker',
]

describe('textBoost with identifier terms', () => {
  let storage: SqliteStorageAdapter
  const idByContent = new Map<string, string>()

  beforeEach(async () => {
    storage = new SqliteStorageAdapter(':memory:')
    await storage.initialize()
    idByContent.clear()
    for (const content of CONTENTS) {
      const ep = await storage.episodes.insert({
        sessionId: 's-ident',
        role: 'user',
        content,
        salience: 0.5,
        accessCount: 0,
        lastAccessed: null,
        consolidatedAt: null,
        embedding: null,
        entities: [],
        metadata: {},
      })
      idByContent.set(content, ep.id)
    }
  })

  afterEach(async () => {
    await storage.dispose()
  })

  async function matched(terms: string[]): Promise<string[]> {
    const rows = await storage.textBoost(terms)
    const contentById = new Map([...idByContent].map(([c, id]) => [id, c]))
    return rows.map((r) => contentById.get(r.id) ?? r.id).sort()
  }

  it.each([
    ['aca-2613', 'ACA-2613 ready for QA'],
    ['gpt-4o', 'switched the judge to gpt-4o'],
    ['node.js', 'upgrade node.js'],
    ['c++', 'C++ build flags'],
  ])('%s returns its row', async (term, content) => {
    expect(await matched([term])).toEqual([content])
  })

  it('one identifier term does not empty the query', async () => {
    expect(await matched(['deploy', 'aca-2613'])).toEqual(
      ['ACA-2613 ready for QA', 'deploy the worker'],
    )
  })

  it.each([['or'], ['near'], ['--'], ['?'], ['say "hi"']])('%s does not throw', async (term) => {
    await expect(storage.textBoost([term])).resolves.toBeInstanceOf(Array)
  })

  it('blank terms are dropped; none left returns no rows', async () => {
    expect(await storage.textBoost(['  ', ''])).toEqual([])
  })

  it('a NUL or other control character in a term returns the same rows', async () => {
    const clean = await matched(['deploy', 'aca-2613'])
    expect(await matched(['dep\u0000loy', 'aca-2613\u0000'])).toEqual(clean)
    expect(await matched(['\u0000\u001b', 'deploy\n'])).toEqual(['deploy the worker'])
    expect(await storage.textBoost(['\u0000'])).toEqual([])
  })

  function rawDb(): { exec(sql: string): void } {
    return (storage as unknown as { db: { exec(sql: string): void } }).db
  }

  it('a tier without an FTS table is skipped; the other tiers still return rows', async () => {
    rawDb().exec('DROP TABLE digests_fts')
    expect(await matched(['deploy'])).toEqual(['deploy the worker'])
  })

  it('any other SQLite error is rethrown with the tier name', async () => {
    rawDb().exec('DROP TABLE semantic_fts; CREATE TABLE semantic_fts (x TEXT)')
    await expect(storage.textBoost(['deploy'])).rejects.toThrow(/textBoost semantic FTS query failed/)
  })
})
