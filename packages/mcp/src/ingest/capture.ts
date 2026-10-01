/**
 * The capture pipeline: one path from a raw hook/CLI turn to a stored memory.
 *
 * Scrub → classify (or raw) → project for category → threshold gate →
 * dry-run → dedup (boosting the duplicate) → Memory.ingest with provenance
 * metadata. The CLI's local mode and the HTTP server's capture route both
 * call runCapture, each with its own stores, model and secret registry, so
 * a capture behaves the same wherever it runs.
 */

import type {
  IntelligenceAdapter,
  Memory,
  SalienceCategory,
  SalienceClassification,
  StorageAdapter,
} from '@engram-mem/core'
import { findDuplicate, boostDuplicate } from './dedup.js'
import { projectForCategory } from './project-detect.js'
import { scrubModelInput } from './scrub-model-input.js'

/** rawTurn keeps the start of the scrubbed turn for audit without storing whole transcripts twice. */
export const RAW_TURN_MAX_CHARS = 4000
/** A replayed key is only honoured inside this window, matching the dedup window. */
export const CAPTURE_KEY_WINDOW_DAYS = 7

/** Recorded as the capture model of a turn stored without classification: no model saw it. */
export const RAW_CAPTURE_MODEL = 'raw'

const DAY_MS = 24 * 60 * 60 * 1000

export type CaptureRole = 'user' | 'assistant' | 'system'

export type CaptureOutcomeKind =
  | 'stored'
  | 'rejected'
  | 'deduped'
  | 'replayed'
  | 'dry_run'
  | 'error'

export interface CaptureOutcome {
  outcome: CaptureOutcomeKind
  /** The model that classified (or would have classified) the capture. */
  model: string
  category?: SalienceCategory
  confidence?: number
  reason?: string
  /** The project the memory is (or would be) stored under; absent = shared. */
  project?: string
  duplicateOf?: string
  similarity?: number
  context?: string
  /** Error outcomes only: false = the capture failed validation. */
  retryable?: boolean
  message?: string
}

export interface CaptureDedupOptions {
  threshold: number
  windowDays: number
}

export interface CaptureInput {
  content: string
  role: CaptureRole
  sessionId?: string
  /** The caller's detected project; absent or null = shared. */
  project?: string | null
  source: string
  /** false = store the text verbatim as a fact, skipping the classifier. */
  gate: boolean
  dedup: boolean | CaptureDedupOptions
  dryRun: boolean
  /** Idempotency key, honoured together with sessionId. */
  key?: string
  /** Provenance values merged into the stored metadata. */
  meta?: Record<string, string>
}

/** What a rejected capture looked like, for callers that keep a rejection log. */
export interface RejectedCapture {
  /** The scrubbed content. */
  content: string
  classification: SalienceClassification
  /** The caller's project before category scoping. */
  project: string | null
  role: CaptureRole
  source: string
}

export interface CaptureDeps {
  /** Called only when a row will be stored, so rejected and duplicate paths skip graph setup. */
  getMemory: () => Promise<Memory>
  /**
   * Store for the idempotency and dedup checks. A function is resolved only
   * when one of those checks runs, so a caller can defer connecting.
   */
  storage: StorageAdapter | (() => Promise<StorageAdapter>)
  intelligence: IntelligenceAdapter
  threshold: number
  /** Name of the model behind intelligence.extractSalience, recorded on every capture. */
  captureModel: string
  /** Verbose diagnostics; lines carry no prefix. */
  log?: (line: string) => void
  /** Prefix for the scrubber's redaction line. */
  logPrefix?: string
  onRejected?: (rejected: RejectedCapture) => void
}

function rawClassification(content: string): SalienceClassification {
  return { store: true, category: 'fact', confidence: 1, distilled: content, reason: 'raw_mode' }
}

function tooShortClassification(): SalienceClassification {
  return { store: false, category: 'none', confidence: 0, distilled: '', reason: 'too_short' }
}

function classificationFields(c: SalienceClassification): Pick<CaptureOutcome, 'category' | 'confidence' | 'reason'> {
  return { category: c.category, confidence: c.confidence, reason: c.reason }
}

async function resolveStorage(storage: CaptureDeps['storage']): Promise<StorageAdapter> {
  return typeof storage === 'function' ? storage() : storage
}

