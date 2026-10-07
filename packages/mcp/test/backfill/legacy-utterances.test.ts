import { describe, expect, it } from 'vitest'
import { parseBackfillCliArgs, UsageError } from '../../src/backfill/engram-backfill-cli.js'
import {
  type LegacyCandidate,
  type LegacyRawTurn,
  LegacyUtterancesRefused,
  type LegacyUtteranceStore,
  runLegacyUtterances,
} from '../../src/backfill/legacy-utterances.js'

const ROW_OPEN = '00000000-0000-4000-8000-000000000a01'
const ROW_LONG = '00000000-0000-4000-8000-000000000a02'
const ROW_COVERED = '00000000-0000-4000-8000-000000000a03'
const ROW_NO_SESSION = '00000000-0000-4000-8000-000000000a04'
const LONG_TURN = `keep this long prompt ${'x'.repeat(4000)}`.slice(0, 4000)

interface FakeState {
  unsettled: number
  stepWithWork: string | null
  unforgotten: number
}

function fakeStore(state: Partial<FakeState> = {}): LegacyUtteranceStore & { reads: string[] } {
  const s: FakeState = { unsettled: 0, stepWithWork: null, unforgotten: 0, ...state }
  const candidates: LegacyCandidate[] = [
    { id: ROW_OPEN, session_id: 'tst-open', project_id: 'tst-app', workspace_id: 'tst-ws' },
    { id: ROW_LONG, session_id: 'tst-open', project_id: 'tst-app', workspace_id: 'tst-ws' },
    { id: ROW_COVERED, session_id: 'tst-covered', project_id: null, workspace_id: null },
    { id: ROW_NO_SESSION, session_id: null, project_id: null, workspace_id: null },
  ]
  const raws = new Map<string, LegacyRawTurn>([
    [ROW_OPEN, { raw_turn: 'ok go', created_at: '2026-03-01T10:00:00+00:00' }],
    [ROW_LONG, { raw_turn: LONG_TURN, created_at: '2026-03-01T10:05:00+00:00' }],
    [ROW_COVERED, { raw_turn: 'covered words', created_at: '2026-03-01T11:00:00+00:00' }],
  ])
  const reads: string[] = []
  return {
    reads,
    unsettledCaptureEvents: async () => s.unsettled,
    legacyStepWithWork: async () => s.stepWithWork,
    unforgottenLegacyItems: async () => s.unforgotten,
    candidates: async () => {
      reads.push('candidates')
      return candidates
    },
    coveredSessions: async (ids) => new Set(ids.filter((id) => id === 'tst-covered')),
    rawTurns: async (ids) => {
      reads.push(...ids)
      return new Map(ids.filter((id) => raws.has(id)).map((id) => [id, raws.get(id)!]))
    },
  }
}

describe('runLegacyUtterances', () => {
  it.each([
    [{ unsettled: 3 }, /3 capture events are neither processed nor failed/],
    [{ stepWithWork: 'episodes' }, /legacy copy step episodes has work left/],
    [{ unforgotten: 2 }, /2 legacy items of forgotten old rows are not forgotten yet/],
  ])('refuses before reading any candidate while %o', async (state, message) => {
    const store = fakeStore(state)
    await expect(runLegacyUtterances({ store, log: () => {} })).rejects.toThrow(LegacyUtterancesRefused)
    await expect(runLegacyUtterances({ store, log: () => {} })).rejects.toThrow(message)
    expect(store.reads).toEqual([])
  })

  it('skips a covered session, flags the cut turn and counts what a dry run would send', async () => {
    const store = fakeStore()
    const summary = await runLegacyUtterances({ store, log: () => {}, now: () => new Date('2026-10-01T00:00:00Z') })
    expect(summary).toMatchObject({
      command: 'legacy-utterances',
      apply: false,
      candidates: 4,
      covered: 1,
      excluded: { no_session: 1 },
      sent: 2,
      events: { user_prompt: 2 },
      accepted: 0,
      stopped: null,
    })
    expect(store.reads).not.toContain(ROW_COVERED)
  })
})

describe('legacy command flags', () => {
  it('takes --plan with --map-out, or --map, never both', () => {
    expect(parseBackfillCliArgs(['legacy-copy', '--plan', '--map-out', 'm.json'])).toMatchObject({ plan: true, mapOut: 'm.json' })
    expect(parseBackfillCliArgs(['legacy-copy', '--map', 'm.json', '--apply'])).toMatchObject({ map: 'm.json', apply: true })
    for (const argv of [
      ['legacy-copy'],
      ['legacy-copy', '--plan'],
      ['legacy-copy', '--plan', '--map-out', 'm.json', '--map', 'm.json'],
      ['legacy-copy', '--plan', '--map-out', 'm.json', '--apply'],
      ['legacy-copy', '--map', 'm.json', '--overrides', 'o.json'],
      ['legacy-copy', '--map', 'm.json', '--target', 'http://127.0.0.1:1'],
      ['legacy-utterances', '--registry', 'r.json'],
    ]) {
      expect(() => parseBackfillCliArgs(argv), argv.join(' ')).toThrow(UsageError)
    }
  })
})
