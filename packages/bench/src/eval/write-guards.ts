/**
 * Guards that keep a recall evaluation read-only against a live store.
 *
 * A recall with `reconsolidate: false` should write nothing, but the engine
 * swallows errors from its fire-and-forget writes, so a write that slipped
 * through would go unnoticed. Every write path is therefore replaced by a
 * call that throws and is counted; the run reads the counters after each
 * recall and fails on any non-zero count, whether or not the engine caught
 * the error.
 */

/** PostgREST functions recall may call. All are STABLE reads. */
export const READ_RPCS: ReadonlySet<string> = new Set([
  'engram_bm25_match',
  'engram_text_match',
  'engram_vector_search',
  'engram_association_walk',
  'engram_recall',
  'engram_hybrid_recall',
  'match_episodes',
  'engram_access_count_quantile',
])

const BUILDER_WRITES = ['insert', 'upsert', 'update', 'delete'] as const
const SESSION_WRITES = ['executeWrite', 'writeTransaction'] as const
const SESSION_READS = ['run', 'executeRead', 'readTransaction'] as const

/** Blocked calls, by name. */
export interface GuardStats {
  /** Blocked PostgREST functions. */
  rpc: Record<string, number>
  /** Blocked table writes, keyed `method:table`. */
  builder: Record<string, number>
  /** Blocked Neo4j write transactions, keyed by session method. */
  graph: Record<string, number>
  /**
   * Errors raised by Neo4j session calls that were let through, keyed by the
   * call. Includes write Cypher the server rejected inside a READ session.
   */
  graphErrors: Record<string, number>
  /** The first graph error, prefixed with its call; null while there is none. */
  graphErrorSample: string | null
}

export function createGuardStats(): GuardStats {
  return { rpc: {}, builder: {}, graph: {}, graphErrors: {}, graphErrorSample: null }
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0)
}

export function blockedCallCount(stats: GuardStats): number {
  return total(stats.rpc) + total(stats.builder) + total(stats.graph)
}

export class BlockedWriteError extends Error {
  constructor(stats: GuardStats) {
    super(`recall attempted ${blockedCallCount(stats)} blocked write(s): ${JSON.stringify(stats)}`)
    this.name = 'BlockedWriteError'
  }
}

/** Fails once any guard has blocked a call. */
export function assertNoBlockedCalls(stats: GuardStats): void {
  if (blockedCallCount(stats) > 0) throw new BlockedWriteError(stats)
}

export function graphErrorCount(stats: GuardStats): number {
  return total(stats.graphErrors)
}

/**
 * A Neo4j call failed during a recall. The engine catches graph failures and
 * falls back to the SQL association walk without recording it, so the recall
 * would look complete while its graph stage never ran.
 */
export class GraphCallError extends Error {
  constructor(readonly calls: Readonly<Record<string, number>>, sample: string | null) {
    super(`recall hit ${total({ ...calls })} Neo4j error(s) in ${Object.keys(calls).sort().join(', ')}: ${sample ?? 'no message'}`)
    this.name = 'GraphCallError'
  }
}

/** Fails once any Neo4j session call has raised an error. */
export function assertNoGraphErrors(stats: GuardStats): void {
  if (graphErrorCount(stats) > 0) throw new GraphCallError({ ...stats.graphErrors }, stats.graphErrorSample)
}

export interface GuardablePostgrestClient {
  rpc(fn: string, ...rest: unknown[]): unknown
  from(relation: string): unknown
}

function isGuardableClient(v: unknown): v is GuardablePostgrestClient {
  if (v === null || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return typeof c['rpc'] === 'function' && typeof c['from'] === 'function'
}

/**
 * The PostgREST adapter keeps its client private, and every sub-store shares
 * that one object, so guarding it in place covers all of them. Fails loudly if
 * the field changes rather than running unguarded.
 */
export function storageClient(storage: object): GuardablePostgrestClient {
  const client = (storage as { client?: unknown }).client
  if (!isGuardableClient(client)) throw new Error('the PostgREST adapter exposes no client with rpc/from; cannot guard writes')
  return client
}

/**
 * Lets through only the read functions in `READ_RPCS`, and makes every
 * insert/upsert/update/delete on a table builder throw.
 */
export function guardPostgrestClient(client: GuardablePostgrestClient, stats: GuardStats): void {
  const rpc = client.rpc.bind(client)
  const from = client.from.bind(client)
  client.rpc = (fn: string, ...rest: unknown[]) => {
    if (!READ_RPCS.has(fn)) {
      bump(stats.rpc, fn)
      throw new Error(`rpc ${fn} blocked: not a read function`)
    }
    return rpc(fn, ...rest)
  }
  client.from = (relation: string) => {
    const builder = from(relation) as Record<string, unknown>
    for (const method of BUILDER_WRITES) {
      builder[method] = () => {
        bump(stats.builder, `${method}:${relation}`)
        throw new Error(`${method} on ${relation} blocked`)
      }
    }
    return builder
  }
}

export interface GuardableDriver {
  session(config?: Record<string, unknown>): unknown
}

function isGuardableDriver(v: unknown): v is GuardableDriver {
  return v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>)['session'] === 'function'
}

