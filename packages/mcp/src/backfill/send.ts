/**
 * The one way backfill events leave this machine: scrubbed and fitted to the
 * route as live capture does it, written to the backfill's own spool, and
 * drained in the foreground under the client name `engram-backfill`, which
 * the server reads as backfill. A batch counts as delivered only once a 200
 * response covered every event in it; a source moves its cursor after that.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { scrubEvent } from '../capture-events/scrub.js'
import type { CaptureClient, CaptureEvent } from '../capture/events.js'
import { readyForRoute } from '../capture/route-fit.js'
import { drainSpool, type DrainStop } from '../capture/spool-drain.js'
import { writeDeadLetters, writeSpoolBatch } from '../capture/spool.js'

type Env = Record<string, string | undefined>

export const BACKFILL_CLIENT_NAME = 'engram-backfill'

/** The spool's dead-letter directory: one `<session file name>.jsonl` per session, one JSON letter per line. */
const DEAD_DIR = '.dead'

export interface SendTarget {
  env: Env
  /** The backfill's spool root, never live capture's. */
  spool: string
  endpoint: string
  tokenFile: string
  client: CaptureClient
}

/** Counts for one source run; `rejected` is keyed by reason, which names a field and a rule, never a value. */
export interface SendTally {
  events: Record<string, number>
  accepted: number
  duplicates: number
  rejected: Record<string, number>
}

export function emptyTally(): SendTally {
  return { events: {}, accepted: 0, duplicates: 0, rejected: {} }
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by
}

export interface PreparedEvents {
  ready: CaptureEvent[]
  refused: Array<{ reason: string; event: CaptureEvent }>
}

/** Scrubs every event and fits it to the route; an event the route would refuse is set aside with the reason. */
export async function prepareEvents(
  events: readonly CaptureEvent[],
  opts: { now: Date; log: (line: string) => void },
): Promise<PreparedEvents> {
  const ready: CaptureEvent[] = []
  const refused: Array<{ reason: string; event: CaptureEvent }> = []
  for (const event of events) {
    const { event: scrubbed } = await scrubEvent(event)
    const check = readyForRoute(scrubbed, opts)
    if (check.ok) ready.push(check.event)
    else refused.push({ reason: check.reason, event: scrubbed })
  }
  return { ready, refused }
}

/** Adds what a dry run would send to the tally: events by type and the local refusals by reason. */
export function countPrepared(tally: SendTally, prepared: PreparedEvents): void {
  for (const event of prepared.ready) bump(tally.events, event.type)
  for (const { reason } of prepared.refused) bump(tally.rejected, reason)
}

async function deadLetterSizes(spool: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  let names: string[]
  try {
    names = await fs.readdir(join(spool, DEAD_DIR))
  } catch {
    return sizes
  }
  for (const name of names) {
    try {
      sizes.set(name, (await fs.stat(join(spool, DEAD_DIR, name))).size)
    } catch {
      // Removed between the listing and the stat: nothing new in it.
    }
  }
  return sizes
}

/** The reasons of the letters appended to the dead-letter files since `before`. */
async function newDeadReasons(spool: string, before: ReadonlyMap<string, number>): Promise<string[]> {
  const reasons: string[] = []
  for (const [name, size] of await deadLetterSizes(spool)) {
    const from = before.get(name) ?? 0
    if (size <= from) continue
    const handle = await fs.open(join(spool, DEAD_DIR, name), 'r')
    try {
      const buffer = Buffer.alloc(size - from)
      await handle.read(buffer, 0, buffer.length, from)
      for (const line of buffer.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const letter = JSON.parse(line) as { reason?: unknown }
          reasons.push(typeof letter.reason === 'string' ? letter.reason : 'rejected')
        } catch {
          reasons.push('rejected')
        }
      }
    } finally {
      await handle.close()
    }
  }
  return reasons
}

export type SendOutcome = { delivered: true } | { delivered: false; stopped: DrainStop | 'unacknowledged' }

/**
 * Spools one session's prepared events, dead-letters the refused ones, and
 * drains the spool. `delivered` is true only when nothing is left in it.
 */
export async function sendSession(
  target: SendTarget,
  sessionId: string,
  prepared: PreparedEvents,
  tally: SendTally,
): Promise<SendOutcome> {
  for (const event of prepared.ready) bump(tally.events, event.type)
  for (const { reason } of prepared.refused) bump(tally.rejected, reason)
  writeDeadLetters(sessionId, prepared.refused, { root: target.spool })
  const files = await writeSpoolBatch(sessionId, prepared.ready, { root: target.spool })
  if (files.length === 0) return { delivered: true }
  const before = await deadLetterSizes(target.spool)
  const result = await drainSpool({
    env: target.env,
    root: target.spool,
    endpoint: target.endpoint,
    tokenFile: target.tokenFile,
    client: target.client,
  })
  tally.accepted += result.accepted
  tally.duplicates += result.duplicates
  for (const reason of await newDeadReasons(target.spool, before)) bump(tally.rejected, reason)
  if (result.remaining > 0 || result.stopped !== null) {
    return { delivered: false, stopped: result.stopped ?? 'unacknowledged' }
  }
  return { delivered: true }
}
