import type { Memory, ForgetPreview, ForgetByIdsResult } from '@engram-mem/core'

export const FORGET_DESCRIPTION =
  'Forget memories in two steps: query previews the matching memories (ids, tier, relevance, text) and never deletes; ' +
  'ids tombstones exactly those memories. A tombstone hides a memory from every recall path and is reversible in storage. ' +
  'Pass exactly one of query or ids.'

export interface ForgetParams {
  query?: string
  ids?: string[]
}

export interface ForgetToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: ForgetPreview | ForgetByIdsResult | { error: string }
  isError?: true
}

function errorResult(error: string): ForgetToolResult {
  return { content: [{ type: 'text', text: `Error: ${error}` }], details: { error }, isError: true }
}

/**
 * engram_forget in two modes: a query only previews candidates, ids tombstone
 * exactly those memories. Exactly one of the two is accepted so one call can
 * never both search and delete.
 */
export async function executeForget(memory: Memory, params: ForgetParams): Promise<ForgetToolResult> {
  const hasQuery = params.query !== undefined && params.query !== null
  const hasIds = params.ids !== undefined && params.ids !== null
  if (hasQuery === hasIds) {
    return errorResult('pass exactly one of query or ids (query previews, ids forget)')
  }
  try {
    let result: ForgetPreview | ForgetByIdsResult
    if (hasQuery) {
      if (typeof params.query !== 'string' || params.query.trim().length === 0) {
        return errorResult('query must be a non-empty string')
      }
      result = await memory.forget(params.query.trim())
    } else {
      result = await memory.forgetByIds(params.ids as string[])
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err))
  }
}
