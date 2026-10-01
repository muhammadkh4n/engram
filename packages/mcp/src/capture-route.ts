/**
 * The body of the HTTP server's capture route: validate a capture request,
 * run the capture pipeline, and map the outcome to a status code.
 *
 * Status codes let a client tell a capture it must never resend from one
 * worth retrying: 400 = the request is invalid (`retryable: false`), 500 =
 * anything that failed after validation (`retryable: true`), 200 = every
 * pipeline outcome, including rejections.
 */

import {
  runCapture,
  runDerivedCapture,
  type CaptureDeps,
  type CaptureDeriveKind,
  type CaptureInput,
  type CaptureOutcome,
  type DerivedCaptureInput,
} from './ingest/capture.js'
import { normalizeProjectId } from './ingest/project-detect.js'

/** Clients cut captures to this length before sending. */
export const CAPTURE_CONTENT_MAX_CHARS = 100_000
export const CAPTURE_KEY_MAX_CHARS = 128
export const CAPTURE_SESSION_ID_MAX_CHARS = 256
export const CAPTURE_META_MAX_KEYS = 8
export const CAPTURE_META_VALUE_MAX_CHARS = 512
export const CAPTURE_META_KEY_MAX_CHARS = 128

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const ROLES = ['user', 'assistant', 'system'] as const
const DERIVE_KINDS: readonly CaptureDeriveKind[] = ['session-summary', 'pre-compact']
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'content',
  'role',
  'session_id',
  'project_id',
  'source',
  'gate',
  'dedup',
  'derive',
  'dry_run',
  'key',
  'meta',
])

export type CaptureRequest =
  | { kind: 'turn'; input: CaptureInput }
  | { kind: 'derive'; input: DerivedCaptureInput }

export interface CaptureRouteDeps {
  /** Reported on every response, including validation failures. */
  captureModel: string
  /** Resolved only for a valid request, so a bad request never opens the stores. */
  captureDeps: () => Promise<CaptureDeps>
  log?: (line: string) => void
}

export interface CaptureResponse {
  status: number
  body: CaptureOutcome
}

