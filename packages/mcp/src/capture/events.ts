/**
 * The capture event envelope as this client builds it, and the client
 * identity it sends. The shapes and limits are the route's own, imported
 * from its contract so client and server never drift apart.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CaptureClient,
  CaptureEvent as ContractCaptureEvent,
  CaptureEventOf,
  CaptureEventProject,
} from '../capture-events/contract.js'

export type {
  AnswerOption,
  AnswerQuestion,
  AssistantTool,
  AssistantTurnPayload,
  CaptureClient,
  UserAnswerPayload,
  UserPromptPayload,
} from '../capture-events/contract.js'

/** One capture event: `{session_id, event_uuid, type, occurred_at, cwd, project, plan_dirs, payload}`. */
export type CaptureEvent = ContractCaptureEvent

/** The event's project block: `{id, workspace, repo_root, branch, worktree}`. */
export type EventProject = CaptureEventProject

/** The events a transcript yields. */
export type TranscriptEvent = CaptureEventOf<'user_prompt'> | CaptureEventOf<'user_answer'> | CaptureEventOf<'assistant_turn'>

export const CAPTURE_CLIENT_NAME = 'engram-capture'

/**
 * Both `src/capture/events.ts` and `dist/capture/events.js` sit two levels
 * below the package's package.json. A missing or malformed file gives
 * "0.0.0": capture never fails for want of a version string.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const PACKAGE_VERSION = readPackageVersion()

/** The request's `client` block: this library under the package's version. */
export function captureClientInfo(): CaptureClient {
  return { name: CAPTURE_CLIENT_NAME, version: PACKAGE_VERSION }
}

/**
 * The on-disk name for a session's files (its spool directory, its cursor):
 * `encodeURIComponent(session_id)`, with a leading `.` written as `%2E`
 * because names that start with `.` belong to the spool and cursor stores.
 */
export function sessionFileName(sessionId: string): string {
  if (sessionId.length === 0) throw new Error('session id must not be empty')
  const encoded = encodeURIComponent(sessionId)
  return encoded.startsWith('.') ? `%2E${encoded.slice(1)}` : encoded
}
