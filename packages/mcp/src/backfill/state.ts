/**
 * The backfill's own state directory, one per target server:
 * `~/.engram/backfill/<first 12 hex of sha256(endpoint)>/` holding
 * `cursors/`, `spool/` and `state.json`.
 *
 * It is never live capture's `~/.engram/spool` or `~/.engram/cursors`: a
 * rehearsal against another server must not move the cursors live capture
 * reads from, and the live drainer must not post backfill events under its
 * own client name.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDir } from '../ingest/private-files.js'
import { acquireFileLease, writePrivateFileAtomic } from '../capture/transcript-cursor.js'

type Env = Record<string, string | undefined>

const STATE_DIR_HASH_CHARS = 12
/** A run lock older than this was left by a run that crashed. */
const RUN_LOCK_STALE_MS = 6 * 60 * 60_000

export interface BackfillPaths {
  root: string
  cursors: string
  spool: string
  stateFile: string
  runLock: string
}

/** What `state.json` records: the endpoint the directory belongs to and each command's last run. */
export interface BackfillState {
  v: 1
  endpoint: string
  runs: Record<string, { finished_at: string; summary: unknown }>
}

export function defaultStateDir(endpoint: string, env: Env): string {
  const hash = createHash('sha256').update(endpoint).digest('hex').slice(0, STATE_DIR_HASH_CHARS)
  return join(env.HOME || homedir(), '.engram', 'backfill', hash)
}

export function backfillPaths(root: string): BackfillPaths {
  return {
    root,
    cursors: join(root, 'cursors'),
    spool: join(root, 'spool'),
    stateFile: join(root, 'state.json'),
    runLock: join(root, '.run.lock'),
  }
}

function isState(value: unknown): value is BackfillState {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<BackfillState>
  return v.v === 1 && typeof v.endpoint === 'string' && v.runs !== null && typeof v.runs === 'object'
}

/** The saved state, or null when there is none. A file that is not a state throws: it is not ours to overwrite. */
export async function loadBackfillState(paths: BackfillPaths): Promise<BackfillState | null> {
  let text: string
  try {
    text = await fs.readFile(paths.stateFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
    throw err
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    doc = null
  }
  if (!isState(doc)) throw new Error(`${paths.stateFile} is not a backfill state file`)
  return doc
}

/**
 * Creates the directory owner-only and checks it belongs to `endpoint`, so
 * cursors advanced against one server never skip events another server
 * has not received.
 */
export async function openStateDir(paths: BackfillPaths, endpoint: string): Promise<BackfillState> {
  ensurePrivateDir(paths.root)
  ensurePrivateDir(paths.cursors)
  ensurePrivateDir(paths.spool)
  const state = await loadBackfillState(paths)
  if (state !== null && state.endpoint !== endpoint) {
    throw new Error(`state dir ${paths.root} belongs to another target (${state.endpoint})`)
  }
  return state ?? { v: 1, endpoint, runs: {} }
}

export async function saveBackfillState(paths: BackfillPaths, state: BackfillState): Promise<void> {
  await writePrivateFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

/** The state with `command`'s last run replaced; the input is not changed. */
export function withRun(state: BackfillState, command: string, summary: unknown, at: Date): BackfillState {
  return { ...state, runs: { ...state.runs, [command]: { finished_at: at.toISOString(), summary } } }
}

/**
 * Runs `fn` holding the state directory's run lock as a lease, renewed while
 * `fn` runs, so a run longer than the stale window is never taken over; a
 * second run against the same directory fails at once.
 */
export async function withRunLock<T>(paths: BackfillPaths, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireFileLease(paths.runLock, { staleMs: RUN_LOCK_STALE_MS, waitMs: 0 })
  if (lease === undefined) throw new Error(`another backfill run holds ${paths.runLock}`)
  try {
    return await fn()
  } finally {
    await lease.release()
  }
}
