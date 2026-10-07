/**
 * Row parsing for the operator re-run RPCs: engram_extraction_sessions,
 * engram_extraction_session_anchors and the part of
 * engram_extraction_replace's result the commit does not return. Every value
 * is checked, so a shape the RPC never returns fails loudly instead of
 * steering a re-run.
 */
import type { AnchorKind, ExtractionSession, ReplacedSupersession, SessionAnchor } from '@engram-mem/core'
import { isUuid } from './uuid.js'

const ANCHOR_KINDS: ReadonlySet<string> = new Set<AnchorKind>(['user_prompt', 'user_answer', 'turns'])

export interface ReplaceExtras {
  retired: string[]
  restored: ReplacedSupersession[]
  keptRecorded: string[]
  unrestated: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms)
}

function rows(operation: string, data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data) || !data.every(isRecord)) {
    throw new Error(`${operation} failed: the RPC returned no rows array`)
  }
  return data
}

export function toExtractionSessions(data: unknown): ExtractionSession[] {
  return rows('extractionSessions', data).map((row) => {
    const firstAt = row.first_at === null ? null : parseTime(row.first_at)
    if (
      typeof row.session_id !== 'string' ||
      row.session_id === '' ||
      (row.first_at !== null && firstAt === null) ||
      typeof row.due !== 'boolean'
    ) {
      throw new Error('extractionSessions failed: the RPC returned an unexpected row')
    }
    return { sessionId: row.session_id, firstAt, due: row.due }
  })
}

export function toSessionAnchors(data: unknown): SessionAnchor[] {
  return rows('extractionSessionAnchors', data).map((row) => {
    const occurredAt = parseTime(row.occurred_at)
    const running = row.running_run_id
    if (
      typeof row.anchor_item_id !== 'string' ||
      !isUuid(row.anchor_item_id) ||
      typeof row.anchor_kind !== 'string' ||
      !ANCHOR_KINDS.has(row.anchor_kind) ||
      occurredAt === null ||
      typeof row.succeeded !== 'boolean' ||
      !(running === null || (typeof running === 'string' && isUuid(running)))
    ) {
      throw new Error('extractionSessionAnchors failed: the RPC returned an unexpected row')
    }
    return {
      anchorId: row.anchor_item_id,
      anchorKind: row.anchor_kind as AnchorKind,
      occurredAt,
      succeeded: row.succeeded,
      runningRunId: running as string | null,
    }
  })
}

function uuids(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && isUuid(id))) return null
  return value as string[]
}

function restoredEntry(value: unknown): ReplacedSupersession | null {
  if (!isRecord(value)) return null
  const { item, from, to } = value
  if (typeof item !== 'string' || !isUuid(item) || typeof from !== 'string' || !isUuid(from)) return null
  if (!(to === null || (typeof to === 'string' && isUuid(to)))) return null
  return { item, from, to: to as string | null }
}

export function toReplaceExtras(data: unknown): ReplaceExtras {
  const unexpected = new Error('extractionReplace failed: the RPC returned an unexpected result')
  if (!isRecord(data)) throw unexpected
  const retired = uuids(data.retired)
  const keptRecorded = uuids(data.kept_recorded)
  const restored = Array.isArray(data.restored) ? data.restored.map(restoredEntry) : null
  const unrestated = data.unrestated
  if (
    retired === null ||
    keptRecorded === null ||
    restored === null ||
    restored.some((entry) => entry === null) ||
    typeof unrestated !== 'number' ||
    !Number.isInteger(unrestated) ||
    unrestated < 0
  ) {
    throw unexpected
  }
  return { retired, restored: restored as ReplacedSupersession[], keptRecorded, unrestated }
}
