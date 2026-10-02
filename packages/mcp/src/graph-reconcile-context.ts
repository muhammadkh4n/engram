/**
 * Context-link check of the graph reconcile. Digests and facts used to
 * inherit every Person/Entity/Topic link of their sources, so sibling facts
 * of one digest carried one shared entity set. A digest's or fact's
 * CONTEXTUAL edge is kept only when the memory's own SQL text (digest
 * summary; fact topic and content) names the context node; every other edge
 * is pruned. Planning is pure per page; I/O goes through the injected source
 * and graph, one keyset page of nodes at a time, so memory stays bounded.
 */

import { namedEntities } from '@engram-mem/core'

export type TextTier = 'semantic' | 'digest'

export const TEXT_TIERS: readonly TextTier[] = ['semantic', 'digest']

export interface ContextEdge {
  /** Element id of the Person, Entity or Topic node. */
  ctxId: string
  name: string | null
  /** Every property of the relationship, encoded by the graph adapter so it can write them back. */
  props: Record<string, unknown>
}

export interface ContextLinkNode {
  id: string
  /** The node carries `forgottenAt`. */
  forgotten: boolean
  edges: ContextEdge[]
}

export interface MemoryText {
  id: string
  tier: TextTier
  text: string
  /** `forgotten_at` or `superseded_by` is set on the row. */
  inactive: boolean
}

export interface ContextTextSource {
  /** The text of each row of `tier` whose id is in `ids`, inactive rows included. */
  fetchTexts(tier: TextTier, ids: readonly string[]): Promise<MemoryText[]>
}

export interface ContextLinkRef {
  memoryId: string
  ctxId: string
}

export interface ContextUndoLine {
  op: 'ctx'
  memoryId: string
  ctxId: string
  props: Record<string, unknown>
}

export interface RemainingLiveLinks {
  ctxId: string
  name: string | null
  /** Live Memory nodes, any tier, still linked to the node once the listed edges are gone. */
  remaining: number
}

export interface ContextLinkGraph {
  /**
   * Memory nodes typed semantic or digest with an id strictly after `after`
   * (all when null), ordered by id, each with its CONTEXTUAL edges to
   * Person/Entity/Topic nodes.
   */
  fetchContextPage(after: string | null, limit: number): Promise<ContextLinkNode[]>
  /** Counts each context node's live Memory neighbours, ignoring the CONTEXTUAL edges from `prunedMemoryIds`. */
  remainingLiveLinks(rows: ReadonlyArray<{ ctxId: string; prunedMemoryIds: string[] }>): Promise<RemainingLiveLinks[]>
  /** Deletes the CONTEXTUAL edge from each memory to each context node; returns the number deleted. */
  deleteContextLinks(links: readonly ContextLinkRef[]): Promise<number>
  /** Re-creates each edge with exactly the logged properties; returns the number written. */
  restoreContextLinks(lines: readonly ContextUndoLine[]): Promise<number>
}

export interface ContextBucket {
  nodes: number
  edges: number
  kept: number
  pruned: number
  /** Nodes with no context link once the pruned edges are gone. */
  zeroLinks: number
}

export interface ContextLinksReport {
  tiers: Record<TextTier, { live: ContextBucket; retired: ContextBucket }>
  /** Nodes with no semantic or digest SQL row: left as they are. */
  skippedNoRow: number
  /** Context nodes whose last link from a live Memory node of any tier is a pruned edge. */
  orphanedEntities: Array<{ name: string | null }>
}

export interface ContextDecision {
  node: ContextLinkNode
  row: MemoryText
  kept: ContextEdge[]
  pruned: ContextEdge[]
}

export const DEFAULT_CONTEXT_PAGE_SIZE = 500
const REMAINING_BATCH = 500

const key = (id: string): string => id.toLowerCase()

const emptyBucket = (): ContextBucket => ({ nodes: 0, edges: 0, kept: 0, pruned: 0, zeroLinks: 0 })

function emptyReport(): ContextLinksReport {
  return {
    tiers: {
      semantic: { live: emptyBucket(), retired: emptyBucket() },
      digest: { live: emptyBucket(), retired: emptyBucket() },
    },
    skippedNoRow: 0,
    orphanedEntities: [],
  }
}

/** Splits each node's edges into the ones its own text names and the ones it does not. */
export function decideContextPage(
  nodes: readonly ContextLinkNode[],
  texts: readonly MemoryText[],
): { decisions: ContextDecision[]; skippedNoRow: number } {
  const textById = new Map<string, MemoryText>()
  for (const t of texts) if (!textById.has(key(t.id))) textById.set(key(t.id), t)

  const decisions: ContextDecision[] = []
  let skippedNoRow = 0
  for (const node of nodes) {
    const row = textById.get(key(node.id))
    if (!row) {
      skippedNoRow++
      continue
    }
    const named = new Set(
      namedEntities(
        row.text,
        node.edges.map((e) => ({ id: e.ctxId, name: e.name ?? '' })),
      ).ids,
    )
    decisions.push({
      node,
      row,
      kept: node.edges.filter((e) => named.has(e.ctxId)),
      pruned: node.edges.filter((e) => !named.has(e.ctxId)),
    })
  }
  return { decisions, skippedNoRow }
}

