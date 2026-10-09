/**
 * memory_forget, memory_retire and memory_unretire: act on stored memories by
 * id, with a reason. A forget reaches items and the old tables alike and
 * cascades through everything derived from what it forgets; retire and
 * unretire act on items only. Each call is one database transaction that
 * also writes its audit row. Argument text is never logged.
 */
import { MAX_FORGET_IDS } from '@engram-mem/core'
import type { ForgetPreview, ForgottenMemory, ItemActionResult, ItemStore } from '@engram-mem/core'

type ToolTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

/** Where these tools record a call in the audit table. */
export const MCP_CHANNEL = 'mcp'
export const ITEM_ACTION_REASON_MAX_CHARS = 2000
const ID_MAX_CHARS = 200
const FORGET_PREVIEW_TEXT_CHARS = 160
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const IDS_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: MAX_FORGET_IDS,
}
const REASON_SCHEMA = { type: 'string', minLength: 1, maxLength: ITEM_ACTION_REASON_MAX_CHARS }

export const MEMORY_FORGET_TOOL = {
  name: 'memory_forget',
  description:
    'Forget memories in two steps. Call with query to preview: it lists the matching memories (id, tier, date, ' +
    'relevance, text), digests included, and never forgets anything. Then call with ids and a reason: those memories ' +
    'and everything derived from them are forgotten in one step. A forget cascades: an utterance takes the statements ' +
    "and session index built on it, an episode its digests and the facts and procedures citing it, a digest the facts " +
    'and procedures built from it, and an old row and its legacy copy take each other. A forgotten memory is hidden ' +
    'from every recall path. The answer lists the requested ids, every cascaded id with the id that pulled it in, ' +
    `items restored or re-pointed because their successor was forgotten, and ids not found. At most ${MAX_FORGET_IDS} ids per call.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Describes what to forget. Previews candidates only; takes no reason.' },
      ids: { ...IDS_SCHEMA, description: 'Memory or item ids to forget, taken from a preview or a recall.' },
      reason: { ...REASON_SCHEMA, description: 'Required with ids: why these are forgotten. Stored with the forget.' },
    },
  },
}

function retireTool(action: 'retire' | 'unretire') {
  const effect =
    action === 'retire'
      ? 'Retire typed items by id: they stay stored and keep their lineage, and recall leaves them out by default. ' +
        'Use it for an item that is no longer current but was true when stored; forget what should never have been stored.'
      : 'Unretire typed items by id: they return to recall and their retire reason is cleared.'
  return {
    name: `memory_${action}`,
    description:
      `${effect} Items only: an id of the old memory tables is answered "not an item". ` +
      `At most ${MAX_FORGET_IDS} ids per call.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: { ...IDS_SCHEMA, description: `Item ids to ${action}.` },
        reason: { ...REASON_SCHEMA, description: `Why these items are ${action}d. Stored in the audit record.` },
      },
      required: ['ids', 'reason'],
    },
  }
}

export const MEMORY_RETIRE_TOOL = retireTool('retire')
export const MEMORY_UNRETIRE_TOOL = retireTool('unretire')

export interface ForgetToolDeps {
  /** The read-only preview of what a query matches. */
  preview(query: string): Promise<ForgetPreview>
  store: Pick<ItemStore, 'forgetMemories'>
  /** Neo4j, when configured: forgotten old-table ids are stamped there too. */
  graph: { forgetMemories?(ids: string[]): Promise<number> } | null
}

export async function runMemoryForget(deps: ForgetToolDeps, args: Record<string, unknown>): Promise<ToolTextResult> {
  const query = args['query']
  const hasQuery = query !== undefined && query !== null
  const hasIds = args['ids'] !== undefined && args['ids'] !== null
  if (hasQuery === hasIds) return toolError('pass exactly one of query or ids (query previews, ids forget)')
  if (hasQuery) {
    if (args['reason'] !== undefined) return toolError('a reason goes with ids: a query only previews')
    if (typeof query !== 'string' || query.trim().length === 0) return toolError('query must be a non-empty string')
    return toolText(formatForgetPreview(await deps.preview(query.trim())))
  }
  const request = parseIdsAndReason(args)
  if ('error' in request) return toolError(request.error)
  const rows = await deps.store.forgetMemories(request.ids, request.reason, MCP_CHANNEL)
  await stampGraph(deps.graph, rows)
  return toolText(formatForgetResult(request.ids, rows))
}

/**
 * The SQL tombstone is the source of truth. The graph's Memory nodes are
 * stamped as well, so spreading activation cannot reach a forgotten old row;
 * a graph failure, or no graph, never fails the forget.
 */
async function stampGraph(graph: ForgetToolDeps['graph'], rows: readonly ForgottenMemory[]): Promise<void> {
  const oldIds = rows.filter((r) => r.store !== 'memory_items' && r.effect === 'forgotten').map((r) => r.id)
  if (!graph || typeof graph.forgetMemories !== 'function' || oldIds.length === 0) return
  try {
    await graph.forgetMemories(oldIds)
  } catch (err) {
    console.warn('[engram] forget: graph tombstone failed (non-fatal):', err instanceof Error ? err.message : String(err))
  }
}

export interface RetireToolDeps {
  store: Pick<ItemStore, 'retireItems' | 'unretireItems'>
}

