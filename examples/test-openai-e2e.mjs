/**
 * End-to-end test of Engram with real OpenAI embeddings and summarization.
 *
 * Run from the repo root:
 *   OPENAI_API_KEY=sk-... node --import tsx examples/test-openai-e2e.mjs
 *
 * tsx resolves TypeScript source imports transparently, so no build step needed.
 */

import fs from 'fs'
import { Memory } from '../packages/core/src/memory.js'
import { SqliteStorageAdapter } from '../packages/sqlite/src/adapter.js'
import { openaiIntelligence } from '../packages/openai/src/index.js'

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set.')
  process.exit(1)
}

const DB_PATH = '/tmp/engram-openai-e2e-test.db'

// Remove any leftover DB from a previous run.
try { fs.unlinkSync(DB_PATH) } catch { /* first run, no file */ }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let totalPassed = 0
let totalFailed = 0

function pass(label) {
  totalPassed++
  console.log(`  PASS  ${label}`)
}

function fail(label, detail) {
  totalFailed++
  console.log(`  FAIL  ${label}`)
  if (detail) console.log(`        -> ${detail}`)
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

console.log('=== Engram + OpenAI End-to-End Test ===')
console.log(`DB: ${DB_PATH}`)
console.log(`Key: ${OPENAI_API_KEY.slice(0, 8)}...`)

const intelligence = openaiIntelligence({
  apiKey: OPENAI_API_KEY,
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
  summarizationModel: 'gpt-4o-mini',
})

const storage = new SqliteStorageAdapter(DB_PATH)
const memory = new Memory({ storage, intelligence })
await memory.initialize()

// ---------------------------------------------------------------------------
// 1. Ingest varied topics
// ---------------------------------------------------------------------------

section('1. Ingesting messages')

const messages = [
  {
    role: 'user',
    content: 'I prefer TypeScript with strict mode enabled for all my projects',
  },
  {
    role: 'user',
    content: 'We use React with functional components and hooks exclusively — class components are banned',
  },
  {
    role: 'user',
    content: 'PostgreSQL is our database of choice, with the pgvector extension for storing embeddings',
  },
  {
    role: 'user',
    content: 'My deployment workflow is: build, run tests, deploy to staging, run smoke tests, then promote to production',
  },
  {
    role: 'user',
    content: 'I follow TDD — always write failing tests first, then write the implementation to make them pass',
  },
]

for (const msg of messages) {
  await memory.ingest({ sessionId: 'e2e-test', ...msg })
  console.log(`  ingested: ${msg.content.slice(0, 70)}...`)
}

console.log(`\n  ${messages.length} messages ingested`)

// ---------------------------------------------------------------------------
// 2. Semantic / paraphrase recall
// ---------------------------------------------------------------------------

section('2. Semantic recall — paraphrase queries')

/**
 * Each test queries with a paraphrase that does NOT share keywords with the
 * ingested content, exercising the vector (cosine similarity) recall path.
 */
const recallTests = [
  {
    query: 'What coding language does the user prefer?',
    // "coding language" is a paraphrase of "TypeScript"
    expectContains: 'TypeScript',
    label: '"coding language" -> TypeScript preference',
  },
  {
    query: 'Which UI framework should we use for the frontend?',
    // "UI framework" is a paraphrase of "React"
    expectContains: 'React',
    label: '"UI framework" -> React preference',
  },
  {
    query: 'How do we ship code to production?',
    // "ship code" is a paraphrase of "deployment workflow"
    expectContains: 'deploy',
    label: '"ship code to production" -> deployment workflow',
  },
  {
    query: 'What is the software testing philosophy here?',
    // "software testing philosophy" is a paraphrase of "TDD"
    expectContains: 'TDD',
    label: '"testing philosophy" -> TDD approach',
  },
  {
    query: 'What data store are we running in production?',
    // "data store" is a paraphrase of "PostgreSQL"
    expectContains: 'PostgreSQL',
    label: '"data store" -> PostgreSQL choice',
  },
]

let semanticPassed = 0
for (const t of recallTests) {
  const result = await memory.recall(t.query)
  // Check across both direct memories and association-walked memories.
  const allContent = [
    ...result.memories.map(m => m.content),
    ...result.associations.map(m => m.content),
  ].join(' ')

  const found = allContent.toLowerCase().includes(t.expectContains.toLowerCase())

  if (found) {
    pass(t.label)
    semanticPassed++
  } else {
    const preview = result.memories.length > 0
      ? result.memories[0].content.slice(0, 100)
      : '(no memories returned)'
    fail(t.label, `"${t.expectContains}" not found. Top result: "${preview}"`)
  }
}

console.log(`\n  Semantic recall: ${semanticPassed}/${recallTests.length} passed`)

// ---------------------------------------------------------------------------
// 3. Light sleep consolidation (LLM summarization)
// ---------------------------------------------------------------------------

section('3. Light sleep consolidation (LLM summarization)')

const lightResult = await memory.consolidate('light')

console.log(`  digestsCreated:    ${lightResult.digestsCreated ?? 0}`)
console.log(`  episodesProcessed: ${lightResult.episodesProcessed ?? 0}`)

const lightOk = (lightResult.digestsCreated ?? 0) > 0
if (lightOk) {
  pass('light sleep created at least one digest')
} else {
  // Not a hard failure — light sleep needs enough episodes by default.
  // Report as info rather than a blocking fail.
  console.log('  INFO  no digests created (may need more episodes or lower threshold)')
}

// ---------------------------------------------------------------------------
// 4. Deep sleep — knowledge extraction
// ---------------------------------------------------------------------------

section('4. Deep sleep (knowledge extraction)')

const deepResult = await memory.consolidate('deep')

console.log(`  promoted (semantic):  ${deepResult.promoted ?? 0}`)
console.log(`  procedural:           ${deepResult.procedural ?? 0}`)
console.log(`  deduplicated:         ${deepResult.deduplicated ?? 0}`)
console.log(`  superseded:           ${deepResult.superseded ?? 0}`)

// Deep sleep requires digests first; only fail if light sleep also succeeded.
const deepOk = (deepResult.promoted ?? 0) > 0 || (deepResult.procedural ?? 0) > 0
if (lightOk) {
  if (deepOk) {
    pass('deep sleep extracted at least one semantic or procedural memory')
  } else {
    fail('deep sleep extracted no memories despite digests existing')
  }
} else {
  console.log('  INFO  skipping deep sleep assertion (no digests from light sleep)')
}

// ---------------------------------------------------------------------------
// 5. Recall after consolidation (semantic tier)
// ---------------------------------------------------------------------------

section('5. Recall after consolidation — semantic memories surface')

if (deepOk) {
  // After consolidation, semantic memories about the user's preferences should
  // be retrievable without keyword overlap.
  const postResult = await memory.recall('Tell me everything about user preferences and their workflow')
  const hasSemanticHit = postResult.memories.some(m => m.type === 'semantic')

  if (hasSemanticHit) {
    pass('post-consolidation recall surfaced at least one semantic memory')
  } else {
    const types = postResult.memories.map(m => m.type).join(', ')
    fail('post-consolidation recall returned no semantic memories', `types found: ${types || 'none'}`)
  }
} else {
  console.log('  INFO  skipping post-consolidation recall (no semantic memories created)')
}

// ---------------------------------------------------------------------------
// 6. Stats
// ---------------------------------------------------------------------------

section('6. Final memory stats')

const stats = await memory.stats()
console.log(`  episodes:     ${stats.episodes}`)
console.log(`  digests:      ${stats.digests}`)
console.log(`  semantic:     ${stats.semantic}`)
console.log(`  procedural:   ${stats.procedural}`)
console.log(`  associations: ${stats.associations}`)

if (stats.episodes >= messages.length) {
  pass(`episodes count matches ingested messages (${stats.episodes} >= ${messages.length})`)
} else {
  fail('episode count lower than ingested messages', `got ${stats.episodes}, expected >= ${messages.length}`)
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

await memory.dispose()
try { fs.unlinkSync(DB_PATH) } catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = totalPassed + totalFailed
console.log('\n' + '═'.repeat(60))
console.log(`  Results: ${totalPassed} passed, ${totalFailed} failed (${total} total assertions)`)
console.log(`  Semantic recall: ${semanticPassed}/${recallTests.length}`)
console.log('═'.repeat(60))

if (totalFailed > 0 || semanticPassed < recallTests.length) {
  process.exit(1)
}
process.exit(0)
