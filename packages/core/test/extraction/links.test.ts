import { describe, expect, it } from 'vitest'

import {
  LINK_REJECT_REASONS,
  validateLinks,
  type LinkProposal,
  type LinkSource,
  type LinkTarget,
} from '../../src/extraction/links.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const STORAGE = uuid(100)
const OTHER_SUBJECT = uuid(101)

function source(over: Partial<LinkSource> = {}): LinkSource {
  return {
    index: 0,
    class: 'mk_statement',
    subjectId: STORAGE,
    subjectLabel: 'storage backend',
    occurredAt: '2026-10-04T09:00:00.000Z',
    projectId: 'tst-repo',
    workspaceId: 'tst-ws',
    ...over,
  }
}

function target(n: number, over: Partial<LinkTarget> = {}): LinkTarget {
  return {
    id: uuid(n),
    class: 'mk_statement',
    kind: 'ruling',
    subjectId: STORAGE,
    subjectLabel: 'storage backend',
    occurredAt: '2026-09-30T10:00:00.000Z',
    supersededBy: null,
    retiredAt: null,
    forgottenAt: null,
    projectId: 'tst-repo',
    workspaceId: 'tst-ws',
    shown: false,
    ...over,
  }
}

function link(rel: LinkProposal['rel'], n: number, over: Partial<LinkProposal> = {}): LinkProposal {
  return { item: 0, rel, target: uuid(n), ...over }
}

describe('validateLinks', () => {
  it('accepts a supersedes link to an older current item of the same class and subject', () => {
    const result = validateLinks([source()], [link('supersedes', 1)], [target(1)])
    expect(result).toEqual({ accepted: [{ item: 0, rel: 'supersedes', target: uuid(1) }], rejected: [] })
  })

  it('accepts restates and corrects at the same event time, but never a supersedes', () => {
    const sameTime = '2026-10-04T09:00:00.000Z'
    const result = validateLinks(
      [source(), source({ index: 1 })],
      [link('restates', 1), link('corrects', 2), link('supersedes', 3, { item: 1 })],
      [target(1, { occurredAt: sameTime }), target(2, { occurredAt: sameTime, class: 'observation' }), target(3, { occurredAt: sameTime })],
    )
    expect(result.accepted).toEqual([
      { item: 0, rel: 'restates', target: uuid(1) },
      { item: 0, rel: 'corrects', target: uuid(2) },
    ])
    expect(result.rejected).toEqual([{ item: 1, rel: 'supersedes', target: uuid(3), reason: 'target_same_time' }])
  })

  it('names each rejection reason once', () => {
    const items = Array.from({ length: 9 }, (_, index) => source({ index }))
    const proposals: LinkProposal[] = [
      link('supersedes', 1, { item: 0 }),
      link('supersedes', 2, { item: 1 }),
      link('restates', 3, { item: 2 }),
      link('supersedes', 4, { item: 3 }),
      link('supersedes', 5, { item: 4 }),
      link('supersedes', 6, { item: 5 }),
      link('restates', 7, { item: 5 }),
      link('supersedes', 8, { item: 6, candidates: [uuid(9)] }),
      link('corrects', 99, { item: 7 }),
    ]
    const targets = [
      target(1, { supersededBy: uuid(50) }),
      target(2, { class: 'observation', kind: 'fact' }),
      target(3, { subjectId: OTHER_SUBJECT }),
      target(4, { occurredAt: '2026-10-05T00:00:00.000Z' }),
      target(5, { occurredAt: '2026-10-04T09:00:00.000Z' }),
      target(6),
      target(7),
      target(8),
    ]
    const { accepted, rejected } = validateLinks(items, proposals, targets)
    expect(accepted).toEqual([])
    expect(rejected.map((r) => [r.item, r.reason])).toEqual([
      [0, 'not_current'],
      [1, 'class_mismatch'],
      [2, 'subject_mismatch'],
      [3, 'target_newer'],
      [4, 'target_same_time'],
      [5, 'link_conflict'],
      [5, 'link_conflict'],
      [6, 'not_a_candidate'],
      [7, 'not_in_scope'],
    ])
    expect(new Set(rejected.map((r) => r.reason))).toEqual(new Set(LINK_REJECT_REASONS))
  })

  it('treats a retired or forgotten target as not current', () => {
    const { rejected } = validateLinks(
      [source()],
      [link('restates', 1), link('corrects', 2)],
      [target(1, { retiredAt: '2026-10-01T00:00:00.000Z' }), target(2, { forgottenAt: '2026-10-01T00:00:00.000Z' })],
    )
    expect(rejected.map((r) => r.reason)).toEqual(['not_current', 'not_current'])
  })

  it('refuses a supersedes or restates from an item whose subject the commit creates', () => {
    const { rejected } = validateLinks([source({ subjectId: null })], [link('supersedes', 1)], [target(1)])
    expect(rejected.map((r) => r.reason)).toEqual(['subject_mismatch'])
  })

  it('lets corrects run from a statement to any class but a session index, and from nothing else', () => {
    const { accepted, rejected } = validateLinks(
      [source(), source({ index: 1, class: 'observation' })],
      [link('corrects', 1), link('corrects', 2), link('corrects', 3, { item: 1 })],
      [
        target(1, { class: 'artifact', kind: 'commit', subjectId: null, subjectLabel: null }),
        target(2, { class: 'session_index', kind: 'session', subjectId: null, subjectLabel: null }),
        target(3, { class: 'observation', kind: 'fact' }),
      ],
    )
    expect(accepted).toEqual([{ item: 0, rel: 'corrects', target: uuid(1) }])
    expect(rejected.map((r) => [r.target, r.reason])).toEqual([
      [uuid(2), 'class_mismatch'],
      [uuid(3), 'class_mismatch'],
    ])
  })

  it('matches a register entry by subject label, case-insensitive and trimmed, for restates and changes only', () => {
    const entry = (n: number, label: string): LinkTarget =>
      target(n, { class: 'artifact', kind: 'ruling_entry', subjectId: OTHER_SUBJECT, subjectLabel: label })
    const { accepted, rejected } = validateLinks(
      [source(), source({ index: 1 })],
      [link('restates', 1), link('changes', 2), link('supersedes', 3, { item: 1 }), link('changes', 4)],
      [entry(1, '  Storage Backend '), entry(2, 'STORAGE BACKEND'), entry(3, 'storage backend'), entry(4, 'deploy window')],
    )
    expect(accepted).toEqual([
      { item: 0, rel: 'restates', target: uuid(1) },
      { item: 0, rel: 'changes', target: uuid(2) },
    ])
    expect(rejected.map((r) => [r.target, r.reason])).toEqual([
      [uuid(3), 'class_mismatch'],
      [uuid(4), 'subject_mismatch'],
    ])
  })

  it('refuses changes to anything but a register entry', () => {
    const { rejected } = validateLinks([source()], [link('changes', 1)], [target(1)])
    expect(rejected.map((r) => r.reason)).toEqual(['class_mismatch'])
  })

  it('drops a repeated proposal silently', () => {
    const { accepted, rejected } = validateLinks([source()], [link('supersedes', 1), link('supersedes', 1)], [target(1)])
    expect(accepted).toHaveLength(1)
    expect(rejected).toEqual([])
  })

  it('throws on a proposal for an item that is not new', () => {
    expect(() => validateLinks([source()], [link('supersedes', 1, { item: 3 })], [target(1)])).toThrow(/item 3/)
  })
})

