/**
 * Engram standalone demo — no API keys, no OpenClaw, just SQLite + BM25.
 *
 * Prerequisites:
 *   npm install @engram-mem/core @engram-mem/sqlite
 *
 * Run:
 *   node demo.mjs
 */

import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'

const memory = createMemory({
  storage: sqliteAdapter({ path: './engram-demo.db' }),
})

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

// --- Consolidate BEFORE recall — turns episodes into searchable semantic/procedural memories ---
console.log('=== Running consolidation (light + deep sleep) ===\n')
const light = await memory.consolidate('light')
console.log(`  Light sleep: ${light.digestsCreated ?? 0} digests from ${light.episodesProcessed ?? 0} episodes`)
const deep = await memory.consolidate('deep')
console.log(`  Deep sleep: ${deep.promoted ?? 0} semantic, ${deep.procedural ?? 0} procedural\n`)

// --- Recall ---
console.log('=== Recall ===\n')

const queries = [
  'What TypeScript settings does the user prefer?',
  'What database are we using?',
  'How does the user like to develop code?',
  'What should I do before committing?',
  'Where do we deploy?',
]

for (const q of queries) {
  const result = await memory.recall(q)
  console.log(`Q: "${q}"`)
  console.log(`   Memories: ${result.memories.length}`)
  if (result.memories.length > 0) {
    const top = result.memories[0]
    console.log(`   Top: [${top.type}] (${top.relevance.toFixed(3)}) ${top.content.slice(0, 80)}`)
  }
  console.log()
}

// --- Stats ---
console.log('=== Stats ===\n')
const stats = await memory.stats()
console.log(`  Episodes:    ${stats.episodes}`)
console.log(`  Digests:     ${stats.digests}`)
console.log(`  Semantic:    ${stats.semantic}`)
console.log(`  Procedural:  ${stats.procedural}`)

await memory.dispose()
console.log('\nDone. Database saved to ./engram-demo.db')
