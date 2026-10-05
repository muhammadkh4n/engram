/**
 * Every CHECK constraint on what capture writes (memory_capture_events, and
 * the memory_items rows materialize inserts and updates) is matched by a
 * validation rule that refuses its violation at the route, or is recorded as
 * unreachable from a capture event with the reason. An accepted event the
 * database refuses would fail its batch or die in materialize, so:
 * - each refusal case below must be rejected by validation at the named path;
 * - on real Postgres, the catalog must list exactly the constraints below,
 *   each with the definition hash it was reviewed against. A new or changed
 *   constraint fails here until its entry is written.
 */
import { describe, expect, it } from 'vitest'
import { parseCaptureEventsRequest } from '../../src/capture-events/validate.js'
import { realPgImage, startRealPg } from '../../../postgrest/test/real-pg/harness.js'
import { RECEIVED_AT, envelope, validEvent, type FixtureEvent } from './fixtures.js'
import type { CaptureEventType } from '@engram-mem/core'

interface Refusal {
  label: string
  event: () => FixtureEvent
  /** The path the rejection reason starts with. */
  path: string
}

interface Parity {
  /** First 12 hex of sha256(pg_get_constraintdef). */
  def: string
  refusedBy?: Refusal[]
  unreachable?: string
}

function event(patch: Record<string, unknown>, type: CaptureEventType = 'session_start'): FixtureEvent {
  return { ...validEvent(type), ...patch }
}

function payload(type: CaptureEventType, patch: Record<string, unknown>): FixtureEvent {
  const e = validEvent(type)
  return { ...e, payload: { ...e.payload, ...patch } }
}

const BAD_OCCURRED_AT: Refusal[] = [
  { label: 'occurred_at in year 1', event: () => event({ occurred_at: '0001-01-01T00:00:00Z' }), path: 'occurred_at' },
  { label: 'occurred_at in year 9999', event: () => event({ occurred_at: '9999-12-31T23:59:59Z' }), path: 'occurred_at' },
]
const LONG_SESSION_ID: Refusal = {
  label: 'a 257-char session_id',
  event: () => event({ session_id: 's'.repeat(257) }),
  path: 'session_id',
}

