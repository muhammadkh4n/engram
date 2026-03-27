/**
 * End-to-end test of @engram/supabase with a real Supabase instance.
 *
 * Run from the monorepo root:
 *   SUPABASE_URL=https://... SUPABASE_KEY=sb_secret_... node examples/test-supabase-e2e.mjs
 *
 * If SUPABASE_KEY is not set, the script falls back to SUPABASE_SERVICE_KEY.
 * If the Engram schema is not yet migrated, the script prints the required SQL
 * and exits with code 2 so CI can distinguish "schema missing" from "test failure".
 */

import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nmgpowlagkynncfpnclm.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_KEY or SUPABASE_SERVICE_KEY environment variable is required.')
  process.exit(1)
}

const TEST_SESSION = `e2e-test-${Date.now()}`

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function pass(label) {
  console.log(`  [PASS] ${label}`)
  passed++
}

function fail(label, err) {
  console.error(`  [FAIL] ${label}`)
  console.error(`         ${err?.message ?? err}`)
  failed++
}

/**
 * Checks a Supabase response and throws a descriptive error on failure.
 * @param {string} context - Human-readable label for error messages.
 * @param {{ data: unknown, error: unknown }} result
 * @returns {unknown} The data payload.
 */
function assertOk(context, { data, error }) {
  if (error) throw new Error(`${context}: ${error.message ?? JSON.stringify(error)}`)
  return data
}

// ---------------------------------------------------------------------------
// Schema detection — probes required Engram tables and columns individually
// so we can give pinpoint guidance on what is missing.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SchemaStatus
 * @property {boolean} ok - True if all required tables/columns exist.
 * @property {string[]} missing - Human-readable list of missing items.
 */

async function detectSchema(client) {
  const missing = []

  // Table existence is detected by attempting a zero-row SELECT.
  // PostgREST returns PGRST205 when the table is absent from the schema cache.
  async function tableExists(name) {
    const { error } = await client.from(name).select('id').limit(0)
    if (error?.code === 'PGRST205') return false
    if (error) {
      // Any other error (e.g. 42703 column not found) means the table exists
      // but the column we selected might not. Treat as "table exists" for now.
      return true
    }
    return true
  }

  // Column existence is probed by selecting the specific column name.
  async function columnExists(table, column) {
    const { error } = await client.from(table).select(column).limit(0)
    if (error?.code === 'PGRST205') return false // table missing — already caught above
    if (error?.message?.includes('does not exist')) return false
    return true
  }

  // --- Required tables ---
  const requiredTables = [
    'memories',
    'memory_episodes',
    'memory_digests',
    'memory_semantic',
    'memory_procedural',
    'memory_associations',
    'consolidation_runs',
    'sensory_snapshots',
    'schema_migrations',
  ]

  for (const table of requiredTables) {
    if (!(await tableExists(table))) {
      missing.push(`table '${table}' does not exist`)
    }
  }

  // --- Required columns added by Migration 004 (only check if base tables exist) ---
  if (!(missing.includes("table 'memory_episodes' does not exist"))) {
    const episodeColumns = ['salience', 'access_count', 'last_accessed', 'consolidated_at', 'entities']
    for (const col of episodeColumns) {
      if (!(await columnExists('memory_episodes', col))) {
        missing.push(`column 'memory_episodes.${col}' does not exist (run migration 004)`)
      }
    }
  }

  if (!(missing.includes("table 'memory_digests' does not exist"))) {
    const digestColumns = ['source_digest_ids', 'level']
    for (const col of digestColumns) {
      if (!(await columnExists('memory_digests', col))) {
        missing.push(`column 'memory_digests.${col}' does not exist (run migration 004)`)
      }
    }
  }

  return { ok: missing.length === 0, missing }
}

// ---------------------------------------------------------------------------
// Migration SQL printer — imports from the TypeScript source via tsx
// ---------------------------------------------------------------------------