/** NeuralGraph keeps its driver private and hands the same object to spreading activation. */
export function graphDriver(graph: object): GuardableDriver {
  const driver = (graph as { driver?: unknown }).driver
  if (!isGuardableDriver(driver)) throw new Error('the graph exposes no driver with session(); cannot guard writes')
  return driver
}

type Recorder = (call: string, err: unknown) => void

/**
 * Makes a neo4j Result (a thenable whose query fails when it is awaited)
 * report its rejection once, however many times it is awaited. The query is
 * already sent by run(), so settling lazily changes nothing about it.
 */
function countRejection<T>(result: T, call: string, record: Recorder): T {
  if (result === null || typeof result !== 'object') return result
  const r = result as Record<string, unknown>
  if (typeof r['then'] !== 'function') return result
  const then = (r['then'] as (ok: (v: unknown) => void, fail: (e: unknown) => void) => unknown).bind(result)
  let settled: Promise<unknown> | null = null
  const settle = (): Promise<unknown> =>
    (settled ??= new Promise((resolve, reject) => {
      then(resolve, (err) => {
        record(call, err)
        reject(err)
      })
    }))
  r['then'] = (onOk?: (v: unknown) => unknown, onFail?: (e: unknown) => unknown) => settle().then(onOk, onFail)
  r['catch'] = (onFail?: (e: unknown) => unknown) => settle().catch(onFail)
  r['finally'] = (onDone?: () => void) => settle().finally(onDone)
  return result
}

/** Wraps a method so a synchronous throw or a rejected return value is recorded under `call`. */
function countMethod(target: Record<string, unknown>, method: string, call: string, record: Recorder): void {
  const original = target[method]
  if (typeof original !== 'function') return
  target[method] = (...args: unknown[]) => {
    let out: unknown
    try {
      out = (original as (...a: unknown[]) => unknown).apply(target, args)
    } catch (err) {
      record(call, err)
      throw err
    }
    return countRejection(out, call, record)
  }
}

/** An explicit transaction's run, commit and rollback, recorded as `beginTransaction.<method>`. */
function countTransaction(tx: unknown, record: Recorder): unknown {
  if (tx === null || typeof tx !== 'object') return tx
  const t = tx as Record<string, unknown>
  for (const method of ['run', 'commit', 'rollback']) countMethod(t, method, `beginTransaction.${method}`, record)
  return tx
}

/**
 * Opens every session in READ access mode, so the server rejects a write
 * statement run inside it, and makes the write-transaction methods reject.
 * Every other session call (run, executeRead, readTransaction, and an
 * explicit transaction's run/commit/rollback) is counted in `graphErrors`
 * when it fails, whatever the engine does with the error afterwards; a
 * write rejected by the READ session is counted the same way. Errors a
 * transaction function catches itself never leave executeRead and are not
 * seen.
 */
export function guardNeo4jDriver(driver: GuardableDriver, stats: GuardStats): void {
  const session = driver.session.bind(driver)
  const record: Recorder = (call, err) => {
    bump(stats.graphErrors, call)
    stats.graphErrorSample ??= `${call}: ${err instanceof Error ? err.message : String(err)}`
  }
  driver.session = (config: Record<string, unknown> = {}) => {
    const s = session({ ...config, defaultAccessMode: 'READ' }) as Record<string, unknown>
    for (const method of SESSION_WRITES) {
      s[method] = () => {
        bump(stats.graph, method)
        return Promise.reject(new Error(`graph ${method} blocked`))
      }
    }
    for (const method of SESSION_READS) countMethod(s, method, method, record)
    const begin = s['beginTransaction']
    if (typeof begin === 'function') {
      s['beginTransaction'] = (...args: unknown[]) => {
        try {
          return countTransaction((begin as (...a: unknown[]) => unknown).apply(s, args), record)
        } catch (err) {
          record('beginTransaction', err)
          throw err
        }
      }
    }
    return s
  }
}

/**
 * The service env with every recall-time write switched off: no recall log
 * file, no graph reinforcement and no co-recall edges. With the RAM recall
 * engine on, its on-disk snapshot cache is disabled too, so the evaluation
 * cannot overwrite the service's cache. Stage timing is forced on: it only
 * accumulates numbers in memory, and it is where the engine flags a failed
 * retrieval leg (`lexicalError`), which a run must see to refuse that recall.
 * Returns a new record.
 */
export function guardRecallEnv(vars: Readonly<Record<string, string>>): Record<string, string> {
  const { ENGRAM_RECALL_LOG: _recallLog, ...rest } = vars
  return {
    ...rest,
    ENGRAM_RECALL_GRAPH_REINFORCE: 'off',
    ENGRAM_RECALL_CORECALL: 'off',
    ENGRAM_RECALL_TIMING: '1',
    ...(rest['ENGRAM_RECALL_ENGINE'] === 'true' ? { ENGRAM_ENGINE_SNAPSHOT_DIR: '' } : {}),
  }
}
