import { describe, it, expect } from 'vitest'
import {
  judgeReaderContext,
  parseJudgeContextMode,
  type JudgeContextConfig,
  type JudgeSweepRow,
} from '../src/longmemeval/forensics/context-modes.js'
import { buildGenUserPrompt } from '../src/longmemeval/forensics/gen-prompt.js'

// Shaped like a recorded MCP recall payload after the namespace strip:
// tagged lines, a Related section, a Faint Associations section, trailing
// whitespace kept so a trim would be observable.
const PAYLOAD = [
  '## Engram — Recalled Conversation Memory',
  '',
  '### Recalled Memories\n',
  '- [episode · user · 2023-05-20] I moved the herb planters to the balcony last weekend.',
  '\n### Related Memories\n',
  '- [digest · 2023-05-21] Gardening: balcony planters, basil, watering schedule.',
  '\n### Faint Associations\n',
  '- [episode · user · 2023-04-02] The hardware store had terracotta pots on sale.  ',
  '',
].join('\n')

const SESSIONS_ROW: JudgeSweepRow = {
  question_id: 'q-1',
  retrieved_session_ids: ['s1', 's2', 's3', 's4'],
  synthesis: { text: '- derived: 3 days between visits' },
}

const FORMATTED_ROW: JudgeSweepRow = {
  question_id: 'q-2',
  retrieved_session_ids: ['s9', 's8'],
  formatted: PAYLOAD,
  gold_ids_in_context: ['s8'],
}

function recordingRebuild(): ((ids: readonly string[]) => string) & { calls: string[][] } {
  const calls: string[][] = []
  const fn = (ids: readonly string[]): string => {
    calls.push([...ids])
    return ids.map((id) => `=== Session ${id} (2023/05/20 (Sat) 02:21) ===\nuser: hi`).join('\n\n')
  }
  return Object.assign(fn, { calls })
}

const SESSIONS_CFG: JudgeContextConfig = { contextMode: 'sessions', topSessions: 2, includeSynthesis: true }
const FORMATTED_CFG: JudgeContextConfig = { contextMode: 'formatted', topSessions: 5, includeSynthesis: false }

describe('parseJudgeContextMode', () => {
  it('defaults to sessions', () => {
    expect(parseJudgeContextMode(['--top-sessions', '5', '--include-synthesis'])).toBe('sessions')
  })
  it('accepts formatted', () => {
    expect(parseJudgeContextMode(['--context-mode', 'formatted'])).toBe('formatted')
  })
  it('rejects an unknown or missing value', () => {
    expect(() => parseJudgeContextMode(['--context-mode', 'raw'])).toThrow(/sessions" or "formatted/)
    expect(() => parseJudgeContextMode(['--context-mode'])).toThrow(/needs a value/)
  })
  it('rejects --top-sessions with formatted', () => {
    expect(() => parseJudgeContextMode(['--context-mode', 'formatted', '--top-sessions', '5'])).toThrow(/--top-sessions/)
  })
  it('rejects --include-synthesis with formatted', () => {
    expect(() => parseJudgeContextMode(['--include-synthesis', '--context-mode', 'formatted'])).toThrow(/--include-synthesis/)
  })
})

describe('judgeReaderContext — formatted', () => {
  it('passes the recorded payload through unchanged and never rebuilds sessions', () => {
    const rebuild = recordingRebuild()
    const out = judgeReaderContext(FORMATTED_ROW, FORMATTED_CFG, rebuild)
    expect(out.context).toBe(PAYLOAD)
    expect(out.synthesisText).toBeUndefined()
    expect(out.sessionsUsed).toBe(0)
    expect(rebuild.calls).toEqual([])
  })
  it('records context_mode, context_chars and gold_ids_in_context', () => {
    const out = judgeReaderContext(FORMATTED_ROW, FORMATTED_CFG, recordingRebuild())
    expect(out.rowFields).toEqual({ context_mode: 'formatted', context_chars: PAYLOAD.length, gold_ids_in_context: ['s8'] })
  })
  it('keeps an empty payload as the empty context', () => {
    const out = judgeReaderContext({ ...FORMATTED_ROW, formatted: '', gold_ids_in_context: [] }, FORMATTED_CFG, recordingRebuild())
    expect(out.context).toBe('')
    expect(out.rowFields).toEqual({ context_mode: 'formatted', context_chars: 0, gold_ids_in_context: [] })
  })
  it('the gen prompt differs from the sessions prompt only in the context block', () => {
    const out = judgeReaderContext(FORMATTED_ROW, FORMATTED_CFG, recordingRebuild())
    const prompt = buildGenUserPrompt('2023/05/30 (Tue) 23:40', out.context, 'Where are the planters?', out.synthesisText)
    expect(prompt).toBe(
      `Today's date is 2023/05/30 (Tue) 23:40.\n\n## Relevant past sessions\n${PAYLOAD}\n\n## Question\nWhere are the planters?\n\n## Answer`,
    )
  })
  it('throws naming the question id when the row has no formatted payload', () => {
    const { formatted: _omit, ...row } = FORMATTED_ROW
    expect(() => judgeReaderContext(row, FORMATTED_CFG, recordingRebuild())).toThrow(/q-2.*formatted/)
  })
  it('throws naming the question id when the row has no gold_ids_in_context', () => {
    const { gold_ids_in_context: _omit, ...row } = FORMATTED_ROW
    expect(() => judgeReaderContext(row, FORMATTED_CFG, recordingRebuild())).toThrow(/q-2.*gold_ids_in_context/)
  })
})

describe('judgeReaderContext — sessions keeps the historical behaviour', () => {
  it('rebuilds the top-N retrieved sessions in rank order and adds synthesis when asked', () => {
    const rebuild = recordingRebuild()
    const out = judgeReaderContext(SESSIONS_ROW, SESSIONS_CFG, rebuild)
    expect(rebuild.calls).toEqual([['s1', 's2']])
    expect(out).toEqual({
      context: rebuild(['s1', 's2']),
      synthesisText: '- derived: 3 days between visits',
      sessionsUsed: 2,
    })
    expect(out.rowFields).toBeUndefined()
  })
  it('omits synthesis without --include-synthesis and ignores a formatted field on the row', () => {
    const out = judgeReaderContext({ ...SESSIONS_ROW, formatted: PAYLOAD }, { ...SESSIONS_CFG, includeSynthesis: false }, recordingRebuild())
    expect(Object.keys(out).sort()).toEqual(['context', 'sessionsUsed'])
    expect(out.context).not.toContain('Recalled Memories')
  })
  it('counts only sessions that were available when the list is shorter than N', () => {
    const out = judgeReaderContext({ ...SESSIONS_ROW, retrieved_session_ids: ['s1'] }, { ...SESSIONS_CFG, topSessions: 5 }, recordingRebuild())
    expect(out.sessionsUsed).toBe(1)
  })
})