describe('the scope of corrections and retractions', () => {
  const observation = { class: 'observation', kind: 'fact' } as const

  it('drops a correction of an item from another project and workspace that was not shown', () => {
    const result = validateLinks(
      [source()],
      [link('corrects', 1)],
      [target(1, { ...observation, projectId: 'tst-far', workspaceId: 'tst-far-ws' })],
    )
    expect(result).toEqual({ accepted: [], rejected: [{ item: 0, rel: 'corrects', target: uuid(1), reason: 'not_in_scope' }] })
  })

  it('accepts a correction of a shown item wherever it lives', () => {
    const result = validateLinks(
      [source()],
      [link('corrects', 1)],
      [target(1, { ...observation, projectId: 'tst-far', workspaceId: 'tst-far-ws', shown: true })],
    )
    expect(result.accepted).toEqual([{ item: 0, rel: 'corrects', target: uuid(1) }])
  })

  it('accepts a correction of an item with no project, or of another project in the same workspace', () => {
    const result = validateLinks(
      [source()],
      [link('corrects', 1), link('corrects', 2)],
      [target(1, { ...observation, projectId: null, workspaceId: null }), target(2, { ...observation, projectId: 'tst-near' })],
    )
    expect(result.rejected).toEqual([])
  })

  it('drops a retraction of an item outside the turn scope', () => {
    const turn = source({ class: 'utterance', subjectId: null, subjectLabel: null })
    const result = validateLinks(
      [turn],
      [link('retracts', 1), link('retracts', 2)],
      [target(1, observation), target(2, { ...observation, projectId: 'tst-far', workspaceId: null })],
    )
    expect(result).toEqual({
      accepted: [{ item: 0, rel: 'retracts', target: uuid(1) }],
      rejected: [{ item: 0, rel: 'retracts', target: uuid(2), reason: 'not_in_scope' }],
    })
  })
})