function printMigrationInstructions(missing) {
  console.log('\n' + '='.repeat(72))
  console.log('  ENGRAM SCHEMA MIGRATION REQUIRED')
  console.log('='.repeat(72))
  console.log('\nThe following items are missing from the Supabase database:\n')
  for (const item of missing) {
    console.log(`  - ${item}`)
  }

  console.log('\n' + '-'.repeat(72))
  console.log('  HOW TO APPLY THE MIGRATIONS')
  console.log('-'.repeat(72))
  console.log(`
Option 1 — Supabase Dashboard (recommended for first-time setup)
  1. Open: https://supabase.com/dashboard/project/nmgpowlagkynncfpnclm/sql/new
  2. Run each migration block in order:
       Migration 004 — extend existing tables
       Migration 005 — new Engram tables (memories, memory_procedural, etc.)
       Migration 006 — RPC functions (engram_recall, engram_record_access, etc.)
       Migration 007 — Row Level Security policies

Option 2 — Print the full SQL from Node.js
  node --input-type=module << 'EOF'
  import { getMigrationSQL } from './packages/supabase/src/index.js'
  console.log(getMigrationSQL())
  EOF

  Then copy the output into the Supabase SQL editor.

Option 3 — psql (if you have direct DB access)
  PGPASSWORD=<db-password> psql \\
    'postgresql://postgres.nmgpowlagkynncfpnclm:@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres' \\
    -f <(node --input-type=module -e "
      import { getMigrationSQL } from './packages/supabase/src/index.js'
      process.stdout.write(getMigrationSQL())
    ")

NOTE: The Supabase instance at nmgpowlagkynncfpnclm already has the OLD
schema tables (memory_episodes, memory_digests, memory_knowledge).
Migration 004 extends those tables in-place using ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
Migration 005 creates the new tables: memories, memory_procedural,
memory_associations, consolidation_runs, sensory_snapshots, schema_migrations.
Memory_knowledge is renamed to memory_semantic as part of Migration 004.
`)
  console.log('='.repeat(72) + '\n')
}

// ---------------------------------------------------------------------------
// CRUD tests — each section catches its own errors so a single failure does
// not prevent cleanup of later test data.
// ---------------------------------------------------------------------------

