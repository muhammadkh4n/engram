#!/usr/bin/env node
/**
 * Wave 3 consolidation integration test against production Neo4j + Supabase.
 *
 * Runs each consolidation cycle and reports results.
 * Requires: SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 *
 * Usage: source ~/.engram/env && npx tsx packages/mcp/src/test-wave3-consolidation.ts
 */

import { SupabaseStorageAdapter } from '@engram-mem/supabase'
import { openaiIntelligence } from '@engram-mem/openai'
import { createMemory } from '@engram-mem/core'
import { NeuralGraph } from '@engram-mem/graph'

async function main() {
  const supabaseUrl = process.env['SUPABASE_URL']
  const supabaseKey = process.env['SUPABASE_KEY']
  const openaiKey = process.env['OPENAI_API_KEY']
  const neo4jUri = process.env['NEO4J_URI'] ?? 'bolt://rexvps:7687'
  const neo4jUser = process.env['NEO4J_USER'] ?? 'neo4j'
  const neo4jPass = process.env['NEO4J_PASSWORD']

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_KEY')
    process.exit(1)
  }

  console.log('=== Wave 3 Consolidation Integration Test ===\n')

  // Setup
  const storage = new SupabaseStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  await storage.initialize()
  console.log('[ok] Supabase connected')

  const intelligence = openaiKey ? openaiIntelligence({ apiKey: openaiKey }) : undefined
  console.log(`[ok] Intelligence: ${intelligence ? 'OpenAI' : 'heuristic-only'}`)

  let graph: NeuralGraph | undefined
  if (neo4jPass) {
    try {
      graph = new NeuralGraph({ neo4jUri, neo4jUser, neo4jPassword: neo4jPass, enabled: true })
      await graph.initialize()
      const available = await graph.isAvailable()
      console.log(`[ok] Neo4j: ${available ? 'connected' : 'unavailable'}`)

      if (typeof graph.isGdsAvailable === 'function') {
        const gds = await graph.isGdsAvailable()
        console.log(`[ok] GDS: ${gds ? 'available' : 'not installed'}`)
      }

      // Pre-consolidation stats
      const stats = await graph.stats()
      console.log(`[ok] Graph nodes: ${JSON.stringify(stats.total)}`)
    } catch (err) {
      console.warn(`[warn] Neo4j connection failed: ${(err as Error).message}`)
    }
  } else {
    console.log('[skip] Neo4j: no password configured')
  }

  const memory = createMemory({ storage, intelligence, graph })
  await memory.initialize()

  // Pre-consolidation data check
  const preStats = await memory.stats()
  console.log(`\n--- Pre-consolidation Stats ---`)
  console.log(`Episodes:    ${preStats.episodes}`)
  console.log(`Digests:     ${preStats.digests}`)
  console.log(`Semantic:    ${preStats.semantic}`)
  console.log(`Procedural:  ${preStats.procedural}`)

  // Run each cycle separately and report
  console.log('\n--- Running Light Sleep ---')
  const t1 = Date.now()
  try {
    const lightResult = await memory.consolidate('light')
    console.log(`[ok] Light sleep: ${Date.now() - t1}ms`)
    console.log(`  Digests created: ${lightResult.digestsCreated ?? 0}`)
    console.log(`  Episodes processed: ${lightResult.episodesProcessed ?? 0}`)
    console.log(`  Graph nodes: ${lightResult.graphNodesCreated ?? 'n/a'}`)
    console.log(`  Graph edges: ${lightResult.graphEdgesCreated ?? 'n/a'}`)
  } catch (err) {
    console.error(`[FAIL] Light sleep: ${(err as Error).message}`)
  }

  console.log('\n--- Running Deep Sleep ---')
  const t2 = Date.now()
  try {
    const deepResult = await memory.consolidate('deep')
    console.log(`[ok] Deep sleep: ${Date.now() - t2}ms`)
    console.log(`  Promoted: ${deepResult.promoted ?? 0}`)
    console.log(`  Procedural: ${deepResult.procedural ?? 0}`)
    console.log(`  Deduplicated: ${deepResult.deduplicated ?? 0}`)
    console.log(`  Superseded: ${deepResult.superseded ?? 0}`)
    console.log(`  Graph nodes: ${deepResult.graphNodesCreated ?? 'n/a'}`)
    console.log(`  Graph edges: ${deepResult.graphEdgesCreated ?? 'n/a'}`)
  } catch (err) {
    console.error(`[FAIL] Deep sleep: ${(err as Error).message}`)
  }

  console.log('\n--- Running Dream Cycle ---')
  const t3 = Date.now()
  try {
    const dreamResult = await memory.consolidate('dream')
    console.log(`[ok] Dream cycle: ${Date.now() - t3}ms`)
    console.log(`  Communities detected: ${dreamResult.communitiesDetected ?? 'n/a'}`)
    console.log(`  Bridge nodes: ${dreamResult.bridgeNodesFound ?? 'n/a'}`)
    console.log(`  Replay edges: ${dreamResult.replayEdgesCreated ?? 'n/a'}`)
    console.log(`  Causal edges: ${dreamResult.causalEdgesCreated ?? 'n/a'}`)
    console.log(`  SQL associations: ${dreamResult.associationsCreated ?? 0}`)
  } catch (err) {
    console.error(`[FAIL] Dream cycle: ${(err as Error).message}`)
  }

  console.log('\n--- Running Decay Pass ---')
  const t4 = Date.now()
  try {
    const decayResult = await memory.consolidate('decay')
    console.log(`[ok] Decay pass: ${Date.now() - t4}ms`)
    console.log(`  Semantic decayed: ${decayResult.semanticDecayed ?? 0}`)
    console.log(`  Procedural decayed: ${decayResult.proceduralDecayed ?? 0}`)
    console.log(`  SQL edges pruned: ${decayResult.edgesPruned ?? 0}`)
    console.log(`  Graph edges pruned: ${decayResult.graphEdgesPruned ?? 'n/a'}`)
    console.log(`  Isolated nodes: ${decayResult.isolatedNodesDeprioritized ?? 'n/a'}`)
  } catch (err) {
    console.error(`[FAIL] Decay pass: ${(err as Error).message}`)
  }

  // Post-consolidation stats
  const postStats = await memory.stats()
  console.log(`\n--- Post-consolidation Stats ---`)
  console.log(`Episodes:    ${postStats.episodes}`)
  console.log(`Digests:     ${postStats.digests} (delta: +${postStats.digests - preStats.digests})`)
  console.log(`Semantic:    ${postStats.semantic} (delta: +${postStats.semantic - preStats.semantic})`)
  console.log(`Procedural:  ${postStats.procedural} (delta: +${postStats.procedural - preStats.procedural})`)

  // Post-consolidation graph stats
  if (graph) {
    const postGraphStats = await graph.stats()
    console.log(`Graph nodes: ${JSON.stringify(postGraphStats.total)}`)
  }

  // Test recall quality
  console.log('\n--- Recall Quality Check ---')
  const testQueries = [
    'What architectural decisions were made about engram?',
    'What does Muhammad prefer for development tools?',
    'What happened with the GhostWriter blog posts?',
  ]

  for (const q of testQueries) {
    try {
      const result = await memory.recall(q)
      const topContent = result.memories[0]?.content?.slice(0, 100) ?? '(empty)'
      console.log(`Q: "${q}"`)
      console.log(`  Hits: ${result.memories.length}, Top: ${topContent}...`)
    } catch (err) {
      console.error(`  [FAIL] ${(err as Error).message}`)
    }
  }

  console.log('\n=== Done ===')

  if (graph) {
    await graph.dispose()
  }
  await storage.dispose()
  process.exit(0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
