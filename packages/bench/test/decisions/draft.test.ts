import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertReviewed, parseCases } from '../../src/decisions/cases.js'
import { cutQueryText, draftCases, findTranscriptRefs, missRows, parseClassLanes, proposeLane, type DraftInput } from '../../src/decisions/draft.js'
import { runCli } from '../../src/decisions/engram-decision-replay.js'

const SESSION = 'abcdefab-1111-2222-3333-444455556666'
const PREFIX = SESSION.slice(0, 8)
const SUBAGENT_SESSION = 'bcdefabc-1111-2222-3333-444455556666'
const MISSING_SESSION = 'fedcbafe'
const DECIDED_AT = '2026-09-30T10:00:00.000Z'

const MK_FACT = 'keep the reporting api on port 3000'
const DECISION_TEXT = 'moved the reporting api to port 8080'
const MISSING_FACT_TEXT = 'the port was fixed by an earlier statement'
const LONG_PROMPT = `${'h'.repeat(1250)}${'t'.repeat(1250)}`
const SHORT_PROMPT = 'why does the reporting api answer on the wrong port'
const JUDGE_NOTE = 'the briefing named the old port as current'
const JUDGE_MISSING = 'the statement fixing the port lived in a notes file'

/** A transcript ref as the audit writes it; built here so the line number is data, not literal text. */
function ref(session: string, line: number): string {
  return `${session}:L${line}`
}

function transcriptLines(cwd: string): string[] {
  return [
    { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: MK_FACT }, timestamp: '2026-09-30T09:00:00.000Z', sessionId: SESSION, cwd },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] }, timestamp: '2026-09-30T09:00:05.000Z', sessionId: SESSION, cwd },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: DECISION_TEXT }] }, timestamp: DECIDED_AT, sessionId: SESSION, cwd },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, timestamp: '2026-09-30T10:00:01.000Z', sessionId: SESSION, cwd },
  ].map((e) => JSON.stringify(e))
}

let tmp: string
let projectsDir: string
let projectDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-drafts-'))
  projectsDir = path.join(tmp, 'projects')
  projectDir = path.join(projectsDir, '-home-synthetic-project')
  fs.mkdirSync(path.join(projectDir, SESSION, 'subagents'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), transcriptLines('/home/synthetic/project').join('\n') + '\n')
  fs.writeFileSync(path.join(projectDir, SESSION, 'subagents', `${SUBAGENT_SESSION}.jsonl`), transcriptLines('/home/synthetic/project').join('\n') + '\n')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function incident(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'TST-CASE-1',
    date: '2026-09-30',
    correction_date: '2026-09-30',
    project: 'synthetic-project',
    chain: null,
    session: `${projectDir}/${SESSION}.jsonl:L${3}`,
    correction_ref: ref(PREFIX, 4),
    decision: DECISION_TEXT,
    missing_fact: MISSING_FACT_TEXT,
    fact_location: `stated at ${ref(PREFIX, 1)}`,
    context_at_decision: 'the statement was in the same session',
    retrievable_by_that_query: 'no',
    cost: { note: 'synthetic', turns_rework: 2 },
    failure_class_primary: 'alpha rule present, not applied',
    failure_class_secondary: ['beta no trigger'],
    ...overrides,
  }
}

function factcheckCase(id: string, prompt: string, emitted: string[]): Record<string, unknown> {
  return {
    session: SESSION,
    cwd: '/home/synthetic/project',
    prompt_ts: '2026-10-01T08:00:00.000Z',
    prompt,
    briefing: null,
    briefing_ts: '2026-10-01T08:00:02.000Z',
    recalls: [{ ts: '2026-10-01T08:00:01.000Z', query: 'synthetic', project_id: 'synthetic-project', mode: 'auto', emitted: emitted.map((e, i) => ({ id: e, type: 'semantic', rank: i + 1 })), associated: [] }],
    id,
  }
}

function judgement(id: string, verdict: string, missing: string[]): Record<string, unknown> {
  return { id, intent: 'synthetic', memory_needed: 'some', briefing_verdict: verdict, claims: [], missing, raw_top10: null, best_facts_from: null, note: JUDGE_NOTE }
}