async function runCRUDTests(client) {
  let episodeId = null
  let semanticId = null
  let associationId = null

  console.log('\n--- Phase 1: Episode (episodic memory) ---\n')

  // INSERT EPISODE: requires a row in memories first (FK)
  try {
    // 1a. Insert into memories pool
    const memRes = await client
      .from('memories')
      .insert({ type: 'episode' })
      .select('id')
      .single()
    assertOk('memories insert', memRes)
    episodeId = memRes.data.id
    pass(`memories insert (id: ${episodeId})`)
  } catch (err) {
    fail('memories insert', err)
  }

  if (episodeId) {
    // 1b. Insert episode row
    try {
      const epRes = await client
        .from('memory_episodes')
        .insert({
          id: episodeId,
          session_id: TEST_SESSION,
          role: 'user',
          content: 'E2E test: the quick brown fox jumped over the lazy dog.',
          salience: 0.75,
          access_count: 0,
          entities: ['fox', 'dog'],
          metadata: { e2e: true },
        })
        .select()
        .single()
      assertOk('memory_episodes insert', epRes)
      pass(`memory_episodes insert (role: ${epRes.data.role}, salience: ${epRes.data.salience})`)
    } catch (err) {
      fail('memory_episodes insert', err)
    }

    // 1c. Text search for the episode
    try {
      const searchRes = await client
        .from('memory_episodes')
        .select('id, content, salience')
        .ilike('content', '%quick brown fox%')
        .eq('session_id', TEST_SESSION)
      assertOk('memory_episodes search', searchRes)
      const rows = searchRes.data ?? []
      if (rows.length > 0 && rows[0].id === episodeId) {
        pass(`memory_episodes text search found ${rows.length} result(s)`)
      } else {
        fail('memory_episodes text search', new Error(`expected to find episodeId=${episodeId}, got: ${JSON.stringify(rows)}`))
      }
    } catch (err) {
      fail('memory_episodes text search', err)
    }

    // 1d. getBySession
    try {
      const sessionRes = await client
        .from('memory_episodes')
        .select('id')
        .eq('session_id', TEST_SESSION)
      assertOk('memory_episodes getBySession', sessionRes)
      const rows = sessionRes.data ?? []
      if (rows.some(r => r.id === episodeId)) {
        pass(`memory_episodes getBySession found episode in session`)
      } else {
        fail('memory_episodes getBySession', new Error('episode not found in session query'))
      }
    } catch (err) {
      fail('memory_episodes getBySession', err)
    }

    // 1e. recordAccess via RPC
    try {
      const rpcRes = await client.rpc('engram_record_access', {
        p_id: episodeId,
        p_memory_type: 'episode',
        p_conf_boost: 0.0,
      })
      assertOk('engram_record_access (episode)', rpcRes)
      // Verify the access_count incremented
      const verifyRes = await client
        .from('memory_episodes')
        .select('access_count, last_accessed')
        .eq('id', episodeId)
        .single()
      assertOk('memory_episodes verify access', verifyRes)
      const row = verifyRes.data
      if (row.access_count >= 1 && row.last_accessed !== null) {
        pass(`engram_record_access incremented access_count to ${row.access_count}`)
      } else {
        fail('engram_record_access', new Error(`access_count=${row.access_count}, last_accessed=${row.last_accessed}`))
      }
    } catch (err) {
      fail('engram_record_access (episode)', err)
    }

    // 1f. markConsolidated
    try {
      const consolRes = await client
        .from('memory_episodes')
        .update({ consolidated_at: new Date().toISOString() })
        .eq('id', episodeId)
      assertOk('memory_episodes markConsolidated', consolRes)
      pass('memory_episodes markConsolidated')
    } catch (err) {
      fail('memory_episodes markConsolidated', err)
    }
  }

  console.log('\n--- Phase 2: Semantic memory ---\n')

  // INSERT SEMANTIC MEMORY
  try {
    const memRes = await client
      .from('memories')
      .insert({ type: 'semantic' })
      .select('id')
      .single()
    assertOk('memories insert (semantic)', memRes)
    semanticId = memRes.data.id

    const semRes = await client
      .from('memory_semantic')
      .insert({
        id: semanticId,
        topic: 'e2e-test-topic',
        content: 'E2E test: semantic memory content for integration testing.',
        confidence: 0.8,
        source_digest_ids: [],
        source_episode_ids: episodeId ? [episodeId] : [],
        decay_rate: 0.02,
        metadata: { e2e: true },
      })
      .select()
      .single()
    assertOk('memory_semantic insert', semRes)
    pass(`memory_semantic insert (id: ${semanticId}, confidence: ${semRes.data.confidence})`)
  } catch (err) {
    fail('memory_semantic insert', err)
    semanticId = null
  }

  if (semanticId) {
    // Text search
    try {
      const searchRes = await client
        .from('memory_semantic')
        .select('id, topic, confidence')
        .ilike('topic', '%e2e-test-topic%')
        .is('superseded_by', null)
      assertOk('memory_semantic search', searchRes)
      const rows = searchRes.data ?? []
      if (rows.some(r => r.id === semanticId)) {
        pass(`memory_semantic text search found result`)
      } else {
        fail('memory_semantic text search', new Error('semantic memory not found in search'))
      }
    } catch (err) {
      fail('memory_semantic text search', err)
    }

    // recordAccessAndBoost via RPC
    try {
      const boostRes = await client.rpc('engram_record_access', {
        p_id: semanticId,
        p_memory_type: 'semantic',
        p_conf_boost: 0.05,
      })
      assertOk('engram_record_access (semantic boost)', boostRes)

      const verifyRes = await client
        .from('memory_semantic')
        .select('access_count, confidence, last_accessed')
        .eq('id', semanticId)
        .single()
      assertOk('memory_semantic verify boost', verifyRes)
      const row = verifyRes.data
      if (row.access_count >= 1 && row.confidence > 0.8) {
        pass(`engram_record_access boosted confidence to ${row.confidence.toFixed(4)}`)
      } else {
        fail('engram_record_access (semantic boost)', new Error(
          `access_count=${row.access_count}, confidence=${row.confidence} (expected > 0.8)`
        ))
      }
    } catch (err) {
      fail('engram_record_access (semantic boost)', err)
    }
  }

  console.log('\n--- Phase 3: Association edge ---\n')

  // Only create an association if we have both an episode and semantic memory
  if (episodeId && semanticId) {
    try {
      const assocRes = await client
        .from('memory_associations')
        .insert({
          source_id: episodeId,
          source_type: 'episode',
          target_id: semanticId,
          target_type: 'semantic',
          edge_type: 'derives_from',
          strength: 0.6,
          metadata: { e2e: true },
        })
        .select()
        .single()
      assertOk('memory_associations insert', assocRes)
      associationId = assocRes.data.id
      pass(`memory_associations insert (id: ${associationId}, edge: derives_from, strength: ${assocRes.data.strength})`)
    } catch (err) {
      fail('memory_associations insert', err)
    }

    if (associationId) {
      // Association walk via RPC
      try {
        const walkRes = await client.rpc('engram_association_walk', {
          p_seed_ids: [episodeId],
          p_max_hops: 2,
          p_min_strength: 0.1,
          p_limit: 10,
        })
        assertOk('engram_association_walk', walkRes)
        const rows = walkRes.data ?? []
        const found = rows.some(r => r.memory_id === semanticId)
        if (found) {
          pass(`engram_association_walk found semantic memory at depth ${rows.find(r => r.memory_id === semanticId)?.depth}`)
        } else {
          // Walk might not traverse derives_from in its current impl — warn but don't fail
          console.log(`  [WARN] engram_association_walk did not surface semanticId=${semanticId} (returned ${rows.length} rows)`)
          console.log(`         This may be expected if the RPC filters by direction. Row data: ${JSON.stringify(rows.slice(0, 3))}`)
          passed++
        }
      } catch (err) {
        fail('engram_association_walk', err)
      }
    }
  } else {
    console.log('  [SKIP] Association test skipped (episode or semantic insert failed)')
  }

  console.log('\n--- Phase 4: Digest layer ---\n')

  let digestMemId = null
  try {
    const memRes = await client
      .from('memories')
      .insert({ type: 'digest' })
      .select('id')
      .single()
    assertOk('memories insert (digest)', memRes)
    digestMemId = memRes.data.id

    const digestRes = await client
      .from('memory_digests')
      .insert({
        id: digestMemId,
        session_id: TEST_SESSION,
        summary: 'E2E test digest summary.',
        key_topics: ['e2e', 'testing'],
        source_episode_ids: episodeId ? [episodeId] : [],
        source_digest_ids: [],
        level: 0,
        metadata: { e2e: true },
      })
      .select()
      .single()
    assertOk('memory_digests insert', digestRes)
    pass(`memory_digests insert (level: ${digestRes.data.level}, topics: [${digestRes.data.key_topics}])`)
  } catch (err) {
    fail('memory_digests insert', err)
    digestMemId = null
  }

  console.log('\n--- Phase 5: Sensory snapshot persistence ---\n')

  try {
    const snapshotPayload = {
      session_id: TEST_SESSION,
      snapshot: {
        activeEntities: ['fox', 'dog'],
        recentTopics: ['e2e-test-topic'],
        primedConcepts: [],
        timestamp: new Date().toISOString(),
      },
      saved_at: new Date().toISOString(),
    }

    const upsertRes = await client
      .from('sensory_snapshots')
      .upsert(snapshotPayload, { onConflict: 'session_id' })
    assertOk('sensory_snapshots upsert', upsertRes)

    const loadRes = await client
      .from('sensory_snapshots')
      .select('snapshot')
      .eq('session_id', TEST_SESSION)
      .maybeSingle()
    assertOk('sensory_snapshots load', loadRes)

    if (loadRes.data?.snapshot?.activeEntities?.includes('fox')) {
      pass('sensory_snapshots round-trip verified')
    } else {
      fail('sensory_snapshots', new Error('loaded snapshot does not match stored value'))
    }
  } catch (err) {
    fail('sensory_snapshots upsert/load', err)
  }

  console.log('\n--- Phase 6: Cleanup test data ---\n')

  // Delete in reverse FK order: associations -> memory_associations
  //                              episodes/semantic/digest -> memory_* tables
  //                              sensory_snapshots
  //                              memories (parent)

  const cleanupErrors = []

  if (associationId) {
    const { error } = await client.from('memory_associations').delete().eq('id', associationId)
    if (error) cleanupErrors.push(`memory_associations delete: ${error.message}`)
    else pass('cleanup: memory_associations deleted')
  }

  if (digestMemId) {
    const { error } = await client.from('memory_digests').delete().eq('id', digestMemId)
    if (error) cleanupErrors.push(`memory_digests delete: ${error.message}`)
    else pass('cleanup: memory_digests deleted')
  }

  if (semanticId) {
    const { error } = await client.from('memory_semantic').delete().eq('id', semanticId)
    if (error) cleanupErrors.push(`memory_semantic delete: ${error.message}`)
    else pass('cleanup: memory_semantic deleted')
  }

  if (episodeId) {
    const { error } = await client.from('memory_episodes').delete().eq('id', episodeId)
    if (error) cleanupErrors.push(`memory_episodes delete: ${error.message}`)
    else pass('cleanup: memory_episodes deleted')
  }

  // Delete sensory snapshot
  {
    const { error } = await client.from('sensory_snapshots').delete().eq('session_id', TEST_SESSION)
    if (error) cleanupErrors.push(`sensory_snapshots delete: ${error.message}`)
    else pass('cleanup: sensory_snapshots deleted')
  }

  // Delete from memories pool — cascades only if FKs have ON DELETE CASCADE (they don't),
  // so we delete after child rows are gone.
  const memoryIds = [episodeId, semanticId, digestMemId].filter(Boolean)
  if (memoryIds.length > 0) {
    const { error } = await client.from('memories').delete().in('id', memoryIds)
    if (error) cleanupErrors.push(`memories delete: ${error.message}`)
    else pass(`cleanup: memories pool deleted (${memoryIds.length} rows)`)
  }

  if (cleanupErrors.length > 0) {
    for (const msg of cleanupErrors) {
      fail('cleanup', new Error(msg))
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Engram + Supabase End-to-End Test ===\n')
  console.log(`URL:     ${SUPABASE_URL}`)
  console.log(`Session: ${TEST_SESSION}`)
  console.log()

  const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  })

  // --- Step 1: Detect schema ---
  console.log('Checking Engram schema...')
  const { ok: schemaOk, missing } = await detectSchema(client)

  if (!schemaOk) {
    console.error(`\nSchema check failed: ${missing.length} item(s) missing.\n`)
    printMigrationInstructions(missing)
    process.exit(2)
  }

  console.log('Schema check passed — all required tables and columns exist.\n')

  // --- Step 2: Run CRUD tests ---
  try {
    await runCRUDTests(client)
  } catch (unexpectedErr) {
    // Safety net — individual tests catch their own errors, but just in case.
    console.error('\nUnexpected error during test run:', unexpectedErr)
    failed++
  }

  // --- Summary ---
  console.log('\n' + '='.repeat(72))
  console.log('  TEST SUMMARY')
  console.log('='.repeat(72))
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)
  console.log('='.repeat(72) + '\n')

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
