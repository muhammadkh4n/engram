import { describe, expect, it } from 'vitest'
import * as capture from '../../src/capture/index.js'
import type {
  CaptureEvent,
  CaptureRegistry,
  DrainResult,
  EventProject,
  TranscriptCursor,
} from '../../src/capture/index.js'

describe('capture library entry', () => {
  it('exports every library function', () => {
    const names = [
      'captureClientInfo',
      'eventUuidFromParts',
      'readTranscriptEvents',
      'humanPromptText',
      'cursorRoot',
      'loadCursor',
      'saveCursor',
      'withReaderLock',
      'planDirsAfter',
      'spoolRoot',
      'writeSpoolBatch',
      'drainSpool',
      'captureEventsEndpoint',
      'readCaptureToken',
      'appendCaptureLog',
      'loadCaptureRegistry',
      'resolveEventProject',
      'detectCheckout',
      'spoolTranscript',
      'scrubEvent',
    ]
    for (const name of names) expect(typeof (capture as Record<string, unknown>)[name], name).toBe('function')
  })

  it('exports the library types', () => {
    const project: EventProject = { id: null, workspace: null, repo_root: null, branch: null, worktree: null }
    const types: Array<CaptureEvent | CaptureRegistry | DrainResult | TranscriptCursor | EventProject> = [project]
    expect(types).toHaveLength(1)
  })
})
