/**
 * In-process capture for installs without an Engram server: builds the
 * classifier, the PostgREST store and the optional graph from this machine's
 * env and runs the capture pipeline here.
 *
 * engram-ingest loads this module with a dynamic import only when
 * ENGRAM_SERVER_URL is unset, so a hook posting to the server never loads a
 * model or store client.
 */

import { createMemory } from '@engram-mem/core'
import type { IntelligenceAdapter, Memory } from '@engram-mem/core'
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
import { openaiIntelligence, DEFAULT_CHAT_MODEL } from '@engram-mem/openai'
import { tryCreateGraph } from '../graph-helper.js'
import { runCapture, type CaptureInput, type CaptureOutcome, type RejectedCapture } from './capture.js'

export type LocalEnv = Readonly<Record<string, string | undefined>>

export interface LocalCaptureOptions {
  env: LocalEnv
  classifierModel: string | null
  threshold: number
  logPrefix: string
  log?: (line: string) => void
  onRejected?: (rejected: RejectedCapture) => void
}

export interface LocalCaptureResult {
  outcome: CaptureOutcome
  /** The model that classified the capture, or `raw`. */
  model: string
}

/** A required credential is missing; the message names it. */
export class MissingEnvError extends Error {
  constructor(name: string) {
    super(`missing required env: ${name}`)
    this.name = 'MissingEnvError'
  }
}

function requireEnv(env: LocalEnv, name: string): string {
  const val = env[name]
  if (!val) throw new MissingEnvError(name)
  return val
}

export async function runLocalCapture(input: CaptureInput, options: LocalCaptureOptions): Promise<LocalCaptureResult> {
  const { env } = options
  // A raw dry run stops before the dedup embedding and the store, so it makes
  // no model call and needs no key; every other path calls the model.
  const needsModel = input.gate || !input.dryRun
  const openaiKey = needsModel ? requireEnv(env, 'OPENAI_API_KEY') : ''
  const classifier: IntelligenceAdapter = needsModel
    ? openaiIntelligence({
        apiKey: openaiKey,
        ...(options.classifierModel ? { summarizationModel: options.classifierModel } : {}),
      })
    : {}
  if (input.gate && !classifier.extractSalience) {
    throw new Error('intelligence adapter lacks extractSalience')
  }

  // Supabase and Neo4j are only reached on the paths that need them: the
  // rejected and dry-run paths connect to neither, the duplicate path skips
  // the graph.
  const opened: { storage?: PostgRestStorageAdapter; memory?: Memory } = {}

  const getStorage = async (): Promise<PostgRestStorageAdapter> => {
    if (!opened.storage) {
      const storage = new PostgRestStorageAdapter({
        url: requireEnv(env, 'SUPABASE_URL'),
        key: requireEnv(env, 'SUPABASE_KEY'),
      })
      await storage.initialize()
      opened.storage = storage
    }
    return opened.storage
  }

  const getMemory = async (): Promise<Memory> => {
    // A separate storage instance: Memory.dispose() disposes its storage,
    // which must not pull the dedup instance out from under the pipeline.
    const ingestStorage = new PostgRestStorageAdapter({
      url: requireEnv(env, 'SUPABASE_URL'),
      key: requireEnv(env, 'SUPABASE_KEY'),
    })
    const graph = await tryCreateGraph(options.logPrefix)
    const created = createMemory({
      storage: ingestStorage,
      intelligence: openaiIntelligence({ apiKey: openaiKey }),
      // ENGRAM_INGEST_CONTEXTUAL=true → Memory.ingest generates a contextual
      // preamble via intelligence.contextualizeChunk and uses it to enrich
      // the embedding. Content stays pristine for FTS.
      contextualRetrieval: env['ENGRAM_INGEST_CONTEXTUAL'] === 'true',
      ...(graph ? { graph } : {}),
    })
    await created.initialize()
    opened.memory = created
    return created
  }

  try {
    const outcome = await runCapture(
      {
        getMemory,
        storage: getStorage,
        intelligence: classifier,
        threshold: options.threshold,
        captureModel: options.classifierModel ?? DEFAULT_CHAT_MODEL,
        logPrefix: options.logPrefix,
        ...(options.log ? { log: options.log } : {}),
        ...(options.onRejected ? { onRejected: options.onRejected } : {}),
      },
      input,
    )
    if (opened.memory) {
      // Wait for fire-and-forget graph decomposition to finish before the
      // process exits. Without this, the CLI can return immediately after
      // the SQL insert and process.exit() kills the inflight Neo4j write.
      await opened.memory.flushPendingWrites()
    }
    return { outcome, model: outcome.model }
  } finally {
    if (opened.memory) await opened.memory.dispose()
    if (opened.storage) await opened.storage.dispose().catch(() => {})
  }
}