const MISSES = [
  '# Misses',
  '',
  '| Date | Type | What was missed | Where the truth lived | Fix |',
  '|---|---|---|---|---|',
  '| 2026-09-30 | fact | the fixed port | a notes file | a register entry |',
  '| 2026-08-01 | procedure | the deploy order | a ledger | a trigger |',
  '',
].join('\n')

function jsonl(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

function input(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    incidents: jsonl([incident(), incident({ id: 'TST-CASE-2', date: '2026-09-01', session: ref(MISSING_SESSION, 5), fact_location: 'none', failure_class_primary: 'gamma unmapped' })]),
    classLanes: { alpha: 'scope' },
    factcheck: {
      cases: jsonl([
        factcheckCase('TST-CASE-10', LONG_PROMPT, ['item-1', 'item-2']),
        factcheckCase('TST-CASE-11', SHORT_PROMPT, ['item-3']),
        factcheckCase('TST-CASE-12', SHORT_PROMPT, ['item-1']),
      ]),
      judgements: [jsonl([judgement('TST-CASE-10', 'misleading', [JUDGE_MISSING])]), jsonl([judgement('TST-CASE-11', 'helpful', []), judgement('TST-CASE-12', 'harmful', [])])],
      markedBad: ['item-2', 'item-1'],
    },
    misses: MISSES,
    projectsDir,
    ...overrides,
  }
}

describe('draftCases: incidents', () => {
  it('a resolvable decision ref sets decided_at, session, cwd and transcript from the transcript line', () => {
    const { drafts } = draftCases(input())
    const d = drafts.find((c) => c.id === 'incident:TST-CASE-1')!
    expect(d.status).toBe('draft')
    expect(d.decided_at).toBe(DECIDED_AT)
    expect(d.session_id).toBe(SESSION)
    expect(d.cwd).toBe('/home/synthetic/project')
    expect(d.transcript).toEqual({ file: path.join(projectDir, `${SESSION}.jsonl`), line: 3 })
    expect(d.agent).toBe('main')
  })

  it('copies the audit verbatim, puts the record text in the note and proposes a lane by class', () => {
    const { drafts } = draftCases(input())
    const d = drafts.find((c) => c.id === 'incident:TST-CASE-1')!
    expect(d.audit).toEqual({ classes: ['alpha rule present, not applied', 'beta no trigger'], retrievable_by_that_query: 'no', context_at_decision: 'the statement was in the same session' })
    expect(d.note).toContain(DECISION_TEXT)
    expect(d.note).toContain(MISSING_FACT_TEXT)
    expect(d.needed[0]!.expected_lane).toBe('scope')
    expect(drafts.find((c) => c.id === 'incident:TST-CASE-2')!.needed[0]!.expected_lane).toBe('none')
  })

  it('turns a short MK line under a fact ref into a proposed phrase group', () => {
    const d = draftCases(input()).drafts.find((c) => c.id === 'incident:TST-CASE-1')!
    expect(d.needed[0]!.phrases).toEqual([[MK_FACT]])
  })

  it('reports an unresolved ref and leaves the decision fields null', () => {
    const { drafts, report } = draftCases(input())
    const d = drafts.find((c) => c.id === 'incident:TST-CASE-2')!
    expect(d.decided_at).toBeNull()
    expect(report.unresolved).toContainEqual({ draft_id: 'incident:TST-CASE-2', field: 'session', ref: ref(MISSING_SESSION, 5), reason: 'no main-session transcript matches' })
  })

  it('never resolves a ref into a subagent transcript', () => {
    const records = jsonl([incident({ session: ref(SUBAGENT_SESSION.slice(0, 8), 3) })])
    const { drafts, report } = draftCases(input({ incidents: records, factcheck: undefined, misses: undefined }))
    expect(drafts[0]!.decided_at).toBeNull()
    expect(report.unresolved.map((u) => u.reason)).toContain('no main-session transcript matches')
  })

  it('reports a ref past the end of the transcript', () => {
    const records = jsonl([incident({ correction_ref: ref(PREFIX, 99) })])
    const { report } = draftCases(input({ incidents: records, factcheck: undefined, misses: undefined }))
    expect(report.unresolved).toContainEqual({ draft_id: 'incident:TST-CASE-1', field: 'correction_ref', ref: ref(PREFIX, 99), reason: 'line is past the end of the transcript' })
  })
})

