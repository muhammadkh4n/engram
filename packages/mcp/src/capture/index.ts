/**
 * The capture library: transcript reader, cursor, spool and drainer. Hooks
 * and the backfill import from here rather than from the modules.
 */

export { captureClientInfo, type CaptureEvent, type EventProject, type TranscriptEvent } from './events.js'
export { eventUuidFromParts } from './event-uuid.js'
export {
  humanPromptText,
  readTranscriptEvents,
  type ReadTranscriptOptions,
  type ReadTranscriptResult,
} from './transcript-reader.js'
export { cursorRoot, loadCursor, saveCursor, type TranscriptCursor, withReaderLock } from './transcript-cursor.js'
export { planDirsAfter } from './plan-dirs.js'
export {
  type DrainOptions,
  type DrainResult,
  type DrainStop,
  drainSpool,
  spoolRoot,
  writeDeadLetters,
  writeSpoolBatch,
} from './spool.js'
export { readyForRoute, type RouteCheck, type RouteCheckOptions } from './route-fit.js'
export { captureEventsEndpoint, readCaptureToken } from './endpoint.js'
export { appendCaptureLog } from './log.js'
export { type CaptureRegistry, loadCaptureRegistry, resolveEventProject } from './event-project.js'
export { type Checkout, detectCheckout } from '../ingest/project-detect.js'
export { spoolTranscript, type SpoolTranscriptOptions, type SpoolTranscriptResult } from './spool-transcript.js'
export { scrubEvent } from '../capture-events/scrub.js'
