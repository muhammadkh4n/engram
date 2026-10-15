/**
 * The recall read side in schema.sql, read as text: each read function is a
 * public, SECURITY DEFINER function with a fixed search_path and the
 * signature the store adapter calls, granted to service_role; it is defined
 * after the item store triggers and before row security; the items it
 * returns carry no embedding; the store version is a sequence bumped by a
 * trigger function that takes no row lock and that no role may call.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function functionDefinition(name: string): string {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  if (start < 0) throw new Error(`function public.${name} not found`)
  const end = schema.indexOf('$$;', start)
  return schema.slice(start, end + 3)
}

const READ_FUNCTIONS = [
  [
    'engram_recall_items',
    '(p_ids uuid[], p_as_of timestamp with time zone DEFAULT NULL, p_exclude_session text DEFAULT NULL) RETURNS TABLE(id uuid, class text, kind text, speaker text, trust smallint, project_id text, workspace_id text, plan_slug text, session_id text, subject_label text, content_head text, content_length integer, question text, search_head text, occurred_at timestamp with time zone, superseded_by uuid, retired boolean, restated integer, source jsonb, requested boolean, current_id uuid, chain text, end_excluded boolean) LANGUAGE plpgsql STABLE',
    'public.engram_recall_items(uuid[], timestamp with time zone, text)',
  ],
  [
    'engram_active_register_tokens',
    '(p_as_of timestamp with time zone DEFAULT NULL) RETURNS TABLE(register_id text, token text) LANGUAGE sql STABLE',
    'public.engram_active_register_tokens(timestamp with time zone)',
  ],
  ['engram_store_version', '() RETURNS bigint LANGUAGE sql STABLE', 'public.engram_store_version()'],
  [
    'engram_recall_item_states',
    '(p_ids uuid[]) RETURNS TABLE(id uuid, forgotten_at timestamp with time zone, retired_at timestamp with time zone) LANGUAGE sql STABLE',
    'public.engram_recall_item_states(uuid[])',
  ],
  ['engram_project_workspace', '(p_project_id text) RETURNS text LANGUAGE sql STABLE', 'public.engram_project_workspace(text)'],
  ['engram_recall_projects', '() RETURNS TABLE(id text, kind text) LANGUAGE sql STABLE', 'public.engram_recall_projects()'],
  [
    'engram_item_associations',
    '(p_seed_ids uuid[], p_classes text[], p_kinds text[], p_exclude_session text DEFAULT NULL, p_as_of timestamp with time zone DEFAULT NULL, p_include_history boolean DEFAULT false, p_max_observation_trust smallint DEFAULT NULL, p_per_source integer DEFAULT 2) RETURNS TABLE(item_id uuid, source text, seed_id uuid, rank integer) LANGUAGE plpgsql STABLE',
    'public.engram_item_associations(uuid[], text[], text[], text, timestamp with time zone, boolean, smallint, integer)',
  ],
  [
    'engram_items_by_legacy_ids',
    '(p_ids text[]) RETURNS TABLE(legacy_id text, item_id uuid) LANGUAGE plpgsql STABLE',
    'public.engram_items_by_legacy_ids(text[])',
  ],
  [
    'engram_get_items',
    '(p_ids uuid[]) RETURNS TABLE(id uuid, class text, kind text, speaker text, trust smallint, project_id text, workspace_id text, plan_slug text, session_id text, subject_label text, content_head text, content_length integer, question text, occurred_at timestamp with time zone, valid_to timestamp with time zone, superseded_by uuid, restated integer, retired_at timestamp with time zone, retired_reason text, standing boolean, register_status text, register_ref text, source jsonb, lineage uuid[], embedding_model text, content_hash text, extraction_run_id uuid, created_at timestamp with time zone) LANGUAGE plpgsql STABLE',
    'public.engram_get_items(uuid[])',
  ],
  [
    'engram_session_timeline',
    '(p_project_id text DEFAULT NULL, p_from timestamp with time zone DEFAULT NULL, p_to timestamp with time zone DEFAULT NULL, p_limit integer DEFAULT 20) RETURNS TABLE(id uuid, session_id text, project_id text, occurred_at timestamp with time zone, content_head text, content_length integer) LANGUAGE plpgsql STABLE',
    'public.engram_session_timeline(text, timestamp with time zone, timestamp with time zone, integer)',
  ],
  [
    'engram_item_overview',
    '(p_project_id text DEFAULT NULL, p_subject_limit integer DEFAULT 20) RETURNS TABLE(section text, key text, n bigint, latest timestamp with time zone) LANGUAGE plpgsql STABLE',
    'public.engram_item_overview(text, integer)',
  ],
  ['engram_capture_status', '() RETURNS TABLE(metric text, value text) LANGUAGE sql STABLE', 'public.engram_capture_status()'],
  [
    'engram_review_candidates',
    '(p_project_id text DEFAULT NULL, p_workspace_id text DEFAULT NULL, p_ids uuid[] DEFAULT NULL, p_limit integer DEFAULT 4) RETURNS TABLE(id uuid, kind text, quote text, question text, occurred_at timestamp with time zone, session_id text, project_id text, workspace_id text, subject text, proposed_scope text, status text, register_status text, restated_count integer, targets jsonb, total bigint) LANGUAGE plpgsql STABLE',
    'public.engram_review_candidates(text, text, uuid[], integer)',
  ],
] as const

describe('recall read functions', () => {
  it.each(READ_FUNCTIONS)('%s has its signature, SECURITY DEFINER and a fixed search_path', (name, signature) => {
    expect(squash(functionDefinition(name))).toContain(
      `CREATE OR REPLACE FUNCTION public.${name}${signature} SECURITY DEFINER SET search_path TO 'public' AS $$`,
    )
  })

  it.each(READ_FUNCTIONS)('%s is granted to service_role and revoked from PUBLIC', (_name, _signature, privilege) => {
    expect(schema).toContain(`REVOKE EXECUTE ON FUNCTION ${privilege} FROM PUBLIC;`)
    expect(schema).toContain(`GRANT EXECUTE ON FUNCTION ${privilege} TO service_role;`)
    expect(schema).toContain(`EXECUTE format('REVOKE EXECUTE ON FUNCTION ${privilege} FROM %I', role_name);`)
  })

  it.each(READ_FUNCTIONS)('%s only reads', (name) => {
    expect(functionDefinition(name)).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
  })

  it.each(READ_FUNCTIONS)('%s runs in the apply-time smoke', (name) => {
    const smoke = schema.slice(schema.indexOf('DO $smoke$'), schema.indexOf('$smoke$;'))
    expect(smoke).toContain(`public.${name}(`)
  })

  it('defines them after the item store triggers and before row security', () => {
    const lastItemTrigger = schema.indexOf('CREATE TRIGGER memory_items_forget_cascade ')
    const offsets = READ_FUNCTIONS.map(([name]) => schema.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`))
    expect(Math.min(...offsets)).toBeGreaterThan(lastItemTrigger)
    expect(schema.indexOf('ENABLE ROW LEVEL SECURITY;')).toBeGreaterThan(Math.max(...offsets))
  })

  it('returns no embedding, search text or forgotten row from engram_get_items', () => {
    const body = functionDefinition('engram_get_items')
    expect(body).not.toMatch(/embedding,|i\.embedding\b|search_text|\bfts\b/)
    expect(body).toContain('WHERE i.forgotten_at IS NULL')
  })

  it('reads no event payload, item text or error message for capture status', () => {
    const body = functionDefinition('engram_capture_status')
    expect(body).toContain('e.error IS NOT NULL')
    // The error column is only tested for presence; no text column is selected.
    expect(body.replace('e.error IS NOT NULL', '')).not.toMatch(/\b(e|i|r)\.(payload|content|error|context|scrub|search_text)\b/)
  })

  it('counts the review total with a window over the same rows, before the limit, and maps the scope with no ELSE', () => {
    const body = squash(functionDefinition('engram_review_candidates'))
    expect(body).toContain('count(*) OVER ()')
    expect(body).toContain('LIMIT CASE WHEN p_ids IS NULL THEN p_limit END')
    expect(body.match(/RETURN QUERY/g)).toHaveLength(1)
    const scope = body.slice(body.indexOf("CASE i.source ->> 'scope'"), body.indexOf('END', body.indexOf("CASE i.source ->> 'scope'")))
    expect(scope).not.toContain('ELSE')
  })

  it('returns no embedding from engram_recall_items', () => {
    expect(functionDefinition('engram_recall_items')).not.toMatch(/embedding/)
  })

  it('walks every chain in one recursive statement with no hop cap, failing on a successor not later, and has no forgotten-successor state', () => {
    const body = functionDefinition('engram_recall_items')
    expect(body).not.toMatch(/FOR v_hop|max_hops|FOREACH|v_seen/)
    expect(squash(body)).toContain('WITH RECURSIVE walk(start_id, node_id, node_at, next_id, depth) AS (')
    expect(squash(body)).toContain('AND s.occurred_at > w.node_at')
    expect(body).toContain("MESSAGE = 'engram_recall_items: a supersession chain names a successor that did not occur later'")
    expect(body).not.toContain('successor_forgotten')
  })

  it('reads register tokens from the applies_to array of active entries', () => {
    const body = squash(functionDefinition('engram_active_register_tokens'))
    expect(body).toContain("jsonb_array_elements_text( CASE WHEN jsonb_typeof(i.source -> 'applies_to') = 'array'")
    expect(body).toContain("(i.source ->> 'status') = 'active'")
    expect(body).toContain("i.kind = 'ruling_entry'")
  })
})

describe('the step cache', () => {
  it('reads and writes through two SECURITY DEFINER functions, the writer VOLATILE', () => {
    expect(squash(functionDefinition('engram_recall_cache_get'))).toContain(
      "CREATE OR REPLACE FUNCTION public.engram_recall_cache_get(p_step text, p_keys text[]) RETURNS TABLE(cache_key text, version text, text_output jsonb, vector_output public.vector) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$",
    )
    expect(squash(functionDefinition('engram_recall_cache_put'))).toContain(
      "CREATE OR REPLACE FUNCTION public.engram_recall_cache_put(p_step text, p_key text, p_version text, p_text_output jsonb, p_vector_output public.vector) RETURNS TABLE(cache_key text, version text, text_output jsonb, vector_output public.vector) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$",
    )
  })

  it('keeps the first writer and reads the stored row back', () => {
    const body = squash(functionDefinition('engram_recall_cache_put'))
    expect(body).toContain('ON CONFLICT ON CONSTRAINT memory_recall_step_cache_pkey DO NOTHING;')
    expect(body).toContain('RETURN QUERY SELECT c.cache_key, c.version, c.text_output, c.vector_output FROM public.memory_recall_step_cache c WHERE c.step = p_step AND c.cache_key = p_key;')
    expect(body).not.toMatch(/\bUPDATE\b|\bDELETE\b/)
  })

  it('grants both to service_role', () => {
    for (const fn of ['public.engram_recall_cache_get(text, text[])', 'public.engram_recall_cache_put(text, text, text, jsonb, public.vector)']) {
      expect(schema).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role;`)
    }
  })
})

describe('the store version', () => {
  it('reads the sequence and is 0 before the first change', () => {
    expect(squash(functionDefinition('engram_store_version'))).toContain(
      'SELECT CASE WHEN s.is_called THEN s.last_value ELSE 0 END FROM public.memory_store_version_seq s',
    )
  })

  it('creates the sequence before the triggers that bump it', () => {
    const sequence = schema.indexOf('CREATE SEQUENCE IF NOT EXISTS public.memory_store_version_seq;')
    expect(sequence).toBeGreaterThan(0)
    expect(schema.indexOf('CREATE CONSTRAINT TRIGGER engram_store_version_items ')).toBeGreaterThan(sequence)
  })
})