describe('draftCases: fact-checks', () => {
  it('drafts a case with missing context or a harmful verdict and skips one with neither', () => {
    const { drafts, report } = draftCases(input())
    const ids = drafts.filter((d) => d.source.kind === 'factcheck').map((d) => d.source.ref)
    expect(ids).toEqual(['TST-CASE-10', 'TST-CASE-12'])
    expect(report.factcheck_skipped).toBe(1)
  })

  it('cuts a 2500-char prompt to its first and last 1000 chars on the prompt channel', () => {
    const d = draftCases(input()).drafts.find((c) => c.id === 'factcheck:TST-CASE-10')!
    expect(d.channel).toBe('prompt')
    expect(d.query_text).toBe(`${'h'.repeat(1000)}${'t'.repeat(1000)}`)
    expect(d.decided_at).toBe('2026-10-01T08:00:00.000Z')
  })

  it('keeps the judges notes verbatim and lists items judged stale or wrong as harmful legacy ids', () => {
    const d = draftCases(input()).drafts.find((c) => c.id === 'factcheck:TST-CASE-10')!
    expect(d.note).toContain(JUDGE_NOTE)
    expect(d.note).toContain(JUDGE_MISSING)
    expect(d.needed).toHaveLength(1)
    expect(d.harmful).toEqual([{ key: 'judged-stale-or-wrong', phrases: [], current_phrases: [], item_ids: [], legacy_ids: ['item-1', 'item-2'] }])
  })

  it('reports the count found against the expected count without changing it', () => {
    const { report } = draftCases(input({ expectFactcheck: 3 }))
    expect(report.counts.factcheck).toBe(2)
    expect(report.factcheck_expected).toBe(3)
  })
})

describe('draftCases: misses', () => {
  it('drafts one case per row and lists a row on an incident date as a possible duplicate', () => {
    const { drafts, report } = draftCases(input())
    expect(drafts.filter((d) => d.source.kind === 'miss').map((d) => d.source.ref)).toEqual(['row 1', 'row 2'])
    expect(report.possible_duplicates).toEqual([{ miss_id: 'miss:1', date: '2026-09-30', incident_ids: ['incident:TST-CASE-1'] }])
  })

  it('reads the table rows under the Date header', () => {
    expect(missRows(MISSES).rows[1]).toEqual(['2026-08-01', 'procedure', 'the deploy order', 'a ledger', 'a trigger'])
  })
})

describe('drafts and the case checker', () => {
  it('every draft passes the parser and the file fails assertReviewed', () => {
    const { drafts } = draftCases(input())
    const parsed = parseCases(drafts.map((d) => JSON.stringify(d)).join('\n'))
    expect(parsed).toHaveLength(drafts.length)
    expect(() => assertReviewed(parsed)).toThrow(/is a draft/)
  })
})

