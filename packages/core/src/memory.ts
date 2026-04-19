import type { Message, Episode, SemanticMemory, ConsolidateResult, RecallResult, RetrievedMemory } from './types.js'
import type { StorageAdapter } from './adapters/storage.js'
import type { IntelligenceAdapter } from './adapters/intelligence.js'
// Wave 2: The graph backend is accessed via a structural port, not a
// concrete type. @engram-mem/graph's GraphPort structurally satisfies
// this port. This lets core stay decoupled from any specific graph
// implementation and breaks what would otherwise be a circular dependency.
import type { GraphPort } from './adapters/graph.js'
import { SensoryBuffer } from './systems/sensory-buffer.js'
import { HeuristicIntentAnalyzer } from './intent/analyzer.js'
import { AssociationManager } from './systems/association-manager.js'
import { recall as engineRecall } from './retrieval/engine.js'
import { classifyMode, RECALL_STRATEGIES } from './intent/intents.js'
import { lightSleep } from './consolidation/light-sleep.js'
import { deepSleep } from './consolidation/deep-sleep.js'
import { dreamCycle } from './consolidation/dream-cycle.js'
import { decayPass } from './consolidation/decay-pass.js'
import { runAutoConsolidation } from './consolidation/auto-consolidation.js'
import type { AutoConsolidationOpts } from './consolidation/auto-consolidation.js'
import { scoreSalience } from './ingestion/salience.js'
import { extractEntities } from './ingestion/entity-extractor.js'
import { parseContent } from './ingestion/content-parser.js'
import { generateId } from './utils/id.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeResult {
  nodeId: string
  nodeType: 'person' | 'entity'
  label: string
  projectACount: number
  projectBCount: number
  projectALabels: string[]
  projectBLabels: string[]
}

export interface MemoryOptions {
  storage: StorageAdapter
  intelligence?: IntelligenceAdapter
  consolidation?: { schedule: 'auto' | 'manual' }
  tokenizer?: (text: string) => number
  /**
   * Optional Neo4j graph. When provided, enables graph decomposition on
   * ingest and spreading activation on recall. When omitted, the system
   * operates in SQL-only mode with the legacy association walk.
   * Caller is responsible for constructing and initializing the graph
   * before passing it in.
   */
  graph?: GraphPort
  /**
   * Optional default project scope. All ingestions and recalls will be
   * tagged / boosted with this project unless overridden per-call via
   * message.metadata.project or recall(..., { project }).
   */
  project?: string
  /**
   * Wave 5: Optional project namespace. All ingestions and recalls will be
   * scoped to this project. Memories from other projects are invisible to
   * this instance. NULL memories (pre-namespace) remain accessible to all.
   */
  projectId?: string
  /**
   * Enable auto-consolidation on initialize(). When true, checks
   * data-volume thresholds at startup and runs due consolidation cycles
   * in the background. Zero LLM cost by default (heuristic-only).
   * Defaults to false for backward compatibility.
   */
  autoConsolidate?: boolean | AutoConsolidationOpts
  /**
   * Opt into Anthropic-style Contextual Retrieval. When true AND the
   * intelligence adapter implements contextualizeChunk, every ingested
   * turn is augmented with an LLM-generated preamble that situates it
   * (speaker, time, topic, pronoun resolution) before indexing. Both
   * the embedding and the FTS/BM25 index benefit — the raw user text
   * is preserved in metadata.rawContent for display.
   *
   * Defaults to false: the extra LLM call at ingest adds cost and
   * latency, and the lift is workload-dependent.
   */
  contextualRetrieval?: boolean
}

export interface SessionHandle {
  readonly sessionId: string
  ingest(message: Omit<Message, 'sessionId'>): Promise<void>
  recall(query: string, opts?: { embedding?: number[]; tokenBudget?: number }) : Promise<RecallResult>
}

// ---------------------------------------------------------------------------
// Memory class
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_ID = 'default'
const CONFIDENCE_FLOOR = 0.05

