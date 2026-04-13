export interface LongMemEvalMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string | number
}

export interface LongMemEvalSession {
  session_id: string
  messages: LongMemEvalMessage[]
  date?: string
}

export interface LongMemEvalQuestion {
  question_id: string
  question: string
  answer: string
  answer_session_ids: string[]
  memory_type: string
  haystack_sessions: LongMemEvalSession[]
}

export type LongMemEvalDataset = LongMemEvalQuestion[]
