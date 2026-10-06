import { describe, it, expect } from 'vitest'

import {
  extractEntities,
  observationEntities,
  statementEntities,
  type ExtractedEntity,
} from '../../src/extraction/entities.js'

const PROJECTS = [
  { id: 'tst-repo', kind: 'project' },
  { id: 'tst-ws', kind: 'workspace' },
]

const entities = (text: string): ExtractedEntity[] => extractEntities(text, PROJECTS)

describe('extractEntities', () => {
  it('tags an uppercase key with a numeric suffix as a ticket, as written', () => {
    expect(entities('Fixed under TST-1234 today.')).toEqual([{ entity: 'TST-1234', entity_type: 'ticket' }])
  })

  it('does not tag encoding, hash or protocol names as tickets', () => {
    expect(entities('UTF-8 text hashed with SHA-256 over HTTP-2 and TLS-13')).toEqual([])
  })

  it('tags a project id of kind project as a repo, case-insensitively, as a whole token', () => {
    expect(entities('Deployed Tst-Repo again.')).toEqual([{ entity: 'tst-repo', entity_type: 'repo' }])
    expect(entities('the tst-repository fork and my_tst-repo and tst-repo2')).toEqual([])
  })

  it('does not tag a project id of another kind', () => {
    expect(entities('moved tst-ws around')).toEqual([])
  })

  it('tags a file path and drops its line suffix', () => {
    expect(entities('see packages/core/src/a.ts:42 for the gate')).toEqual([
      { entity: 'packages/core/src/a.ts', entity_type: 'path' },
    ])
  })

  it('tags relative and home paths as written', () => {
    expect(entities('compare ./src/b.tsx with ~/.claude/settings.json and ../x/y.md')).toEqual([
      { entity: './src/b.tsx', entity_type: 'path' },
      { entity: '~/.claude/settings.json', entity_type: 'path' },
      { entity: '../x/y.md', entity_type: 'path' },
    ])
  })

  it('tags a path inside a URL only as the URL', () => {
    expect(entities('read https://example.com/docs/core/a.ts now')).toEqual([
      { entity: 'https://example.com/docs/core/a.ts', entity_type: 'url' },
    ])
  })

  it('strips trailing punctuation and a closing parenthesis from a URL', () => {
    expect(entities('(see https://example.com/x).')).toEqual([{ entity: 'https://example.com/x', entity_type: 'url' }])
    expect(entities('at http://example.com/a?b=1, then')).toEqual([
      { entity: 'http://example.com/a?b=1', entity_type: 'url' },
    ])
  })

  it('tags short hex as a sha only after a context word', () => {
    expect(entities('commit abc1234 fixed it')).toEqual([{ entity: 'abc1234', entity_type: 'sha' }])
    expect(entities('reverted in the revert of  abc1234')).toEqual([{ entity: 'abc1234', entity_type: 'sha' }])
    expect(entities('pinned @abc1234')).toEqual([{ entity: 'abc1234', entity_type: 'sha' }])
  })

  it('does not tag bare short hex, all-digit or all-letter hex, or hex too far from the context word', () => {
    expect(entities('abc1234 is mentioned')).toEqual([])
    expect(entities('commit 1234567 and commit abcdefa')).toEqual([])
    expect(entities('commit message mentions, much later, abc1234')).toEqual([])
    expect(entities('the shared abc1234 value')).toEqual([])
  })

  it('tags a 40-character hex as a sha with no context word', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'
    expect(entities(`landed as ${sha}`)).toEqual([{ entity: sha, entity_type: 'sha' }])
  })

  it('does not tag a uuid segment as a sha', () => {
    expect(entities('commit 0000000a-0000-4000-8000-000000000001')).toEqual([])
  })

  it('tags a scoped package in lowercase', () => {
    expect(entities('bump @engram-mem/Core first')).toEqual([{ entity: '@engram-mem/core', entity_type: 'package' }])
  })

  it('returns each entity once, in order of appearance', () => {
    expect(entities('TST-7 then tst-repo, then TST-7 again and TST-8 in tst-repo')).toEqual([
      { entity: 'TST-7', entity_type: 'ticket' },
      { entity: 'tst-repo', entity_type: 'repo' },
      { entity: 'TST-8', entity_type: 'ticket' },
    ])
  })

  it('returns nothing for text with no entities', () => {
    expect(entities('Keep Postgres as the only store.')).toEqual([])
  })
})

describe('statementEntities', () => {
  it('runs on the content and then the context', () => {
    expect(statementEntities('yes, TST-9', 'Should tst-repo ship TST-9?', PROJECTS)).toEqual([
      { entity: 'TST-9', entity_type: 'ticket' },
      { entity: 'tst-repo', entity_type: 'repo' },
    ])
  })

  it('runs on the content alone when there is no context', () => {
    expect(statementEntities('ship TST-9', null, PROJECTS)).toEqual([{ entity: 'TST-9', entity_type: 'ticket' }])
  })
})

describe('observationEntities', () => {
  it('adds each evidence ref typed by its evidence type, with no context rule', () => {
    expect(
      observationEntities(
        'The gate rejects paraphrases in tst-repo.',
        [
          { type: 'commit', ref: 'abc1234' },
          { type: 'file', ref: 'packages/core/src/gate.ts' },
          { type: 'pr', ref: 'https://github.com/tst-org/tst-repo/pull/7' },
          { type: 'url', ref: 'https://example.com/x' },
        ],
        PROJECTS,
      ),
    ).toEqual([
      { entity: 'tst-repo', entity_type: 'repo' },
      { entity: 'abc1234', entity_type: 'sha' },
      { entity: 'packages/core/src/gate.ts', entity_type: 'path' },
      { entity: 'https://github.com/tst-org/tst-repo/pull/7', entity_type: 'url' },
      { entity: 'https://example.com/x', entity_type: 'url' },
    ])
  })

  it('keeps an entity once when the claim and an evidence ref name it', () => {
    expect(
      observationEntities('Fixed in commit abc1234.', [{ type: 'commit', ref: 'ABC1234' }], PROJECTS),
    ).toEqual([{ entity: 'abc1234', entity_type: 'sha' }])
  })

  it('skips a blank evidence ref', () => {
    expect(observationEntities('No refs here.', [{ type: 'file', ref: '  ' }], PROJECTS)).toEqual([])
  })
})
