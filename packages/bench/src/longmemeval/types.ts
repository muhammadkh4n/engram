/**
 * LongMemEval dataset types (cleaned 2025/09 distribution).
 *
 * Source: https://github.com/xiaowu0162/LongMemEval (ICLR 2025)
 * Download: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 *
 * Per-question shape (500 independent questions in longmemeval_s_cleaned.json):
 *   {
 *     question_id, question_type, question, question_date, answer,
 *     answer_session_ids: string[]          — gold evidence session IDs
 *     haystack_dates: string[]              — parallel to haystack_sessions
 *     haystack_session_ids: string[]        — parallel to haystack_sessions
 *     haystack_sessions: Array<Array<{role,content}>>   — chat history per session
 *   }
 *
 * Note: this shape differs from the earlier (pre-2025/09) format that used
 *   { session_id, messages, date } objects inside haystack_sessions. The
 *   adapter parses the modern shape.
 */

export type LongMemEvalQuestionType =
  | 'single-session-user'
  | 'single-session-assistant'
  | 'single-session-preference'
  | 'multi-session'
  | 'knowledge-update'
  | 'temporal-reasoning'
  | 'abstention'

export interface LongMemEvalTurn {
  role: 'user' | 'assistant'
  content: string
}

/** A session is just an ordered list of turns. The session_id lives in the
 *  parallel haystack_session_ids array on the parent question. */
export type LongMemEvalSession = LongMemEvalTurn[]

export interface LongMemEvalQuestion {
  question_id: string
  question_type: LongMemEvalQuestionType
  question: string
  question_date: string
  answer: string
  answer_session_ids: string[]
  haystack_dates: string[]
  haystack_session_ids: string[]
  haystack_sessions: LongMemEvalSession[]
}

export type LongMemEvalDataset = LongMemEvalQuestion[]