async function findReplay(deps: CaptureDeps, sessionId: string, key: string): Promise<boolean> {
  const storage = await resolveStorage(deps.storage)
  if (!storage.episodes.findIdByCaptureKey) {
    throw new Error('storage adapter lacks findIdByCaptureKey')
  }
  const since = new Date(Date.now() - CAPTURE_KEY_WINDOW_DAYS * DAY_MS)
  return (await storage.episodes.findIdByCaptureKey(sessionId, key, { since })) !== null
}

async function classify(
  deps: CaptureDeps,
  input: CaptureInput,
  content: string,
): Promise<SalienceClassification> {
  if (content.length < 2) return tooShortClassification()
  if (!input.gate) return rawClassification(content)
  if (!deps.intelligence.extractSalience) {
    throw new Error('intelligence adapter lacks extractSalience')
  }
  return deps.intelligence.extractSalience(content, {
    turnRole: input.role,
    ...(input.project ? { project: input.project } : {}),
  })
}

async function checkDuplicate(
  deps: CaptureDeps,
  input: CaptureInput,
  distilled: string,
  project: string | null,
): Promise<{ id: string; similarity: number } | null> {
  if (input.dedup === false) return null
  const storage = await resolveStorage(deps.storage)
  const tuning = typeof input.dedup === 'object' ? input.dedup : {}
  const dup = await findDuplicate(distilled, storage, deps.intelligence, {
    ...tuning,
    ...(project ? { project } : {}),
  })
  if (dup.debug) {
    const d = dup.debug
    deps.log?.(
      `dedup: candidates=${d.candidatesReturned} topSim=${d.topSimilarity.toFixed(3)} topProj=${d.topProject ?? 'null'} rejByThresh=${d.rejectedByThreshold} rejByWindow=${d.rejectedByWindow} rejByProj=${d.rejectedByProject}`,
    )
  }
  if (!dup.duplicateId) return null
  await boostDuplicate(storage, dup.duplicateId)
  return { id: dup.duplicateId, similarity: dup.similarity }
}

function captureMetadata(
  model: string,
  input: CaptureInput,
  classification: SalienceClassification,
  content: string,
  project: string | null,
): Record<string, unknown> {
  // Caller-supplied provenance goes first so it can never overwrite the
  // fields the pipeline itself decides.
  return {
    ...(input.meta ?? {}),
    salienceCategory: classification.category,
    salienceConfidence: classification.confidence,
    salienceReason: classification.reason,
    source: input.source,
    ...(project ? { project } : {}),
    rawTurn: content.slice(0, RAW_TURN_MAX_CHARS),
    captureModel: model,
    ...(input.key ? { captureKey: input.key } : {}),
  }
}

export async function runCapture(deps: CaptureDeps, input: CaptureInput): Promise<CaptureOutcome> {
  const model = input.gate ? deps.captureModel : RAW_CAPTURE_MODEL

  // A retried capture must not pay for a second classification.
  if (input.key && input.sessionId && (await findReplay(deps, input.sessionId, input.key))) {
    deps.log?.(`replayed: key=${input.key} already stored for session ${input.sessionId}`)
    return { outcome: 'replayed', model }
  }
  return captureUnseenKey(deps, input, model)
}

/**
 * The pipeline after the idempotency check. The classifier's errors
 * propagate: a failed or unparseable classification is no verdict, so the
 * caller reports it as retryable instead of logging a rejection.
 */
