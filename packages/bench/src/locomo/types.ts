/** A single dialogue turn in a LoCoMo session. */
export interface LoCoMoTurn {
  /** Evidence ID string e.g. "D1:3" — segment:turn within that segment */
  dia_id: string
  /** Speaker name (e.g. "Caroline", "Melanie") */
  speaker: string
  text: string
}

/** A QA pair from the LoCoMo dataset. */
export interface LoCoMoQA {
  question: string
  answer: string | number
  /** Evidence IDs e.g. ["D1:3", "D1:12"] */
  evidence: string[]
  category: number
}

/**
 * Raw LoCoMo conversation file structure.
 * conversation is an object with session_N arrays and session_N_date_time strings.
 */
export interface LoCoMoConversationFile {
  sample_id: string
  conversation: {
    speaker_a: string
    speaker_b: string
    [key: string]: string | LoCoMoTurn[] // session_N: LoCoMoTurn[], session_N_date_time: string
  }
  qa: LoCoMoQA[]
  event_summary?: unknown
  observation?: unknown
  session_summary?: unknown
}
