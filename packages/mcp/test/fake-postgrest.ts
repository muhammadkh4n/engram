import { PostgrestClient } from '@supabase/postgrest-js'

export interface FakeRequest {
  method: string
  table: string
  params: URLSearchParams
  body: unknown
}

type Row = Record<string, unknown>

function inList(value: string): string[] {
  return value
    .replace(/^in\.\(/, '')
    .replace(/\)$/, '')
    .split(',')
    .map((v) => v.replace(/^"|"$/g, ''))
}

function matches(row: Row, key: string, filter: string): boolean {
  const value = row[key]
  if (filter.startsWith('eq.')) return String(value) === filter.slice(3)
  if (filter.startsWith('neq.')) return String(value) !== filter.slice(4)
  if (filter.startsWith('gt.')) return String(value) > filter.slice(3)
  if (filter === 'is.null') return value === null || value === undefined
  if (filter.startsWith('in.')) return inList(filter).includes(String(value))
  throw new Error(`fake PostgREST: unsupported filter ${key}=${filter}`)
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'or', 'columns'])

/**
 * A PostgrestClient whose fetch serves in-memory tables and, like a server
 * with max-rows set, silently truncates every response at `maxRows`.
 * Supports the eq / neq / gt / is.null / in filters, `order=id.asc`, `limit`
 * and PATCH with a returned representation.
 */
export function fakePostgrest(tables: Record<string, Row[]>, maxRows: number): {
  client: PostgrestClient
  requests: FakeRequest[]
} {
  const requests: FakeRequest[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const table = url.pathname.split('/').pop()!
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ method, table, params: url.searchParams, body })
    let rows = (tables[table] ?? []).filter((row) =>
      [...url.searchParams].every(([key, filter]) => RESERVED.has(key) || matches(row, key, filter)),
    )
    if (url.searchParams.get('order') === 'id.asc') rows = [...rows].sort((a, b) => String(a['id']).localeCompare(String(b['id'])))
    if (method === 'PATCH') for (const row of rows) Object.assign(row, body)
    const limit = Number(url.searchParams.get('limit') ?? Infinity)
    const page = rows.slice(0, Math.min(limit, maxRows))
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new PostgrestClient('http://fake.local', { fetch: fetchImpl as typeof fetch })
  return { client, requests }
}