type Parsed<T> = { value: T } | { error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function optionalBoolean(body: Record<string, unknown>, field: string, fallback: boolean): Parsed<boolean> {
  const v = body[field]
  if (v === undefined) return { value: fallback }
  if (typeof v !== 'boolean') return { error: `${field} must be a boolean` }
  return { value: v }
}

function optionalString(body: Record<string, unknown>, field: string, maxChars: number): Parsed<string | undefined> {
  const v = body[field]
  if (v === undefined) return { value: undefined }
  if (typeof v !== 'string' || v.trim().length === 0) return { error: `${field} must be a non-empty string` }
  if (v.length > maxChars) return { error: `${field} exceeds ${maxChars} characters` }
  return { value: v }
}

function parseMeta(v: unknown): Parsed<Record<string, string> | undefined> {
  if (v === undefined) return { value: undefined }
  if (!isPlainObject(v)) return { error: 'meta must be an object of strings' }
  const entries = Object.entries(v)
  if (entries.length > CAPTURE_META_MAX_KEYS) {
    return { error: `meta allows at most ${CAPTURE_META_MAX_KEYS} keys, got ${entries.length}` }
  }
  for (const [k, val] of entries) {
    if (k.length > CAPTURE_META_KEY_MAX_CHARS) {
      return { error: `meta key names are limited to ${CAPTURE_META_KEY_MAX_CHARS} characters` }
    }
    if (typeof val !== 'string') return { error: `meta.${k} must be a string` }
    if (val.length > CAPTURE_META_VALUE_MAX_CHARS) {
      return { error: `meta.${k} exceeds ${CAPTURE_META_VALUE_MAX_CHARS} characters` }
    }
  }
  return { value: Object.fromEntries(entries) as Record<string, string> }
}

function parseContent(v: unknown): Parsed<string> {
  if (typeof v !== 'string' || v.trim().length === 0) return { error: 'content must be a non-empty string' }
  if (v.length > CAPTURE_CONTENT_MAX_CHARS) {
    return { error: `content exceeds ${CAPTURE_CONTENT_MAX_CHARS} characters (${v.length})` }
  }
  return { value: v }
}

function parseDerive(v: unknown): Parsed<CaptureDeriveKind | undefined> {
  if (v === undefined) return { value: undefined }
  if (typeof v !== 'string' || !DERIVE_KINDS.includes(v as CaptureDeriveKind)) {
    return { error: `derive must be one of ${DERIVE_KINDS.map((k) => `"${k}"`).join(', ')}` }
  }
  return { value: v as CaptureDeriveKind }
}

/**
 * Unknown fields are refused rather than ignored: a misspelt `dry_run` or
 * `gate` would otherwise store a row the caller meant to keep out.
 */
export function parseCaptureRequest(body: unknown): CaptureRequest | { error: string } {
  if (!isPlainObject(body)) return { error: 'the body must be a JSON object' }
  const unknown = Object.keys(body).filter((k) => !KNOWN_FIELDS.has(k))
  if (unknown.length > 0) return { error: `unknown field(s): ${unknown.join(', ')}` }

  const source = body['source']
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
    return { error: `source must match ${SOURCE_PATTERN.source}` }
  }
  const content = parseContent(body['content'])
  if ('error' in content) return content
  const sessionId = optionalString(body, 'session_id', CAPTURE_SESSION_ID_MAX_CHARS)
  if ('error' in sessionId) return sessionId
  const key = optionalString(body, 'key', CAPTURE_KEY_MAX_CHARS)
  if ('error' in key) return key
  const gate = optionalBoolean(body, 'gate', true)
  if ('error' in gate) return gate
  const dedup = optionalBoolean(body, 'dedup', true)
  if ('error' in dedup) return dedup
  const dryRun = optionalBoolean(body, 'dry_run', false)
  if ('error' in dryRun) return dryRun
  const derive = parseDerive(body['derive'])
  if ('error' in derive) return derive
  const meta = parseMeta(body['meta'])
  if ('error' in meta) return meta

  // A malformed project_id must not silently store the capture shared.
  const rawProject = body['project_id']
  if (rawProject !== undefined && rawProject !== null && typeof rawProject !== 'string') {
    return { error: 'project_id must be a string' }
  }
  const project = normalizeProjectId(rawProject) ?? null
  const common = {
    content: content.value,
    source,
    project,
    dryRun: dryRun.value,
    ...(sessionId.value ? { sessionId: sessionId.value } : {}),
    ...(key.value ? { key: key.value } : {}),
    ...(meta.value ? { meta: meta.value } : {}),
  }
  if (derive.value) {
    // A digest is always stored as a system turn with its own dedup rule.
    return { kind: 'derive', input: { ...common, derive: derive.value } }
  }

  const role = body['role']
  if (typeof role !== 'string' || !ROLES.includes(role as (typeof ROLES)[number])) {
    return { error: 'role must be one of "user", "assistant", or "system"' }
  }
  return {
    kind: 'turn',
    input: { ...common, role: role as CaptureInput['role'], gate: gate.value, dedup: dedup.value },
  }
}

function errorOutcome(model: string, retryable: boolean, message: string): CaptureOutcome {
  return { outcome: 'error', model, retryable, message }
}

/** A request that failed validation: 400 with a permanent error outcome. */
export function invalidCaptureResponse(captureModel: string, message: string, status = 400): CaptureResponse {
  return { status, body: errorOutcome(captureModel, false, message) }
}

export async function runCaptureRequest(deps: CaptureRouteDeps, body: unknown): Promise<CaptureResponse> {
  const request = parseCaptureRequest(body)
  if ('error' in request) return invalidCaptureResponse(deps.captureModel, request.error)
  try {
    const captureDeps = await deps.captureDeps()
    const outcome =
      request.kind === 'derive'
        ? await runDerivedCapture(captureDeps, request.input)
        : await runCapture(captureDeps, request.input)
    return { status: 200, body: outcome }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.log?.(`capture failed (source=${request.input.source}): ${message}`)
    return { status: 500, body: errorOutcome(deps.captureModel, true, message) }
  }
}