/** Visits every keyset page of semantic and digest nodes with its decisions. */
async function forEachContextPage(
  sql: ContextTextSource,
  graph: ContextLinkGraph,
  pageSize: number,
  visit: (page: { decisions: ContextDecision[]; skippedNoRow: number }) => Promise<void>,
): Promise<void> {
  let after: string | null = null
  for (;;) {
    const nodes = await graph.fetchContextPage(after, pageSize)
    if (nodes.length > 0) {
      const ids = nodes.map((n) => n.id)
      const texts: MemoryText[] = []
      for (const tier of TEXT_TIERS) texts.push(...(await sql.fetchTexts(tier, ids)))
      await visit(decideContextPage(nodes, texts))
    }
    if (nodes.length < pageSize) return
    after = nodes[nodes.length - 1]!.id
  }
}

/** Dry pass: counts per tier and liveness, and the context nodes the prune would leave with no live link. */
export async function planContextLinks(
  sql: ContextTextSource,
  graph: ContextLinkGraph,
  pageSize: number,
): Promise<ContextLinksReport> {
  const report = emptyReport()
  // Only edges from nodes the graph treats as live can take away a live link.
  const prunedByCtx = new Map<string, Set<string>>()

  await forEachContextPage(sql, graph, pageSize, async ({ decisions, skippedNoRow }) => {
    report.skippedNoRow += skippedNoRow
    for (const d of decisions) {
      const bucket = report.tiers[d.row.tier][d.row.inactive ? 'retired' : 'live']
      bucket.nodes++
      bucket.edges += d.node.edges.length
      bucket.kept += d.kept.length
      bucket.pruned += d.pruned.length
      if (d.kept.length === 0) bucket.zeroLinks++
      if (d.node.forgotten) continue
      for (const e of d.pruned) {
        const ids = prunedByCtx.get(e.ctxId) ?? new Set<string>()
        ids.add(d.node.id)
        prunedByCtx.set(e.ctxId, ids)
      }
    }
  })

  const rows = [...prunedByCtx].map(([ctxId, ids]) => ({ ctxId, prunedMemoryIds: [...ids] }))
  for (let i = 0; i < rows.length; i += REMAINING_BATCH) {
    for (const r of await graph.remainingLiveLinks(rows.slice(i, i + REMAINING_BATCH))) {
      if (r.remaining === 0) report.orphanedEntities.push({ name: r.name })
    }
  }
  return report
}

/**
 * Apply pass: deletes each page's pruned edges in batches, each batch after
 * its undo lines are persisted. Texts are read again here, so the decision
 * follows SQL as it is when the edge is deleted.
 */
export async function pruneContextLinks(
  sql: ContextTextSource,
  graph: ContextLinkGraph,
  appendUndo: (lines: readonly ContextUndoLine[]) => Promise<void>,
  pageSize: number,
  batchSize: number,
): Promise<number> {
  let deleted = 0
  await forEachContextPage(sql, graph, pageSize, async ({ decisions }) => {
    const lines: ContextUndoLine[] = decisions.flatMap((d) =>
      d.pruned.map((e) => ({ op: 'ctx' as const, memoryId: d.node.id, ctxId: e.ctxId, props: e.props })),
    )
    for (let i = 0; i < lines.length; i += batchSize) {
      const batch = lines.slice(i, i + batchSize)
      await appendUndo(batch)
      deleted += await graph.deleteContextLinks(batch.map((l) => ({ memoryId: l.memoryId, ctxId: l.ctxId })))
    }
  })
  return deleted
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `ctx` lines of an undo log, validated; other lines are only counted. */
export function parseContextUndoLog(text: string): { lines: ContextUndoLine[]; other: number } {
  const lines: ContextUndoLine[] = []
  let other = 0
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`undo log line ${i + 1} is not JSON`)
    }
    if (!isRecord(parsed) || parsed['op'] !== 'ctx') {
      other++
      return
    }
    const { memoryId, ctxId, props } = parsed
    if (typeof memoryId !== 'string' || typeof ctxId !== 'string' || !isRecord(props)) {
      throw new Error(`undo log line ${i + 1} is a malformed ctx line`)
    }
    lines.push({ op: 'ctx', memoryId, ctxId, props })
  })
  return { lines, other }
}

/** Re-creates every pruned edge of an undo log, in batches. */
export async function undoContextLinks(
  graph: ContextLinkGraph,
  log: (line: string) => void,
  undoText: string,
  batchSize: number,
): Promise<{ restored: number; requested: number; other: number }> {
  const { lines, other } = parseContextUndoLog(undoText)
  let restored = 0
  for (let i = 0; i < lines.length; i += batchSize) {
    restored += await graph.restoreContextLinks(lines.slice(i, i + batchSize))
  }
  log(
    `context links restored: ${restored} of ${lines.length}` +
      (restored < lines.length ? ' (the rest name a memory or context node that no longer exists)' : '') +
      `\nother undo lines left as they are: ${other}`,
  )
  return { restored, requested: lines.length, other }
}

/** Counts only, except the names of context nodes the prune would leave without a live link. */
export function formatContextReport(report: ContextLinksReport): string {
  const row = (label: string, b: ContextBucket): string =>
    `  ${label.padEnd(18)} nodes ${b.nodes}, edges ${b.edges}, kept ${b.kept}, pruned ${b.pruned}, ` +
    `left with 0 links ${b.zeroLinks}`
  const lines = [
    'context links (kept when the memory text names the node):',
    ...TEXT_TIERS.flatMap((t) => [
      row(`${t} live`, report.tiers[t].live),
      row(`${t} retired`, report.tiers[t].retired),
    ]),
    `  nodes without a SQL row (skipped): ${report.skippedNoRow}`,
    `  entities losing their last live link: ${report.orphanedEntities.length}`,
    ...report.orphanedEntities.map((e) => `    - ${JSON.stringify(e.name)}`),
  ]
  return lines.join('\n')
}