const PARITY: Record<string, Parity> = {
  'memory_capture_events.memory_capture_events_attempts_check': {
    def: '0a1ed9042c25',
    unreachable: 'attempts is the server retry counter: 0 on insert, raised only by materialize',
  },
  'memory_capture_events.memory_capture_events_event_uuid_check': {
    def: '7c1864acdf9a',
    refusedBy: [
      { label: 'an empty event_uuid', event: () => event({ event_uuid: '' }), path: 'event_uuid' },
      { label: 'a 129-char event_uuid', event: () => event({ event_uuid: 'e'.repeat(129) }), path: 'event_uuid' },
    ],
  },
  'memory_capture_events.memory_capture_events_finite_check': {
    def: 'cfc93b73a4e2',
    refusedBy: BAD_OCCURRED_AT,
    unreachable: 'received_at and processed_at are now() on the server',
  },
  'memory_capture_events.memory_capture_events_payload_check': {
    def: '204019cde74e',
    refusedBy: [
      { label: 'an array payload', event: () => event({ payload: [] }), path: 'payload' },
      { label: 'a string payload', event: () => event({ payload: 'x' }), path: 'payload' },
    ],
  },
  'memory_capture_events.memory_capture_events_session_id_check': {
    def: 'c6ed395752ef',
    refusedBy: [{ label: 'an empty session_id', event: () => event({ session_id: '' }), path: 'session_id' }, LONG_SESSION_ID],
  },
  'memory_capture_events.memory_capture_events_type_check': {
    def: '56f6c47e5fec',
    refusedBy: [{ label: 'an unknown type', event: () => event({ type: 'tool_call' }), path: 'type' }],
  },
  'memory_items.memory_items_assistant_check': {
    def: '4e75aea4160d',
    unreachable: 'class and speaker are literals per event type; only assistant_turn has the assistant speak, as an utterance',
  },
  'memory_items.memory_items_class_check': { def: 'ad72151a926c', unreachable: 'class is a literal per event type' },
  'memory_items.memory_items_content_hash_check': {
    def: '47773c495e69',
    unreachable: 'the insert trigger computes content_hash from content',
  },
  'memory_items.memory_items_embedding_attempts_check': {
    def: 'fc551540768d',
    unreachable:
      'capture writes neither column; engram_items_record_embedding_failures raises the count while it is under 5 and cuts the error to 500 characters; engram_items_reset_embedding_failures sets them back to 0 and NULL',
  },
  'memory_items.memory_items_embedding_check': {
    def: '74daedc51f0a',
    unreachable: 'materialize writes no embedding; the worker writes embedding and model together',
  },
  'memory_items.memory_items_finite_check': {
    def: '6c9a0daab542',
    refusedBy: BAD_OCCURRED_AT,
    unreachable:
      'valid_to is a later version occurred_at, restated_at is copied from a stored version, retired_at and created_at are now()',
  },
  'memory_items.memory_items_forgotten_check': { def: 'ddbb2d64c768', unreachable: 'capture never forgets an item' },
  'memory_items.memory_items_ids_check': {
    def: 'df548990f73a',
    refusedBy: [
      { label: 'a decision plan slug', event: () => payload('ledger_decision', { plan: 'Sample Plan' }), path: 'payload.plan' },
      { label: 'a ruling plan slug', event: () => payload('ledger_ruling', { plan: '-sample' }), path: 'payload.plan' },
      LONG_SESSION_ID,
    ],
    unreachable: 'project_id and workspace_id come from the project registry, synced through memory_projects_id_check',
  },
  'memory_items.memory_items_kind_check': { def: '661ab4fe610e', unreachable: 'kind is a literal per event type' },
  'memory_items.memory_items_lineage_self_check': {
    def: '7d2c0c14f26a',
    refusedBy: [
      {
        label: 'a legacy origin id that is not a uuid',
        event: () =>
          payload('user_prompt', { origin: { type: 'legacy', table: 'memory_episodes', id: 'x', truncated: false } }),
        path: 'payload.origin.id',
      },
    ],
    unreachable: 'lineage is empty or a legacy origin id, which names a stored item and never the new row generated id',
  },
  'memory_items.memory_items_mk_decision_check': {
    def: 'f25fa3fbe9b7',
    refusedBy: [
      {
        label: 'by mk without a quote',
        event: () => {
          const e = payload('ledger_decision', { by: 'mk' })
          delete e.payload.quote
          return e
        },
        path: 'payload',
      },
      { label: 'a blank quote', event: () => payload('ledger_decision', { by: 'mk', quote: ' ' }), path: 'payload.quote' },
      { label: 'a blank source', event: () => payload('ledger_decision', { by: 'mk', source: ' ' }), path: 'payload.source' },
    ],
  },
  'memory_items.memory_items_register_check': {
    def: '31be614684fd',
    refusedBy: [
      {
        label: 'a register_id that is no register reference',
        event: () => payload('candidate_status', { register_id: 'TST-1' }),
        path: 'payload.register_id',
      },
      { label: 'an unknown status', event: () => payload('candidate_status', { status: 'kept' }), path: 'payload.status' },
    ],
    unreachable:
      'standing comes from the stored statement, not the event: candidate_status on a statement that cannot take a status fails in materialize',
  },
  'memory_items.memory_items_retired_check': {
    def: '9dc18e4db14a',
    unreachable: 'retire reasons are "register status: <status>" and "superseded in the register by <id>", never blank',
  },
  'memory_items.memory_items_source_check': {
    def: '7c2b1f15c71b',
    refusedBy: [
      {
        label: 'a 65-char register id, whose event key would pass 512 chars',
        event: () => payload('register_entry', { id: `R-TST-${'1'.repeat(59)}` }),
        path: 'payload.id',
      },
    ],
    unreachable:
      'source.type is a literal; the other event keys are capture:<id>, git:<repo>:<sha> and ledger-decision:<plan>:<id>:<hex>, all bounded under 512',
  },
  'memory_items.memory_items_version_of_check': {
    def: '684362a7b608',
    unreachable:
      'version_of is register:<id> with the id at most 64 chars, or ledger-decision:<plan>:<id> with a bounded slug and id, both far under 512',
  },
  'memory_items.memory_items_speaker_check': { def: '44eaceb5e657', unreachable: 'speaker is a literal per event type' },
  'memory_items.memory_items_statement_lineage_check': {
    def: '58a5cc7988b1',
    unreachable: 'materialize inserts no mk_statement',
  },
  'memory_items.memory_items_subject_check': {
    def: '67167cb85061',
    unreachable: 'materialize inserts no mk_statement or observation',
  },
  'memory_items.memory_items_supersession_check': {
    def: 'b6f36d67c430',
    unreachable:
      'set only by engram_supersede_item, which materialize calls with the later occurred_at as the newer version; an equal time fails first',
  },
  'memory_items.memory_items_text_check': {
    def: '1efee9373e39',
    refusedBy: [
      { label: 'a blank prompt', event: () => payload('user_prompt', { text: ' \n' }), path: 'payload.text' },
      { label: 'a blank assistant turn', event: () => payload('assistant_turn', { text: '\t' }), path: 'payload.text' },
      { label: 'a blank commit message', event: () => payload('git_commit', { message: ' ' }), path: 'payload.message' },
      { label: 'a blank decision ruling', event: () => payload('ledger_decision', { ruling: ' ' }), path: 'payload.ruling' },
      { label: 'a blank ruling', event: () => payload('ledger_ruling', { ruling: ' ' }), path: 'payload.ruling' },
      {
        label: 'an answer with nothing said',
        event: () => payload('user_answer', { answers: { 'Which store should the worker read?': ' ' }, notes: {}, response: undefined }),
        path: 'payload',
      },
    ],
    unreachable: 'a register entry content always holds its id; a blank trigger or question becomes a NULL context',
  },
  'memory_items.memory_items_trust_check': { def: 'b090227de9ae', unreachable: 'trust is a literal per event type' },
}