async function captureUnseenKey(deps: CaptureDeps, input: CaptureInput, model: string): Promise<CaptureOutcome> {
  // Every later consumer (classifier, rejection callback, dedup embedding,
  // rawTurn metadata) reads this scrubbed copy.
  const content = await scrubModelInput(input.content, deps.logPrefix ?? '[engram-capture]')

  const classification = await classify(deps, input, content)
  deps.log?.(
    `classifier: store=${classification.store} category=${classification.category} confidence=${classification.confidence.toFixed(2)} reason="${classification.reason}"`,
  )

  const detected = input.project ?? null
  // Preferences and facts about people hold in every project: they are
  // stored shared even when the turn happened inside a repository.
  const project = projectForCategory(detected, classification.category)
  const decided = { model, ...classificationFields(classification), ...(project ? { project } : {}) }

  if (!classification.store || classification.confidence < deps.threshold) {
    deps.onRejected?.({ content, classification, project: detected, role: input.role, source: input.source })
    deps.log?.(
      `rejected: store=${classification.store} confidence=${classification.confidence.toFixed(2)} threshold=${deps.threshold}`,
    )
    return { outcome: 'rejected', ...decided }
  }

  if (input.dryRun) {
    deps.log?.(`[dry-run] would store: "${classification.distilled}"`)
    return { outcome: 'dry_run', ...decided }
  }

  const duplicate = await checkDuplicate(deps, input, classification.distilled, project)
  if (duplicate) {
    deps.log?.(`deduped: existing=${duplicate.id.slice(0, 8)} similarity=${duplicate.similarity.toFixed(3)}`)
    return { outcome: 'deduped', ...decided, duplicateOf: duplicate.id, similarity: duplicate.similarity }
  }

  const memory = await deps.getMemory()
  await memory.ingest(
    {
      content: classification.distilled,
      role: input.role,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      metadata: captureMetadata(model, input, classification, content, project),
    },
    project ? { projectId: project } : undefined,
  )
  deps.log?.(`stored as ${classification.category} in project=${project ?? '<shared>'}`)
  return { outcome: 'stored', ...decided }
}

export type CaptureDeriveKind = 'session-summary' | 'pre-compact'

/**
 * Session summaries echo facts that persist for weeks, and long-text cosine
 * between two summaries of the same work rarely passes 0.70, so pre-compact
 * digests dedup looser and over a wider window than single turns.
 */
export const PRE_COMPACT_DEDUP: CaptureDedupOptions = { threshold: 0.62, windowDays: 30 }

export interface DerivedCaptureInput {
  /** A transcript excerpt; the stored memory is the model's digest of it. */
  content: string
  derive: CaptureDeriveKind
  sessionId?: string
  project?: string | null
  source: string
  dryRun: boolean
  key?: string
  meta?: Record<string, string>
}

function derivedMetadata(kind: CaptureDeriveKind, meta: Record<string, string> | undefined): Record<string, string> {
  const at = new Date().toISOString()
  // Set after the caller's values so a client cannot relabel the row type.
  return kind === 'session-summary'
    ? { ...(meta ?? {}), type: 'session-summary', summarizedAt: at }
    : { ...(meta ?? {}), type: 'pre-compact-summary', extractedAt: at }
}

/**
 * Digest a transcript excerpt with the configured chat model, then store the
 * digest through runCapture as a raw system turn. The digest is already
 * distilled, so the salience gate does not run; session summaries are never
 * deduplicated, pre-compact digests are (PRE_COMPACT_DEDUP).
 */
export async function runDerivedCapture(
  deps: CaptureDeps,
  input: DerivedCaptureInput,
): Promise<CaptureOutcome> {
  const model = deps.captureModel

  // Checked before the digest so a retried capture never pays for a second model call.
  if (input.key && input.sessionId && (await findReplay(deps, input.sessionId, input.key))) {
    deps.log?.(`replayed: key=${input.key} already stored for session ${input.sessionId}`)
    return { outcome: 'replayed', model }
  }

  if (!deps.intelligence.digestTranscript) {
    throw new Error('intelligence adapter lacks digestTranscript')
  }
  const excerpt = await scrubModelInput(input.content, deps.logPrefix ?? '[engram-capture]')
  const digest = await deps.intelligence.digestTranscript(excerpt, { kind: input.derive })
  const digested = digest.memory.trim()
  if (!digested) {
    deps.log?.(`rejected: the ${input.derive} digest was empty`)
    return { outcome: 'rejected', model, reason: 'empty_digest' }
  }

  // The replay check above already covered this key; the digest was made
  // by the capture model, so it is recorded as the model even though the
  // salience gate does not run.
  const outcome = await captureUnseenKey(deps, {
    content: digested,
    role: 'system',
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.project !== undefined ? { project: input.project } : {}),
    source: input.source,
    gate: false,
    dedup: input.derive === 'pre-compact' ? PRE_COMPACT_DEDUP : false,
    dryRun: input.dryRun,
    ...(input.key ? { key: input.key } : {}),
    meta: derivedMetadata(input.derive, input.meta),
  }, model)
  return input.derive === 'pre-compact' ? { ...outcome, context: digest.context } : outcome
}