export async function runMemoryRetire(
  deps: RetireToolDeps,
  action: 'retire' | 'unretire',
  args: Record<string, unknown>,
): Promise<ToolTextResult> {
  const request = parseIdsAndReason(args)
  if ('error' in request) return toolError(request.error)
  const results =
    action === 'retire'
      ? await deps.store.retireItems(request.ids, request.reason, MCP_CHANNEL)
      : await deps.store.unretireItems(request.ids, request.reason, MCP_CHANNEL)
  return toolText(formatRetireResult(action, results))
}

type IdsRequest = { ids: string[]; reason: string } | { error: string }

/** 1 to 50 distinct ids, a UUID lowercased as the store returns it, and a non-blank reason. */
function parseIdsAndReason(args: Record<string, unknown>): IdsRequest {
  const ids = args['ids']
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'ids must be a non-empty array of memory ids' }
  if (!ids.every((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= ID_MAX_CHARS)) {
    return { error: `every id must be a non-empty string of at most ${ID_MAX_CHARS} characters` }
  }
  const distinct = [...new Set(ids.map((id) => (UUID.test(id.trim()) ? id.trim().toLowerCase() : id.trim())))]
  if (distinct.length > MAX_FORGET_IDS) return { error: `at most ${MAX_FORGET_IDS} ids per call, got ${distinct.length}` }
  const reason = args['reason']
  if (typeof reason !== 'string' || !/\S/.test(reason)) return { error: 'reason must be a non-blank string' }
  if ([...reason].length > ITEM_ACTION_REASON_MAX_CHARS) {
    return { error: `reason must be at most ${ITEM_ACTION_REASON_MAX_CHARS} characters` }
  }
  return { ids: distinct, reason }
}

export function formatForgetPreview(preview: ForgetPreview): string {
  if (preview.candidates.length === 0) return 'No matching memories found.'
  const lines = preview.candidates.map((c) => {
    const tag = c.date ? `${c.type} · ${c.date}` : c.type
    const text = c.content.replace(/\s+/g, ' ').trim().slice(0, FORGET_PREVIEW_TEXT_CHARS)
    return `- [${tag}] ${c.id} · relevance ${c.relevance.toFixed(2)} · ${text}`
  })
  const n = preview.candidates.length
  return [
    `Preview: ${n} matching memor${n === 1 ? 'y' : 'ies'}. Nothing was forgotten.`,
    ...lines,
    'To forget, call memory_forget again with ids set to the ones to remove and a reason.',
  ].join('\n')
}

export function formatForgetResult(requestedIds: readonly string[], rows: readonly ForgottenMemory[]): string {
  const requested = rows.filter((r) => r.requested)
  const cascaded = rows.filter((r) => !r.requested && r.effect === 'forgotten')
  const restored = rows.filter((r) => r.effect === 'restored')
  const repointed = rows.filter((r) => r.effect === 'repointed')
  const found = new Set(requested.map((r) => r.id))
  const notFound = requestedIds.filter((id) => !found.has(id))
  const sections: Array<[string, string[]]> = [
    ['Forgotten', requested.map((r) => `${r.id} (${r.kind})`)],
    ['Cascaded', cascaded.map((r) => `${r.id} (${r.kind}) via ${r.via}`)],
    ['Restored', restored.map((r) => `${r.id} (${r.kind}): its successor ${r.via} was forgotten`)],
    ['Re-pointed', repointed.map((r) => `${r.id} (${r.kind}): past the forgotten ${r.via}`)],
    ['Not found', notFound],
  ]
  const summary =
    `Forgot ${requested.length} requested and ${cascaded.length} cascaded; restored ${restored.length}; ` +
    `re-pointed ${repointed.length}; not found ${notFound.length}.`
  return [summary, ...listSections(sections)].join('\n')
}

export function formatRetireResult(action: 'retire' | 'unretire', results: readonly ItemActionResult[]): string {
  const done = action === 'retire' ? 'retired' : 'unretired'
  const by = (outcome: ItemActionResult['outcome']) => results.filter((r) => r.outcome === outcome)
  const changed = by(done)
  const sections: Array<[string, string[]]> = [
    [action === 'retire' ? 'Retired' : 'Unretired', changed.map((r) => r.id)],
    [action === 'retire' ? 'Already retired' : 'Not retired', by('unchanged').map((r) => r.id)],
    ['Forgotten', by('forgotten').map((r) => r.id)],
    ['Not an item', by('old_row').map((r) => `${r.id}: not an item: forget it, or ${action} its legacy item`)],
    ['Not found', by('not_found').map((r) => r.id)],
  ]
  const recorded = changed
    .filter((r) => r.registerRef !== null)
    .map((r) => `${r.id}: recorded as ${r.registerRef}: change it there too`)
  const summary =
    `${done[0]!.toUpperCase()}${done.slice(1)} ${changed.length}; unchanged ${by('unchanged').length}; ` +
    `forgotten ${by('forgotten').length}; not an item ${by('old_row').length}; not found ${by('not_found').length}.`
  return [summary, ...listSections(sections), ...recorded].join('\n')
}

function listSections(sections: ReadonlyArray<[string, string[]]>): string[] {
  return sections.filter(([, list]) => list.length > 0).map(([label, list]) => `${label} (${list.length}): ${list.join(', ')}`)
}

function toolText(text: string): ToolTextResult {
  return { content: [{ type: 'text' as const, text }] }
}

function toolError(message: string): ToolTextResult {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}