describe('helpers', () => {
  it('finds audit, path and bare transcript refs', () => {
    const found = findTranscriptRefs(`a ${ref(PREFIX, 12)} b /x/y/${SESSION}.jsonl:L${7} c L${40} d`)
    expect(found.map((f) => [f.session, f.line])).toEqual([[PREFIX, 12], [SESSION, 7], [null, 40]])
  })

  it('cuts without splitting a surrogate pair', () => {
    const text = `${'a'.repeat(999)}\u{1F600}${'b'.repeat(1500)}`
    const cut = cutQueryText(text)
    expect(cut.length).toBeLessThanOrEqual(2000)
    expect(cut.startsWith('a'.repeat(999))).toBe(true)
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('maps a class by its longest leading key and refuses an unknown lane', () => {
    const lanes = parseClassLanes('{"alpha": "scope", "alpha beta": "query"}')
    expect(proposeLane(lanes, 'alpha beta gap')).toBe('query')
    expect(proposeLane(lanes, 'alphabet')).toBe('none')
    expect(() => parseClassLanes('{"alpha": "somewhere"}')).toThrow(/must map to one of/)
  })
})

describe('engram-decision-replay CLI', () => {
  function capture(): { io: { stdout: (t: string) => void; stderr: (t: string) => void }; out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err }
  }

  function writeInputs(): string[] {
    const data = input()
    const files = {
      incidents: path.join(tmp, 'incidents.jsonl'),
      lanes: path.join(tmp, 'class-lanes.json'),
      cases: path.join(tmp, 'fc-cases.jsonl'),
      judgements: path.join(tmp, 'fc-out'),
      marked: path.join(tmp, 'marked.json'),
      misses: path.join(tmp, 'misses.md'),
    }
    fs.writeFileSync(files.incidents, data.incidents!)
    fs.writeFileSync(files.lanes, JSON.stringify(data.classLanes))
    fs.writeFileSync(files.cases, data.factcheck!.cases)
    fs.mkdirSync(files.judgements)
    data.factcheck!.judgements.forEach((text, i) => fs.writeFileSync(path.join(files.judgements, `out-${i}.jsonl`), text))
    fs.writeFileSync(files.marked, JSON.stringify({ useful: [], bad: data.factcheck!.markedBad }))
    fs.writeFileSync(files.misses, MISSES)
    return [
      '--incidents', files.incidents, '--class-lanes', files.lanes,
      '--factcheck-cases', files.cases, '--factcheck-judgements', files.judgements, '--marked', files.marked,
      '--misses', files.misses, '--projects-dir', projectsDir, '--expect-factcheck', '3',
    ]
  }

  it('drafts to private files, prints counts and no fixture text, and the drafts pass check --drafts only', () => {
    const outFile = path.join(tmp, 'replay', 'drafts.jsonl')
    const run = capture()
    expect(runCli(['draft', ...writeInputs(), '--out', outFile], run.io)).toBe(0)
    const stdout = run.out.join('')
    for (const text of [MK_FACT, DECISION_TEXT, MISSING_FACT_TEXT, SHORT_PROMPT, JUDGE_NOTE, JUDGE_MISSING, 'h'.repeat(50), 'the fixed port', SESSION]) {
      expect(stdout).not.toContain(text)
    }
    expect(stdout).toContain('drafts 6: incidents 2, factcheck 2, misses 2')
    expect(stdout).toContain('factcheck count 2 differs from the expected 3')
    expect(fs.statSync(outFile).mode & 0o777).toBe(0o600)
    expect(fs.statSync(`${outFile}.report.json`).mode & 0o777).toBe(0o600)

    const drafts = capture()
    expect(runCli(['check', '--cases', outFile, '--drafts'], drafts.io)).toBe(0)
    expect(drafts.out.join('')).toBe('cases 6: draft 6, reviewed 0, dropped 0; needed 3\n')
    const reviewed = capture()
    expect(runCli(['check', '--cases', outFile], reviewed.io)).toBe(1)
    expect(reviewed.err.join('')).toMatch(/is a draft/)
  })

  it('refuses to overwrite an existing output with exit 2', () => {
    const outFile = path.join(tmp, 'drafts.jsonl')
    fs.writeFileSync(outFile, '')
    const run = capture()
    expect(runCli(['draft', ...writeInputs(), '--out', outFile], run.io)).toBe(2)
    expect(run.err.join('')).toMatch(/exists/)
  })

  it('exits 2 on a usage error and 1 on a malformed case file', () => {
    const usage = capture()
    expect(runCli(['bogus'], usage.io)).toBe(2)
    const bad = path.join(tmp, 'bad.jsonl')
    fs.writeFileSync(bad, '{"id": "TST-CASE-1"}\n')
    const malformed = capture()
    expect(runCli(['check', '--cases', bad], malformed.io)).toBe(1)
    expect(malformed.err.join('')).toMatch(/case line 1: source is missing/)
  })
})
