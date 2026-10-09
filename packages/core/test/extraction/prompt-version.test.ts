import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'

import {
  DECISION_REPLY_SCHEMA,
  DECISION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTOR_VERSION,
} from '../../src/extraction/prompt.js'

// Each extractor version names exactly one set of prompts and reply schemas.
// Editing any of them without a new version (and a new pin here) fails this
// test, so a recorded run's version always identifies what it ran with. The
// first version had only the window prompt, so its digest covers that text
// alone; later versions hash the JSON array of every prompt and schema.
const PINNED_SHA256: Record<string, string> = {
  'extract-v1': '8b09fe2c023be1a170f3dd237dde123d3d2037ba115165792cb2215f0c44c772',
  'extract-v2': '5f9a4d0d5b6b6a6a2262c23155dc0364a6d93a5f63262bc8cfdd4bc759b1bd77',
  'extract-v3': '69278ae1a395b58a0206af92b7c3e0291557156187f35401318290a96b153f54',
  'extract-v4': '92ff2429a234c5f69c0bae59e0fcffa34f64cff45c883b1d59060a484e62e611',
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('extraction prompt version', () => {
  it('pins the prompts and reply schemas of the current extractor version', () => {
    const digest = sha256(JSON.stringify([EXTRACTION_SYSTEM_PROMPT, DECISION_SYSTEM_PROMPT, DECISION_REPLY_SCHEMA]))

    expect(PINNED_SHA256[EXTRACTOR_VERSION]).toBeDefined()
    expect(digest).toBe(PINNED_SHA256[EXTRACTOR_VERSION])
  })

  it('asks for the exact reply shapes the parsers enforce', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Reply with only a JSON object of exactly this shape:')
    expect(EXTRACTION_SYSTEM_PROMPT.endsWith('"evidence":[],"valid_at":null,"supersedes":[]}]}')).toBe(true)
    expect(DECISION_SYSTEM_PROMPT.endsWith('{"decisions":[{"item":0,"relation":"independent","targets":[],"corrects":[]}]}')).toBe(true)
    expect(DECISION_REPLY_SCHEMA.properties.decisions.items.required).toEqual(['item', 'relation', 'targets', 'corrects'])
  })
})