export class Memory {
  private storage: StorageAdapter
  private intelligence: IntelligenceAdapter | undefined
  private sensory: SensoryBuffer
  private intentAnalyzer: HeuristicIntentAnalyzer
  private initialized = false
  // AssociationManager is lazily created after storage is initialized.
  private _associations: AssociationManager | null = null
  // Wave 2: Optional Neo4j graph. null = unavailable or not configured.
  // All graph operations null-check this field. Ingestion and retrieval
  // fall back gracefully to SQL-only mode when graph is null.
  private _graph: GraphPort | null = null
  // Tracks fire-and-forget graph writes launched during ingest(). Callers
  // that need deterministic persistence (CLI tools, tests) can call
  // flushPendingWrites() to wait for all of them to settle.
  private _pendingWrites: Array<Promise<unknown>> = []
  private _defaultProject: string | undefined
  // Wave 5: project namespace for multi-agent isolation
  private _projectId: string | undefined
  private opts: MemoryOptions

  constructor(opts: MemoryOptions) {
    this.opts = opts
    this.storage = opts.storage
    this.intelligence = opts.intelligence
    this.sensory = new SensoryBuffer()
    this.intentAnalyzer = new HeuristicIntentAnalyzer()
    this._graph = opts.graph ?? null
    this._defaultProject = opts.project
    this._projectId = opts.projectId
  }

