/**
 * `withRecallEngine` — the ONLY integration point external packages touch.
 *
 * Wraps a `StorageAdapter` with a `RecallEngine` without ever mutating the
 * inner adapter, and without building a `{...storage}` object-literal
 * spread: it builds a forwarding `Proxy` instead. That distinction is load-
 * bearing, not stylistic — every production `StorageAdapter`
 * (`SqliteStorageAdapter`, `PostgRestStorageAdapter`) is an ES class whose
 * interface members are PROTOTYPE methods and GETTERS: `get episodes()`
 * returns a `SqliteEpisodeStorage`/`PostgRestEpisodeStorage` instance whose
 * own `insert`/`search`/`getByIds`/... are themselves prototype methods
 * (verified in `packages/sqlite/src/adapter.ts` + `episodes.ts` and
 * `packages/postgrest/src/adapter.ts` — identical shape in both). A
 * `{...storage}` spread only copies OWN enumerable properties, so it would
 * silently drop every one of those methods and getters the moment this
 * decorator wrapped a real backend — `vectorSearch`, `textBoost`, `getById`,
 * the entire `episodes`/`digests`/`semantic`/`procedural` tiers, all
 * `undefined` — while looking completely correct against a plain-object
 * test double. A `Proxy` forwards everything not explicitly overridden
 * correctly, for both a class-based adapter and a plain-object one.
 *
 * Overrides:
 *   - `vectorSearch` → `engine.vectorSearch` (the engine itself owns the
 *     cold/warming/disabled passthrough decision internally).
 *   - `initialize`   → inner `initialize()`, THEN fire-and-forget
 *     `engine.warm()` — mirrors the `onnx.load()` precedent in
 *     `maybeWithLocalRerank` (`packages/mcp/src/server-core.ts`): never
 *     block startup on the cold-start rebuild.
 *   - `dispose`      → `engine.dispose()` (final best-effort snapshot
 *     write) THEN inner `dispose()`, so the flush always happens before the
 *     backing connection is torn down.
 *   - `episodes` / `digests` / `semantic` / `procedural` — only the
 *     mutators that actually exist on each tier's port are wrapped (checked
 *     against `packages/core/src/adapters/storage.ts`: `DigestStorage` has
 *     no `markForgotten`/`markSuperseded`; `EpisodeStorage`/
 *     `ProceduralStorage` have no `markSuperseded`). Each wrapped mutator
 *     calls `engine.noteInsert`/`noteForget`/`noteSupersede` only AFTER the
 *     inner call resolves, using the RETURNED hydrated row's own
 *     id/createdAt/embedding — never the caller's pre-insert payload, since
 *     only the backing store assigns id/createdAt. `SemanticMemory` and
 *     `ProceduralMemory` carry no `sessionId` field, so their `noteInsert`
 *     calls pass `null` for it; `Episode`/`Digest` pass their own
 *     `sessionId`.
 *
 * Every other member (`textBoost`, `associations`, `getById`, `getByIds`,
 * `saveSensorySnapshot`, the optional `scanEmbeddings`/
 * `listTombstonesSince`/community-cache members, ...) passes through to the
 * real instance untouched. `noteInsert`/`noteForget`/`noteSupersede` never
 * throw (each wraps its body in try/catch — see `engine.ts`), so a
 * write-through failure can only ever degrade the RAM index, never the
 * caller-visible insert/forget/supersede result.
 */
import type {
  Digest,
  DigestStorage,
  Episode,
  EpisodeStorage,
  ProceduralMemory,
  ProceduralStorage,
  SemanticMemory,
  SemanticStorage,
  StorageAdapter,
} from '@engram-mem/core'
import { RecallEngine, type RecallEngineOpts, type VectorSearchOpts } from './engine.js'

/**
 * Builds a `Proxy` over `target` that returns `overrides[prop]` when it is
 * an OWN property of `overrides` (including getters), else forwards to
 * `target`'s own value. Forwarded FUNCTIONS are bound to `target` so `this`
 * inside them always resolves to the real instance — never the proxy — no
 * matter how the caller invokes the result or what private-state mechanism
 * the class uses internally (a `WeakMap` keyed by the literal instance, for
 * example, would silently break if a method ever ran with `this` set to a
 * proxy instead of the object that was used as the map key at construction
 * time). Forwarded non-function VALUES (sub-store instances like
 * `associations`) are returned as-is, so reference identity is preserved
 * for everything this decorator doesn't touch.
 */
function forwardingProxy<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(t, prop, _receiver) {
      if (Object.hasOwn(overrides, prop)) return Reflect.get(overrides, prop)
      const value = Reflect.get(t, prop, t)
      return typeof value === 'function' ? value.bind(t) : value
    },
  }) as T
}

