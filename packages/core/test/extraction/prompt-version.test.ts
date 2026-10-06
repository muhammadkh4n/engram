import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'

import { EXTRACTION_SYSTEM_PROMPT, EXTRACTOR_VERSION } from '../../src/extraction/prompt.js'

// Each extractor version names exactly one prompt text. Editing the prompt
// without a new version (and a new pin here) fails this test, so a recorded
// run's version always identifies the prompt it ran with.
const PINNED_PROMPT_SHA256: Record<string, string> = {
  'extract-v1': '8b09fe2c023be1a170f3dd237dde123d3d2037ba115165792cb2215f0c44c772',
}

describe('extraction prompt version', () => {
  it('pins the prompt text of the current extractor version', () => {
    const digest = createHash('sha256').update(EXTRACTION_SYSTEM_PROMPT, 'utf8').digest('hex')

    expect(PINNED_PROMPT_SHA256[EXTRACTOR_VERSION]).toBeDefined()
    expect(digest).toBe(PINNED_PROMPT_SHA256[EXTRACTOR_VERSION])
  })

  it('asks for the exact reply shape the parser enforces', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Reply with only a JSON object of exactly this shape:')
    expect(EXTRACTION_SYSTEM_PROMPT.endsWith('"evidence":[],"valid_at":null,"supersedes":[]}]}')).toBe(true)
  })
})
