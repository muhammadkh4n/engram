#!/usr/bin/env node
/**
 * Engram Graph Backfill
 *
 * One-shot ETL: scans the Supabase `memory_episodes` table in batches,
 * groups episodes by session in chronological order, and replays each
 * one through NeuralGraph.ingestEpisode() so that historical memories
 * get the full Wave 2 graph decomposition (Memory + Person + Entity +
 * Emotion + Intent + Session + TimeContext nodes, plus TEMPORAL chains
 * inside each session).
 *
 * The operation is idempotent: every Neo4j write is MERGE-based, so
 * running the script twice is safe and resumable. Interrupted runs can
 * simply be re-invoked — already-written nodes are touched but not
 * duplicated.
 *
 * Usage:
 *   node dist/backfill-graph.js            # full backfill, all sessions
 *   node dist/backfill-graph.js --dry-run  # count only, no writes
 *   node dist/backfill-graph.js --limit N  # process at most N episodes
 *   node dist/backfill-graph.js --since ISO_DATE  # skip episodes older than this
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import { createClient } from '@supabase/supabase-js'
import { NeuralGraph } from '@engram-mem/graph'

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean
  limit: number | null
  since: string | null
  batchSize: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, limit: null, since: null, batchSize: 500 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--limit') args.limit = Number.parseInt(argv[++i] ?? '0', 10)
    else if (flag === '--since') args.since = argv[++i] ?? null
    else if (flag === '--batch-size') args.batchSize = Number.parseInt(argv[++i] ?? '500', 10)
  }
  return args
}

// ---------------------------------------------------------------------------
// Supabase row shape (subset of memory_episodes)
// ---------------------------------------------------------------------------

interface SupabaseEpisodeRow {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  salience: number | null
  entities: string[] | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const supabaseUrl = requireEnv('SUPABASE_URL')
  const supabaseKey = requireEnv('SUPABASE_KEY')
  const neo4jUri = requireEnv('NEO4J_URI')
  const neo4jUser = process.env['NEO4J_USER'] ?? 'neo4j'
  const neo4jPassword = requireEnv('NEO4J_PASSWORD')

  log(`dry run:    ${args.dryRun}`)
  log(`limit:      ${args.limit ?? '∞'}`)
  log(`since:      ${args.since ?? '∞'}`)
  log(`batch size: ${args.batchSize}`)

  const supabase = createClient(supabaseUrl, supabaseKey)

  const graph = new NeuralGraph({
    neo4jUri,
    neo4jUser,
    neo4jPassword,
    enabled: true,
  })
  if (!args.dryRun) {
    await graph.initialize()
    log('Neo4j initialized')
  }

  // -------------------------------------------------------------------------
  // Stream episodes in chronological order, paginated
  // -------------------------------------------------------------------------

  let offset = 0
  let totalFetched = 0
  let totalIngested = 0
  let totalSkipped = 0
  let totalErrors = 0
  const startedAt = Date.now()

  // Per-session tracking for TEMPORAL edge chain
  const lastEpisodeBySession = new Map<string, string>()

  while (true) {
    const pageSize = Math.min(
      args.batchSize,
      args.limit ? args.limit - totalFetched : args.batchSize,
    )
    if (pageSize <= 0) break

    let query = supabase
      .from('memory_episodes')
      .select('id,session_id,role,content,salience,entities,created_at')
      .order('created_at', { ascending: true })
      .range(offset, offset + pageSize - 1)

    if (args.since) query = query.gte('created_at', args.since)

    const { data, error } = await query

    if (error) {
      log(`[ERROR] Supabase query failed: ${error.message}`)
      totalErrors++
      break
    }

    const rows = (data ?? []) as SupabaseEpisodeRow[]
    if (rows.length === 0) break

    totalFetched += rows.length

    for (const row of rows) {
      // Skip empty or very short content
      if (!row.content || row.content.trim().length < 2) {
        totalSkipped++
        continue
      }

      const previousEpisodeId = lastEpisodeBySession.get(row.session_id)
      lastEpisodeBySession.set(row.session_id, row.id)

      if (args.dryRun) {
        totalIngested++
        continue
      }

      try {
        await graph.ingestEpisode({
          id: row.id,
          sessionId: row.session_id,
          role: row.role,
          content: row.content,
          salience: row.salience ?? 0.5,
          entities: row.entities ?? [],
          createdAt: row.created_at,
          ...(previousEpisodeId ? { previousEpisodeId } : {}),
        })
        totalIngested++
      } catch (err) {
        totalErrors++
        const msg = err instanceof Error ? err.message : String(err)
        log(`[ERROR] ingestEpisode ${row.id} failed: ${msg}`)
      }
    }

    offset += rows.length

    // Progress line every batch
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    const rate = (totalIngested / Math.max(1, Number.parseFloat(elapsed))).toFixed(1)
    log(
      `progress: fetched=${totalFetched} ingested=${totalIngested} skipped=${totalSkipped} errors=${totalErrors} elapsed=${elapsed}s rate=${rate}/s`,
    )

    // Stop if this page was a partial (end of table reached)
    if (rows.length < pageSize) break
    if (args.limit && totalFetched >= args.limit) break
  }

  // -------------------------------------------------------------------------
  // Final stats
  // -------------------------------------------------------------------------

  log('')
  log('=== Backfill complete ===')
  log(`fetched:  ${totalFetched}`)
  log(`ingested: ${totalIngested}`)
  log(`skipped:  ${totalSkipped}`)
  log(`errors:   ${totalErrors}`)
  log(`sessions: ${lastEpisodeBySession.size}`)
  log(`elapsed:  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

  if (!args.dryRun) {
    const stats = await graph.stats()
    log('')
    log('=== Neo4j after backfill ===')
    log(`nodes:         ${JSON.stringify(stats.nodes)}`)
    log(`relationships: ${JSON.stringify(stats.relationships)}`)
    await graph.dispose()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    process.stderr.write(`[backfill] Missing required environment variable: ${name}\n`)
    process.exit(1)
  }
  return val
}

function log(msg: string): void {
  // Log to stderr so the script can be piped without stdout corruption
  process.stderr.write(`[backfill] ${msg}\n`)
}

main().catch((err) => {
  process.stderr.write(`[backfill] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
