export interface LoCoMoTurn {
  dia_id: number
  speaker: string
  text: string
  date?: string
  blip_caption?: string
}

export interface LoCoMoQA {
  id: string
  question: string
  answer: string
  evidence_ids: string[]
  category: number
}

export interface LoCoMoConversationFile {
  id: string | number
  conversation: LoCoMoTurn[]
  qa: LoCoMoQA[]
}
