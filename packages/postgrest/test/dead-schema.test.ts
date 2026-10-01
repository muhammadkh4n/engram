/**
 * schema.sql is re-applied to existing installs, so it must neither recreate
 * tables nothing reads or writes nor declare columns that no code populates.
 * The live tables that still carry legacy constraint names (memory_semantic's
 * memory_knowledge_* constraints) must survive the cleanup.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

describe('schema.sql carries no unused objects', () => {
  it.each([
    'episode_parts',
    'memory_write_buffer',
    'community_summaries',
    'match_knowledge',
    'searchable_content',
  ])('does not mention %s', (name) => {
    expect(schema).not.toContain(name)
  })

  it('creates no memory_knowledge table and none of its constraints', () => {
    expect(schema).not.toMatch(/public\.memory_knowledge\b/)
    expect(schema).not.toMatch(/memory_knowledge_(confidence_check1|pkey1)/)
  })

  it('creates no legacy consolidation_runs table', () => {
    expect(schema).not.toMatch(/(?<![a-z_])consolidation_runs\b/)
  })
})

describe('schema.sql keeps the live tables', () => {
  it('creates memory_consolidation_runs and memories', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS public.memory_consolidation_runs (')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS public.memories (')
  })

  it("keeps memory_semantic's legacy-named constraints and indexes", () => {
    expect(schema).toContain('CONSTRAINT memory_knowledge_confidence_check CHECK')
    expect(schema).toMatch(
      /ALTER TABLE ONLY public\.memory_semantic\s+ADD CONSTRAINT memory_knowledge_pkey PRIMARY KEY \(id\)/,
    )
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON public.memory_semantic')
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_knowledge_confidence ON public.memory_semantic')
  })
})

describe('memory_episodes.fts is generated from content only', () => {
  it('every generated column in the file is built from live columns', () => {
    const generated = schema.match(/GENERATED ALWAYS AS \(.*\) STORED/g) ?? []
    expect(generated.length).toBeGreaterThan(0)
    for (const expr of generated) expect(expr).not.toContain('searchable')
  })

  it('converges an install whose fts expression differs from the declared one', () => {
    const block = schema.match(/DO \$\$\s*DECLARE\s+current_expr text;[\s\S]*?END \$\$;/)
    expect(block).not.toBeNull()
    const body = block![0]
    expect(body).toContain('pg_get_expr(d.adbin, d.adrelid)')
    expect(body).toContain("a.attrelid = 'public.memory_episodes'::regclass")
    expect(body).toContain("current_expr <> 'to_tsvector(''english''::regconfig, content)'")
    expect(body).toContain('ALTER TABLE public.memory_episodes DROP COLUMN fts;')
    expect(body).toContain(
      "ADD COLUMN fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED;",
    )
    expect(body).toContain('CREATE INDEX IF NOT EXISTS idx_episodes_fts ON public.memory_episodes USING gin (fts);')
  })

  it('runs the converge before the episode indexes are created', () => {
    const converge = schema.indexOf('current_expr text;')
    const ftsIndexHeader = schema.indexOf('-- Name: idx_episodes_fts; Type: INDEX')
    expect(converge).toBeGreaterThan(schema.indexOf('CREATE TABLE IF NOT EXISTS public.memory_episodes ('))
    expect(converge).toBeLessThan(ftsIndexHeader)
  })
})