function rejectionReason(e: FixtureEvent): string | null {
  const parsed = parseCaptureEventsRequest(envelope([e]), RECEIVED_AT)
  if ('error' in parsed) throw new Error(`unexpected envelope error: ${parsed.error}`)
  return parsed.rejected[0]?.reason ?? null
}

describe('capture validation refuses what the database CHECKs refuse', () => {
  it('gives every constraint a refusal case or a reason it is unreachable', () => {
    for (const [name, entry] of Object.entries(PARITY)) {
      expect((entry.refusedBy?.length ?? 0) > 0 || (entry.unreachable ?? '').trim() !== '', name).toBe(true)
    }
  })

  const cases = Object.entries(PARITY).flatMap(([name, entry]) =>
    (entry.refusedBy ?? []).map((r) => [name.split('.')[1]!, r.label, r] as const),
  )
  it.each(cases)('%s: rejects %s', (_name, _label, refusal) => {
    const reason = rejectionReason(refusal.event())
    expect(reason, 'the event was accepted').not.toBeNull()
    expect(reason!.startsWith(`${refusal.path} `) || reason!.startsWith(`${refusal.path}:`), reason!).toBe(true)
  })
})

describe.skipIf(!realPgImage)('the CHECK catalog on real Postgres', () => {
  it(
    'lists exactly the reviewed constraints, each with its reviewed definition',
    async () => {
      const pg = await startRealPg()
      try {
        await pg.applySchema()
        const out = await pg.psql(
          `SELECT c.conrelid::regclass::text || '.' || c.conname || ' '
                  || left(encode(sha256(convert_to(pg_get_constraintdef(c.oid), 'UTF8')), 'hex'), 12)
             FROM pg_constraint c
            WHERE c.contype = 'c'
              AND c.conrelid IN ('public.memory_capture_events'::regclass, 'public.memory_items'::regclass)
            ORDER BY 1;`,
        )
        const expected = Object.entries(PARITY)
          .map(([name, entry]) => `${name} ${entry.def}`)
          .sort()
        expect(out.split('\n').filter((l) => l !== '')).toEqual(expected)
      } finally {
        await pg.stop()
      }
    },
    180_000,
  )
})
