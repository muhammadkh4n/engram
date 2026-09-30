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
  const since = new Date(Date.now() - CAPTURE_KEY_WINDOW_DAYS * DAY_MS)
  const episodes = await storage.episodes.getBySession(sessionId, { since })
  return episodes.some((e) => e.metadata?.['captureKey'] === key)
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
  deps: CaptureDeps,
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
    captureModel: deps.captureModel,
    ...(input.key ? { captureKey: input.key } : {}),
  }
}

export async function runCapture(deps: CaptureDeps, input: CaptureInput): Promise<CaptureOutcome> {
  const model = deps.captureModel

  // A retried capture must not pay for a second classification.
  if (input.key && input.sessionId && (await findReplay(deps, input.sessionId, input.key))) {
    deps.log?.(`replayed: key=${input.key} already stored for session ${input.sessionId}`)
    return { outcome: 'replayed', model }
  }

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
      metadata: captureMetadata(deps, input, classification, content, project),
    },
    project ? { projectId: project } : undefined,
  )
  deps.log?.(`stored as ${classification.category} in project=${project ?? '<shared>'}`)
  return { outcome: 'stored', ...decided }
}
