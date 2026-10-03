/**
 * Sends a transcript excerpt to be digested and stored, for the
 * session-summary and pre-compact hooks.
 *
 * With ENGRAM_SERVER_URL set the excerpt is scrubbed here and posted to the
 * server's `POST /capture` route as a derive capture; the server runs the
 * digest model and the store with its own configuration, and a capture it
 * cannot take now is spooled under ~/.engram/. Without it, the in-process
 * pipeline (loaded on demand) digests and stores with this machine's
 * credentials.
 */

import { join } from 'node:path'
import { CAPTURE_CONTENT_MAX_CHARS, CAPTURE_META_VALUE_MAX_CHARS } from '../capture-route.js'
import type { CaptureDeriveKind, CaptureOutcome } from './capture.js'
import {
  captureKey,
  cwdMeta,
  engramDir,
  sendCapture,
  type CaptureEnv,
  type CaptureMetaKey,
  type CapturePayload,
} from './capture-client.js'
import { appendPrivateFile, ensurePrivateDir } from './private-files.js'
import { scrubModelInput } from './scrub-model-input.js'
import type { TranscriptExcerpt } from './transcript-excerpt.js'

export const TRANSCRIPT_CAPTURE_SOURCE = 'claude-code'

export interface TranscriptCaptureRequest {
  derive: CaptureDeriveKind
  excerpt: TranscriptExcerpt
  transcriptPath: string
  sessionId: string
  project: string | null
  /** Provenance besides `capturedAt`, which is always set. */
  meta: Partial<Record<Exclude<CaptureMetaKey, 'capturedAt'>, string>>
  /** e.g. `[engram-summary]`: the scrubber's log prefix and the summary line's label. */
  logPrefix: string
  /** Server mode only: request timeout (defaults to the derive timeout). */
  timeoutMs?: number
  /** Server mode only: time allowed for flushing the spool after a success. */
  flushBudgetMs?: number
}

export interface TranscriptCaptureResult {
  /** The pipeline's outcome; absent when the capture was spooled or dead-lettered. */
  outcome?: CaptureOutcome
  /** One summary line for `hook.log`, without a trailing newline. */
  line: string
  exitCode: number
}

/**
 * Stable across reruns of the same hook on the same transcript: the newest
 * turn's uuid marks how far the excerpt reaches, so a resumed session that
 * ends or compacts again later gets a new key.
 */
export function transcriptCaptureKey(request: TranscriptCaptureRequest): string {
  const reach = request.excerpt.lastUuid ?? request.excerpt.text
  return captureKey(TRANSCRIPT_CAPTURE_SOURCE, request.sessionId, `${request.derive}:${request.transcriptPath}:${reach}`)
}

/**
 * The route refuses a meta value above its cap, which would dead-letter the
 * capture, so long values are cut; a long cwd is left out instead (cwdMeta).
 */
function clipMeta(meta: TranscriptCaptureRequest['meta'], logPrefix: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v !== 'string' || !v) continue
    if (k === 'cwd') Object.assign(out, cwdMeta(v, logPrefix))
    else out[k] = v.slice(0, CAPTURE_META_VALUE_MAX_CHARS)
  }
  return out
}

async function sendToServer(request: TranscriptCaptureRequest, env: CaptureEnv): Promise<TranscriptCaptureResult> {
  const content = (await scrubModelInput(request.excerpt.text, request.logPrefix)).slice(0, CAPTURE_CONTENT_MAX_CHARS)
  const payload: CapturePayload = {
    content,
    source: TRANSCRIPT_CAPTURE_SOURCE,
    role: 'system',
    derive: request.derive,
    session_id: request.sessionId,
    project_id: request.project,
    key: transcriptCaptureKey(request),
    meta: { ...clipMeta(request.meta, request.logPrefix), capturedAt: new Date().toISOString() },
  }
  const sent = await sendCapture(payload, env, {
    label: request.logPrefix.replace(/^\[|\]$/g, ''),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.flushBudgetMs !== undefined ? { flushBudgetMs: request.flushBudgetMs } : {}),
  })
  return {
    ...(sent.result.ok ? { outcome: sent.result.outcome } : {}),
    line: `${sent.line} derive=${request.derive}`,
    exitCode: sent.disposition === 'dead' ? 1 : 0,
  }
}

async function runLocally(request: TranscriptCaptureRequest, env: CaptureEnv): Promise<TranscriptCaptureResult> {
  const startMs = Date.now()
  // Loaded on demand so server mode never loads the model and store clients.
  const { runLocalDerivedCapture } = await import('./local-capture.js')
  const { outcome, model } = await runLocalDerivedCapture(
    {
      content: request.excerpt.text,
      derive: request.derive,
      sessionId: request.sessionId,
      project: request.project,
      source: TRANSCRIPT_CAPTURE_SOURCE,
      dryRun: false,
      meta: clipMeta(request.meta, request.logPrefix),
    },
    { env, logPrefix: request.logPrefix },
  )
  const parts = [
    `${request.logPrefix} mode=local model=${model} source=${TRANSCRIPT_CAPTURE_SOURCE}`,
    `derive=${request.derive} outcome=${outcome.outcome} ms=${Date.now() - startMs}`,
  ]
  if (outcome.outcome === 'error') parts.push(`error=${JSON.stringify(outcome.message ?? outcome.reason ?? '')}`)
  return { outcome, line: parts.join(' '), exitCode: outcome.outcome === 'error' ? 1 : 0 }
}

export async function sendTranscriptCapture(
  request: TranscriptCaptureRequest,
  env: CaptureEnv,
): Promise<TranscriptCaptureResult> {
  return env['ENGRAM_SERVER_URL'] ? sendToServer(request, env) : runLocally(request, env)
}

/** Best effort: a hook must not fail because its audit log is unwritable. */
export function appendHookLog(env: CaptureEnv, line: string): void {
  try {
    const dir = engramDir(env)
    ensurePrivateDir(dir)
    appendPrivateFile(join(dir, 'hook.log'), `${line}\n`)
  } catch {
    // The line was already written to stderr.
  }
}