function wrapEpisodes(inner: EpisodeStorage, engine: RecallEngine): EpisodeStorage {
  return forwardingProxy(inner, {
    async insert(episode: Omit<Episode, 'id' | 'createdAt'>): Promise<Episode> {
      const row = await inner.insert(episode)
      engine.noteInsert(row.id, 'episode', row.createdAt.getTime(), row.projectId, row.sessionId, row.embedding)
      return row
    },
    async markForgotten(ids: string[]): Promise<number> {
      const count = await inner.markForgotten(ids)
      engine.noteForget(ids)
      return count
    },
  })
}

function wrapDigests(inner: DigestStorage, engine: RecallEngine): DigestStorage {
  return forwardingProxy(inner, {
    async insert(digest: Omit<Digest, 'id' | 'createdAt'>): Promise<Digest> {
      const row = await inner.insert(digest)
      engine.noteInsert(row.id, 'digest', row.createdAt.getTime(), row.projectId, row.sessionId, row.embedding)
      return row
    },
    // DigestStorage has no markForgotten/markSuperseded on the port
    // (packages/core/src/adapters/storage.ts) — nothing else to wrap.
  })
}

function wrapSemantic(inner: SemanticStorage, engine: RecallEngine): SemanticStorage {
  return forwardingProxy(inner, {
    async insert(
      memory: Omit<SemanticMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>,
    ): Promise<SemanticMemory> {
      const row = await inner.insert(memory)
      // SemanticMemory carries no sessionId field — semantic memories are session-agnostic.
      engine.noteInsert(row.id, 'semantic', row.createdAt.getTime(), row.projectId, null, row.embedding)
      return row
    },
    async markForgotten(ids: string[]): Promise<number> {
      const count = await inner.markForgotten(ids)
      engine.noteForget(ids)
      return count
    },
    async markSuperseded(id: string, supersededBy: string): Promise<void> {
      await inner.markSuperseded(id, supersededBy)
      engine.noteSupersede(id)
    },
  })
}

function wrapProcedural(inner: ProceduralStorage, engine: RecallEngine): ProceduralStorage {
  return forwardingProxy(inner, {
    async insert(
      memory: Omit<ProceduralMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>,
    ): Promise<ProceduralMemory> {
      const row = await inner.insert(memory)
      // ProceduralMemory carries no sessionId field — procedural memories are session-agnostic.
      engine.noteInsert(row.id, 'procedural', row.createdAt.getTime(), row.projectId, null, row.embedding)
      return row
    },
    async markForgotten(ids: string[]): Promise<number> {
      const count = await inner.markForgotten(ids)
      engine.noteForget(ids)
      return count
    },
    // ProceduralStorage has no markSuperseded on the port — nothing else to wrap.
  })
}

/** Decorated adapter → the RecallEngine driving it. Populated by `withRecallEngine`. */
const engineByAdapter = new WeakMap<StorageAdapter, RecallEngine>()

export function withRecallEngine(storage: StorageAdapter, opts?: RecallEngineOpts): StorageAdapter {
  const engine = new RecallEngine(storage, opts)

  const decorated = forwardingProxy(storage, {
    async initialize(): Promise<void> {
      await storage.initialize()
      // Fire-and-forget: the cold-start rebuild (seconds-to-minutes at
      // scale, per design) must never block server/bench startup. Every
      // vectorSearch before warm resolves passes straight through the
      // engine's own cold/warming state check.
      void engine.warm()
    },
    async dispose(): Promise<void> {
      // Snapshot flush before the connection it reads FROM (getByIds/
      // scanEmbeddings during any in-flight reconcile) is torn down.
      await engine.dispose()
      await storage.dispose()
    },
    vectorSearch: (embedding: number[], searchOpts?: VectorSearchOpts) => engine.vectorSearch(embedding, searchOpts),
    get episodes(): EpisodeStorage {
      return wrapEpisodes(storage.episodes, engine)
    },
    get digests(): DigestStorage {
      return wrapDigests(storage.digests, engine)
    },
    get semantic(): SemanticStorage {
      return wrapSemantic(storage.semantic, engine)
    },
    get procedural(): ProceduralStorage {
      return wrapProcedural(storage.procedural, engine)
    },
  })

  engineByAdapter.set(decorated, engine)
  return decorated
}

/**
 * Test-only escape hatch: returns the `RecallEngine` driving a
 * `withRecallEngine`-decorated adapter, or `undefined` if `adapter` wasn't
 * produced by it. NOT part of the public package surface (not re-exported
 * from `index.ts`) — exists purely so tests can `await engine.warm()` /
 * inspect `engine.stats()` directly instead of polling the fire-and-forget
 * warm that `initialize()` triggers.
 */
export function getRecallEngineForTesting(adapter: StorageAdapter): RecallEngine | undefined {
  return engineByAdapter.get(adapter)
}