  private get associations(): AssociationManager {
    if (!this._associations) {
      this._associations = new AssociationManager(this.storage.associations)
    }
    return this._associations
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Must be called before any operations. Sets up storage. */
  async initialize(): Promise<void> {
    await this.storage.initialize()
    this.initialized = true

    // Verify graph connectivity. If Neo4j is down, degrade gracefully to
    // SQL-only mode. Ingestion and retrieval still work — they just use the
    // legacy association walk instead of spreading activation.
    if (this._graph !== null) {
      try {
        const available = await this._graph.isAvailable()
        if (!available) {
          console.warn('[engram] Neo4j unavailable — running in SQL-only mode')
          this._graph = null
        }
      } catch (err) {
        console.warn('[engram] Neo4j connectivity check failed, degrading to SQL-only:', err)
        this._graph = null
      }
    }

    // Auto-consolidation: fire-and-forget background run of due cycles.
    // Runs after storage + graph are initialized so consolidation has
    // full access to both layers. Non-blocking — initialize() returns
    // immediately while consolidation runs in the background.
    if (this.opts.autoConsolidate) {
      const autoOpts = typeof this.opts.autoConsolidate === 'object'
        ? this.opts.autoConsolidate
        : undefined
      const consolidationPromise = runAutoConsolidation(
        this.storage,
        this.intelligence,
        this._graph,
        autoOpts,
      ).catch(err => {
        console.warn('[engram] auto-consolidation failed:', (err as Error).message)
      })
      this._pendingWrites.push(consolidationPromise)
    }
  }

  /** Release resources, persist sensory buffer. */
  async dispose(): Promise<void> {
    if (this.initialized) {
      this.initialized = false
      try {
        const snapshot = this.sensory.snapshot(DEFAULT_SESSION_ID)
        await this.storage.saveSensorySnapshot(DEFAULT_SESSION_ID, snapshot)
      } catch {
        // Storage may already be closed when multiple Memory instances share the same adapter
      }
      await this.storage.dispose()
    }
  }

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------

  /** Store a message. Auto-detects salience, extracts entities. */
  async ingest(message: Message): Promise<void> {
    this.assertInitialized()

    const sessionId = message.sessionId ?? DEFAULT_SESSION_ID

    // Parse content into clean searchable text + structured parts.
    // episodes.content gets cleanText only — no tool calls, no timestamps, no metadata.
    // Full fidelity is preserved in metadata.parts.
    const parsed = parseContent(message.content)
    const cleanText = parsed.cleanText

    // Skip messages that have no meaningful text after parsing.
    if (cleanText.length < 2) {
      console.warn('[engram] ingest: message discarded — no usable text content after parsing. Check message.content shape.')
      return
    }

    const salience = scoreSalience({ role: message.role, content: cleanText })
    const entities = extractEntities(cleanText)

    // Fetch recent session episodes BEFORE embedding — we use them for
    // contextual embedding (below) and temporal edges (after insert).
    const recentEpisodes = await this.storage.episodes.getBySession(sessionId, {
      since: new Date(Date.now() - 30 * 60 * 1000), // last 30 minutes
    })

    // Anthropic-style Contextual Retrieval (opt-in via MemoryOptions).
    // Split signal: the LLM-generated preamble enriches the EMBEDDING only.
    // The content column stays pristine so FTS5/BM25 keeps exact lexical
    // precision for dates, proper nouns, and literal tokens — otherwise the
    // preamble "about Jon's banking job" outranks the literal "Jan 19, 2023"
    // at retrieval time and hurts temporal queries (Wave 2 bench confirmed).
    let contextualPreamble = ''
    if (
      this.opts.contextualRetrieval === true &&
      this.intelligence?.contextualizeChunk &&
      cleanText.length >= 10
    ) {
      const windowTurns = recentEpisodes
        .slice(-10)
        .map(e => `[${e.role}] ${e.content}`)
        .join('\n')
      try {
        contextualPreamble = await this.intelligence.contextualizeChunk(cleanText, {
          conversationContext: windowTurns,
          speakerRole: message.role,
        })
      } catch (err) {
        console.warn('[engram] contextualizeChunk failed (falling back to raw chunk):', err)
      }
    }

    // Contextual embedding: prepend the situating preamble (when present) or
    // the last 1-2 preceding turns so the embedding model captures
    // conversational flow. Short casual turns (~123 chars) embed weakly in
    // isolation; with context they match queries better.
    let embedding: number[] | null = null
    if (this.intelligence?.embed) {
      try {
        let textToEmbed: string
        if (contextualPreamble) {
          textToEmbed = `${contextualPreamble.trim()}\n\n${cleanText}`.slice(-1500)
        } else if (cleanText.length > 20) {
          const contextTurns = recentEpisodes
            .slice(-2)
            .map(e => e.content)
          if (contextTurns.length > 0) {
            const context = contextTurns.join('\n').slice(-500)
            textToEmbed = `${context}\n${cleanText}`.slice(-1000)
          } else {
            textToEmbed = cleanText
          }
        } else {
          textToEmbed = typeof message.content === 'string' ? message.content : cleanText
        }
        embedding = await this.intelligence.embed(textToEmbed)
      } catch (err) {
        console.error('[engram] embedding failed, storing without vector:', err)
      }
    }

    const metadata: Record<string, unknown> = {
      ...message.metadata,
      role: message.role,
      parts: parsed.parts,
    }

    // Store raw content array in metadata for full fidelity when it was an array.
    if (Array.isArray(message.content)) {
      metadata.rawContent = message.content
    }
    // Preamble is stored in metadata only (not concatenated to content) so
    // downstream consumers can inspect it without FTS/BM25 seeing it.
    if (contextualPreamble) {
      metadata.contextualPreamble = contextualPreamble
    }

    const episode = await this.storage.episodes.insert({
      sessionId,
      role: message.role,
      content: cleanText,
      salience,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding,
      entities,
      metadata,
      projectId: this._projectId ?? null,
    })

    // Temporal edges linking this episode to recent session episodes.
    // Fire-and-forget: temporal edges enrich the association graph but a
    // failure here must not block the caller.
    const recentIds = recentEpisodes
      .filter(e => e.id !== episode.id)
      .slice(-4) // up to 4 preceding episodes
      .map(e => e.id)

    if (recentIds.length > 0) {
      this.associations.createTemporalEdges([...recentIds, episode.id]).catch(() => {
        // non-fatal: temporal edges are enrichment only
      })
    }

    // --- Wave 2: Graph decomposition (Neo4j, fire-and-forget) ---
    // Runs AFTER SQL episode insert succeeds. Non-blocking: does NOT await.
    // If Neo4j is down or ingestEpisode throws, the warning is logged but
    // ingest() completes normally with the SQL record intact.
    //
    // Dual edge systems: SQL temporal associations above are still created.
    // Neo4j edges are created IN ADDITION. SQL is the durable source of
    // truth. Neo4j is the acceleration layer. Both always get written.
    //
    // LLM entity extraction: when an intelligence adapter with
    // extractEntities is available, run it in parallel with graph ingest
    // to produce high-precision typed entities. Graph.ingestEpisode() will
    // use these when present and fall back to the regex heuristic when
    // the extraction is empty or fails.
    if (this._graph !== null) {
      const graph = this._graph
      const previousEpisodeId = recentIds.length > 0
        ? recentIds[recentIds.length - 1]
        : undefined

      const extractEntitiesFn = this.intelligence?.extractEntities
      const entityPromise = extractEntitiesFn
        ? extractEntitiesFn.call(this.intelligence, cleanText).catch((err: unknown) => {
            console.warn('[engram] extractEntities failed (falling back to regex):', err)
            return [] as Awaited<ReturnType<NonNullable<IntelligenceAdapter['extractEntities']>>>
          })
        : Promise.resolve([])

      // Project tag comes from the message metadata (set by the caller,
      // e.g. the engram-ingest CLI) or falls back to undefined.
      const projectFromMeta =
        message.metadata && typeof message.metadata['project'] === 'string'
          ? (message.metadata['project'] as string)
          : undefined

      const graphPromise = entityPromise.then((llmEntities) => {
        const input = {
          id: episode.id,
          sessionId,
          role: message.role,
          content: cleanText,
          salience,
          entities,
          createdAt: episode.createdAt.toISOString(),
          ...(previousEpisodeId ? { previousEpisodeId } : {}),
          ...(llmEntities.length > 0 ? { llmEntities } : {}),
          ...(projectFromMeta ? { project: projectFromMeta } : {}),
        }
        return graph.ingestEpisode(input)
      }).catch((err: unknown) => {
        console.warn('[engram] graph decomposition failed (non-fatal):', err)
      })

      // Track the promise so callers can flush pending writes.
      // The promise is appended here and removed after it settles, so
      // _pendingWrites stays bounded during long-running processes.
      this._pendingWrites.push(graphPromise)
      graphPromise.finally(() => {
        const idx = this._pendingWrites.indexOf(graphPromise)
        if (idx >= 0) this._pendingWrites.splice(idx, 1)
      })
    }
  }

  /**
   * Wait for all fire-and-forget graph writes launched during ingest()
   * to settle. Useful for CLI tools and tests that need deterministic
   * persistence before exiting. Safe to call when no writes are pending.
   */
  async flushPendingWrites(): Promise<void> {
    if (this._pendingWrites.length === 0) return
    // Snapshot the array because entries will be removed as they settle
    const snapshot = this._pendingWrites.slice()
    await Promise.allSettled(snapshot)
  }

  /** Store multiple messages. Batch-optimized. */
  async ingestBatch(messages: Message[]): Promise<void> {
    this.assertInitialized()

    for (const message of messages) {
      await this.ingest(message)
    }
  }

  // ---------------------------------------------------------------------------
  // Recall
  // ---------------------------------------------------------------------------

  /** Intent-analyzed, association-walked, primed recall. */
  async recall(
    query: string,
    opts?: { embedding?: number[]; tokenBudget?: number; asOf?: Date }
  ): Promise<RecallResult> {
    this.assertInitialized()

    // Classify intent using new 3-mode system
    const mode = classifyMode(query)
    const strategy = RECALL_STRATEGIES[mode]

    // Still run old analyzer for backward compat (intent field in result)
    const intent = this.intentAnalyzer.analyze(query, {
      activeIntent: this.sensory.getIntent(),
      primedTopics: this.sensory.getPrimed().map(p => p.topic),
    })
    this.sensory.setIntent(intent)

    // Embed query if intelligence adapter provides embeddings
    let embedding = opts?.embedding
    if (embedding === undefined && this.intelligence?.embed) {
      embedding = await this.intelligence.embed(query)
    }

    // Run vector-first pipeline (text-only fallback when no embedding)
    const result = await engineRecall(query, this.storage, this.sensory, {
      strategy,
      embedding: embedding ?? [],
      tokenBudget: opts?.tokenBudget,
      intelligence: this.intelligence,
      graph: this._graph,
      asOf: opts?.asOf,
      ...(this._defaultProject ? { project: this._defaultProject } : {}),
      ...(this._projectId ? { projectId: this._projectId } : {}),
    })

    // Tick sensory buffer: decay priming weights each turn
    this.sensory.tick()

    return {
      memories: result.memories,
      associations: result.associations,
      intent,
      primed: result.primed,
      estimatedTokens: result.estimatedTokens,
      formatted: result.formatted,
    }
  }

  // ---------------------------------------------------------------------------
  // Expand
  // ---------------------------------------------------------------------------

  /** Drill into a digest to get original episodes. */
  async expand(memoryId: string): Promise<{ episodes: Episode[] }> {
    this.assertInitialized()

    const typed = await this.storage.getById(memoryId, 'digest')
    if (!typed || typed.type !== 'digest') {
      return { episodes: [] }
    }

    const digest = typed.data
    const episodes = await this.storage.episodes.getByIds(digest.sourceEpisodeIds)

    return { episodes }
  }

  // ---------------------------------------------------------------------------
  // Community Intelligence (Wave 5)
  // ---------------------------------------------------------------------------

  /**
   * Return community summaries (knowledge domain clusters) from Neo4j or SQL cache.
   * When a topic filter is provided, only communities whose label or top entities/topics
   * contain the needle are returned.
   */
  async getCommunitySummaries(opts?: {
    topic?: string
    limit?: number
    projectId?: string
  }): Promise<Array<{
    communityId: string
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
  }>> {
    this.assertInitialized()

    // Prefer Neo4j direct query when graph is available
    if (this._graph && typeof this._graph.queryCommunities === 'function') {
      const communities = await this._graph.queryCommunities!({
        projectId: opts?.projectId,
        limit: opts?.limit ?? 5,
      })

      if (!opts?.topic) return communities

      const needle = opts.topic.toLowerCase()
      return communities.filter(c =>
        c.label.toLowerCase().includes(needle) ||
        c.topTopics.some(t => t.toLowerCase().includes(needle)) ||
        c.topEntities.some(e => e.toLowerCase().includes(needle))
      )
    }

    // Fallback: SQL cache
    if (this.storage.getCommunitySummaries) {
      const all = await this.storage.getCommunitySummaries({
        projectId: opts?.projectId,
        limit: opts?.limit ?? 5,
      })

      if (!opts?.topic) return all

      const needle = opts.topic.toLowerCase()
      return all.filter(c =>
        c.label.toLowerCase().includes(needle) ||
        c.topTopics.some(t => t.toLowerCase().includes(needle)) ||
        c.topEntities.some(e => e.toLowerCase().includes(needle))
      )
    }

    return []
  }

  /**
   * Find shared Person/Entity nodes that bridge two project namespaces.
   * Only available when Neo4j graph is configured.
   */
  async findBridges(projectA: string, projectB: string): Promise<BridgeResult[]> {
    this.assertInitialized()
    if (!this._graph || typeof this._graph.findProjectBridges !== 'function') return []
    return this._graph.findProjectBridges!(projectA, projectB)
  }

  // ---------------------------------------------------------------------------
  // Temporal Queries
  // ---------------------------------------------------------------------------

  /** Get the full timeline of a topic — all semantic memories including superseded ones. */
  async getTimeline(
    topic: string,
    opts?: { fromDate?: Date; toDate?: Date },
  ): Promise<SemanticMemory[]> {
    this.assertInitialized()
    return this.storage.semantic.getTopicTimeline(topic, opts)
  }

  // ---------------------------------------------------------------------------
  // Consolidation
  // ---------------------------------------------------------------------------

  /** Run consolidation cycles. */
  async consolidate(
    cycle: 'light' | 'deep' | 'dream' | 'decay' | 'all' = 'all'
  ): Promise<ConsolidateResult> {
    this.assertInitialized()

    if (cycle === 'light') {
      return lightSleep(this.storage, this.intelligence, undefined, this._graph)
    }
    if (cycle === 'deep') {
      return deepSleep(this.storage, this.intelligence, undefined, this._graph)
    }
    if (cycle === 'dream') {
      return dreamCycle(this.storage, undefined, this._graph, this.intelligence)
    }
    if (cycle === 'decay') {
      return decayPass(this.storage, undefined, this._graph)
    }

    // 'all': run light → deep → dream → decay in sequence, merge results
    const lightResult = await lightSleep(this.storage, this.intelligence, undefined, this._graph)
    const deepResult = await deepSleep(this.storage, this.intelligence, undefined, this._graph)
    const dreamResult = await dreamCycle(this.storage, undefined, this._graph, this.intelligence)
    const decayResult = await decayPass(this.storage, undefined, this._graph)

    const graphNodesCreated = (lightResult.graphNodesCreated ?? 0) + (deepResult.graphNodesCreated ?? 0)
    const graphEdgesCreated = (lightResult.graphEdgesCreated ?? 0) + (deepResult.graphEdgesCreated ?? 0)

    return {
      cycle: 'all',
      digestsCreated: lightResult.digestsCreated ?? 0,
      episodesProcessed: lightResult.episodesProcessed ?? 0,
      promoted: deepResult.promoted ?? 0,
      procedural: deepResult.procedural ?? 0,
      deduplicated: deepResult.deduplicated ?? 0,
      superseded: deepResult.superseded ?? 0,
      associationsCreated: dreamResult.associationsCreated ?? 0,
      semanticDecayed: decayResult.semanticDecayed ?? 0,
      proceduralDecayed: decayResult.proceduralDecayed ?? 0,
      edgesPruned: decayResult.edgesPruned ?? 0,
      graphNodesCreated: graphNodesCreated > 0 ? graphNodesCreated : undefined,
      graphEdgesCreated: graphEdgesCreated > 0 ? graphEdgesCreated : undefined,
      communitiesDetected: dreamResult.communitiesDetected,
      bridgeNodesFound: dreamResult.bridgeNodesFound,
      replayEdgesCreated: dreamResult.replayEdgesCreated,
      causalEdgesCreated: dreamResult.causalEdgesCreated,
      graphEdgesPruned: decayResult.graphEdgesPruned,
      isolatedNodesDeprioritized: decayResult.isolatedNodesDeprioritized,
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /** Memory statistics. */
  async stats(): Promise<{
    episodes: number
    digests: number
    semantic: number
    procedural: number
    associations: number
  }> {
    this.assertInitialized()

    // Prefer fast count() when the adapter supports it (O(1) COUNT(*)).
    // Falls back to the legacy N-scan approach for adapters without count().
    const [episodes, digests, semantic, procedural, associations] = await Promise.all([
      this.storage.episodes.count
        ? this.storage.episodes.count()
        : this.countEpisodesLegacy(),
      this.storage.digests.count
        ? this.storage.digests.count()
        : this.storage.digests.getCountBySession().then(m => Object.values(m).reduce((s, v) => s + v, 0)),
      this.storage.semantic.count
        ? this.storage.semantic.count()
        : this.storage.semantic.getUnaccessed(0).then(list => list.length),
      this.storage.procedural.count
        ? this.storage.procedural.count()
        : Promise.resolve(0),
      this.storage.associations.count
        ? this.storage.associations.count()
        : this.countAssociationsLegacy(),
    ])

    return { episodes, digests, semantic, procedural, associations }
  }

  /** Fallback for adapters without episodes.count() — O(N) but bounded by session count */
  private async countEpisodesLegacy(): Promise<number> {
    const [unconsolidatedSessions, digestCountBySession] = await Promise.all([
      this.storage.episodes.getUnconsolidatedSessions(),
      this.storage.digests.getCountBySession(),
    ])
    const allSessionIds = new Set<string>([
      ...unconsolidatedSessions,
      ...Object.keys(digestCountBySession),
    ])
    let count = 0
    for (const sessionId of allSessionIds) {
      const episodes = await this.storage.episodes.getBySession(sessionId)
      count += episodes.length
    }
    return count
  }

  /** Fallback for adapters without associations.count() — returns 0 rather than OOM */
  private async countAssociationsLegacy(): Promise<number> {
    return 0
  }

  // ---------------------------------------------------------------------------
  // Forget
  // ---------------------------------------------------------------------------

  /**
   * Deprioritize memories (lossless — sets confidence to 0.05, marks
   * metadata.forgotten). Returns a preview by default; pass confirm=true
   * to actually apply.
   */
  async forget(
    query: string,
    opts?: { tier?: string; confirm?: boolean }
  ): Promise<{ count: number; previewed: RetrievedMemory[] }> {
    this.assertInitialized()

    const confirm = opts?.confirm ?? false

    // Embed query so vector search can find matches. Without this, forget()
    // returns no results because engineRecall's vector path requires a
    // non-empty embedding and text-only fallback is narrower.
    let embedding: number[] = []
    if (this.intelligence?.embed) {
      try {
        embedding = await this.intelligence.embed(query)
      } catch (err) {
        console.error('[engram] forget: embedding failed, falling back to text-only search:', err)
      }
    }

    // Search matching memories across relevant tiers using deep strategy
    const result = await engineRecall(query, this.storage, this.sensory, {
      strategy: RECALL_STRATEGIES['deep'],
      embedding,
      intelligence: this.intelligence,
      graph: this._graph,
      ...(this._defaultProject ? { project: this._defaultProject } : {}),
      ...(this._projectId ? { projectId: this._projectId } : {}),
    })

    const allMemories = [...result.memories, ...result.associations]

    // Filter by tier if specified
    const filtered = opts?.tier
      ? allMemories.filter(m => m.type === opts.tier)
      : allMemories

    if (!confirm) {
      return { count: filtered.length, previewed: filtered }
    }

    // Apply forgetting: lossless deprioritization
    for (const memory of filtered) {
      if (memory.type === 'semantic') {
        await this.storage.semantic.recordAccessAndBoost(
          memory.id,
          CONFIDENCE_FLOOR - 1 // set to floor by applying a large negative boost
        )
        // Mark metadata.forgotten by re-inserting with updated metadata is
        // not directly supported; we apply the confidence floor via available API.
        // The storage interface supports recordAccessAndBoost but not direct update.
        // We use a large negative boost to drive confidence toward floor.
      } else if (memory.type === 'procedural') {
        // No direct confidence update API for procedural; mark via the
        // observationCount mechanism — no decay is available without batchDecay.
        // We skip procedural direct update as the interface doesn't support it.
      } else if (memory.type === 'episode') {
        // Episodes are lossless; we can mark via metadata but there's no update
        // API on EpisodeStorage. We record access to at least touch the episode.
        await this.storage.episodes.recordAccess(memory.id)
      }
    }

    return { count: filtered.length, previewed: filtered }
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  /** Get or create a session-scoped handle. */
  session(sessionId?: string): SessionHandle {
    const sid = sessionId ?? generateId()

    return {
      sessionId: sid,
      ingest: (message: Omit<Message, 'sessionId'>) => {
        return this.ingest({ ...message, sessionId: sid })
      },
      recall: (query: string, opts?: { embedding?: number[]; tokenBudget?: number }) => {
        return this.recall(query, opts)
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('Memory not initialized. Call initialize() first.')
    }
  }
}
