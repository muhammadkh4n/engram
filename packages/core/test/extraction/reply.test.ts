import { describe, it, expect } from 'vitest'

import { parseReply } from '../../src/extraction/reply.js'

const STATEMENT = {
  utterance_id: 'utt-1',
  quote: 'No SQLite fallback.',
  question: 'Should it keep a SQLite fallback?',
  kind: 'ruling',
  standing: true,
  scope: 'project',
  subject: { id: 'subj-1' },
  applies_to: ['tst-repo'],
  supersedes: ['stmt-2'],
  restates: [],
  corrects: [],
}

const OBSERVATION = {
  assistant_utterance_id: 'turn-1',
  claim: 'The capture route in tst-repo writes to Postgres through PostgREST.',
  kind: 'fact',
  subject: { new: 'capture route' },
  evidence: [{ type: 'file', ref: 'packages/mcp/src/capture-route.ts' }],
  valid_at: null,
  supersedes: [],
}

const reply = (statements: unknown[], observations: unknown[]): string => JSON.stringify({ statements, observations })

describe('parseReply', () => {
  it('reads a valid reply into proposed items with their reply positions', () => {
    const parsed = parseReply(reply([STATEMENT], [OBSERVATION]))

    expect(parsed).toEqual({
      ok: true,
      statements: [
        {
          index: 0,
          utteranceId: 'utt-1',
          quote: 'No SQLite fallback.',
          question: 'Should it keep a SQLite fallback?',
          kind: 'ruling',
          standing: true,
          scope: 'project',
          subject: { id: 'subj-1' },
          appliesTo: ['tst-repo'],
          supersedes: ['stmt-2'],
          restates: [],
          corrects: [],
        },
      ],
      observations: [
        {
          index: 0,
          assistantUtteranceId: 'turn-1',
          claim: 'The capture route in tst-repo writes to Postgres through PostgREST.',
          kind: 'fact',
          subject: { new: 'capture route' },
          evidence: [{ type: 'file', ref: 'packages/mcp/src/capture-route.ts' }],
          validAt: null,
          supersedes: [],
        },
      ],
      rejected: [],
    })
  })

  it('reads a reply wrapped in a fence', () => {
    const parsed = parseReply(`Here you go:\n\`\`\`json\n${reply([STATEMENT], [])}\n\`\`\``)

    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.statements).toHaveLength(1)
  })

  it('keeps unknown aliases as strings for the gate to judge', () => {
    const parsed = parseReply(reply([{ ...STATEMENT, utterance_id: 'utt-9', subject: { id: 'subj-77' } }], []))

    expect(parsed.ok && parsed.statements[0]).toMatchObject({ utteranceId: 'utt-9', subject: { id: 'subj-77' } })
  })

  it('accepts empty lists', () => {
    expect(parseReply('{"statements": [], "observations": []}')).toEqual({
      ok: true,
      statements: [],
      observations: [],
      rejected: [],
    })
  })

  describe('the reply rule', () => {
    it.each([
      ['a missing observations array', '{"statements": []}'],
      ['observations that are not an array', '{"statements": [], "observations": {}}'],
      ['an extra top-level key', '{"statements": [], "observations": [], "notes": []}'],
      ['a top-level array', '[]'],
      ['prose only', 'Nothing to propose here.'],
      ['an empty reply', ''],
    ])('fails the whole reply on %s', (_label, text) => {
      expect(parseReply(text)).toMatchObject({ ok: false, rule: 'reply' })
    })
  })

  describe('the schema rule', () => {
    const { kind: _droppedKind, ...observationWithoutKind } = OBSERVATION
    const { question: _droppedQuestion, ...statementWithoutQuestion } = STATEMENT

    it.each([
      ['an extra key on a statement', 'statement', { ...STATEMENT, confidence: 0.9 }],
      ['a missing key on a statement', 'statement', statementWithoutQuestion],
      ['an unknown statement kind', 'statement', { ...STATEMENT, kind: 'preference' }],
      ['an unknown scope', 'statement', { ...STATEMENT, scope: 'team' }],
      ['a standing flag that is not a boolean', 'statement', { ...STATEMENT, standing: 'true' }],
      ['a subject with both keys', 'statement', { ...STATEMENT, subject: { id: 'subj-1', new: 'x' } }],
      ['a non-string applies_to entry', 'statement', { ...STATEMENT, applies_to: [1] }],
      ['a statement that is not an object', 'statement', 'No SQLite fallback.'],
      ['an extra key on an observation', 'observation', { ...OBSERVATION, confidence: 'high' }],
      ['an observation with kind "ruling"', 'observation', { ...OBSERVATION, kind: 'ruling' }],
      ['an observation with no kind', 'observation', observationWithoutKind],
      ['an unknown evidence type', 'observation', { ...OBSERVATION, evidence: [{ type: 'ticket', ref: 'TST-1' }] }],
      ['an evidence entry with an extra key', 'observation', { ...OBSERVATION, evidence: [{ type: 'pr', ref: '7', n: 1 }] }],
      ['a numeric valid_at', 'observation', { ...OBSERVATION, valid_at: 20261001 }],
    ])('rejects %s and keeps the rest', (_label, side, bad) => {
      const statements = side === 'statement' ? [STATEMENT, bad] : [STATEMENT]
      const observations = side === 'observation' ? [OBSERVATION, bad] : [OBSERVATION]

      const parsed = parseReply(reply(statements, observations))

      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.rejected).toEqual([{ item: side, index: 1, rule: 'schema' }])
      expect(parsed.statements).toHaveLength(1)
      expect(parsed.observations).toHaveLength(1)
    })
  })
})
