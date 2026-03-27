/**
 * Engram standalone demo — no API keys, no OpenClaw, just SQLite + BM25.
 *
 * Run: node examples/demo.mjs
 */

import { createMemory } from '../packages/core/src/create-memory.js'
import { SqliteStorageAdapter } from '../packages/sqlite/src/adapter.js'

// Can't use bare imports without build, so construct directly
const storage = new SqliteStorageAdapter('./engram-demo.db')
const memory = createMemory({ storage })

await memory.initialize()
console.log('Engram initialized with SQLite (./engram-demo.db)\n')

// --- Simulate a conversation ---
console.log('=== Ingesting conversation ===\n')

const messages = [
  { role: 'user', content: 'I always prefer TypeScript with strict mode enabled' },
  { role: 'assistant', content: 'Got it, I will use TypeScript strict mode for all code.' },
  { role: 'user', content: 'We decided to use PostgreSQL for the database' },
  { role: 'assistant', content: 'PostgreSQL it is. I will set up the schema accordingly.' },
  { role: 'user', content: 'My workflow is: write tests first, then implement, then refactor' },
  { role: 'assistant', content: 'TDD workflow noted. Tests first, implementation second, refactoring third.' },
  { role: 'user', content: 'Remember that the deploy target is AWS ECS with Fargate' },
  { role: 'assistant', content: 'Noted: AWS ECS Fargate for deployment.' },
  { role: 'user', content: 'I prefer functional components in React, never use class components' },
  { role: 'assistant', content: 'Functional components only, no class components.' },
  { role: 'user', content: 'Before every commit, run prettier and eslint' },
  { role: 'assistant', content: 'Pre-commit: prettier then eslint. Got it.' },
]

for (const msg of messages) {
  await memory.ingest({ sessionId: 'demo-session', ...msg })
  console.log(`  [${msg.role}] ${msg.content.slice(0, 60)}...`)
}

console.log(`\nIngested ${messages.length} messages.\n`)

// --- Recall with different intents ---
console.log('=== Testing Recall ===\n')

const queries = [
  'What TypeScript settings does the user prefer?',
  'What database are we using?',
  'How does the user like to develop code?',
  'What should I do before committing?',
  'Where do we deploy?',
  'hi',  // SOCIAL — should return nothing
]

for (const q of queries) {
  const result = await memory.recall(q)
  console.log(`Q: "${q}"`)
  console.log(`   Intent: ${result.intent.type} (confidence: ${result.intent.confidence})`)
  console.log(`   Memories found: ${result.memories.length}`)
  if (result.memories.length > 0) {
    console.log(`   Top result: "${result.memories[0].content.slice(0, 80)}..."`)
    console.log(`   Relevance: ${result.memories[0].relevance.toFixed(3)}`)
  }
  console.log(`   Primed topics: [${result.primed.join(', ')}]`)
  console.log()
}

// --- Run consolidation ---
console.log('=== Running Consolidation (Light Sleep) ===\n')

const lightResult = await memory.consolidate('light')
console.log(`  Digests created: ${lightResult.digestsCreated || 0}`)
console.log(`  Episodes processed: ${lightResult.episodesProcessed || 0}`)

// --- Run deep sleep to extract knowledge ---
console.log('\n=== Running Consolidation (Deep Sleep) ===\n')

const deepResult = await memory.consolidate('deep')
console.log(`  Semantic memories promoted: ${deepResult.promoted || 0}`)
console.log(`  Procedural memories created: ${deepResult.procedural || 0}`)
console.log(`  Deduplicated: ${deepResult.deduplicated || 0}`)

// --- Check stats ---
console.log('\n=== Memory Stats ===\n')
const stats = await memory.stats()
console.log(`  Episodes: ${stats.episodes}`)
console.log(`  Digests: ${stats.digests}`)
console.log(`  Semantic: ${stats.semantic}`)
console.log(`  Procedural: ${stats.procedural}`)
console.log(`  Associations: ${stats.associations}`)

// --- Recall AFTER consolidation (should find semantic/procedural memories too) ---
console.log('\n=== Recall After Consolidation ===\n')

const q2 = 'What are the user preferences and workflow?'
const result2 = await memory.recall(q2)
console.log(`Q: "${q2}"`)
console.log(`   Intent: ${result2.intent.type}`)
console.log(`   Memories found: ${result2.memories.length}`)
for (const m of result2.memories.slice(0, 5)) {
  console.log(`   [${m.type}] (${m.relevance.toFixed(3)}) ${m.content.slice(0, 80)}`)
}

// --- Expand a digest ---
if (stats.digests > 0) {
  console.log('\n=== Expand Digest ===\n')
  // Search for a digest first
  const digestResult = await memory.recall('conversation summary')
  const digestMem = digestResult.memories.find(m => m.type === 'digest')
  if (digestMem) {
    const expanded = await memory.expand(digestMem.id)
    console.log(`  Expanded digest "${digestMem.content.slice(0, 50)}..."`)
    console.log(`  Original episodes: ${expanded.episodes.length}`)
    for (const ep of expanded.episodes.slice(0, 3)) {
      console.log(`    [${ep.role}] ${ep.content.slice(0, 60)}`)
    }
  }
}

await memory.dispose()
console.log('\nDone. Database saved to ./engram-demo.db')
