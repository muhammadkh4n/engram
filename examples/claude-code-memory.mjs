/**
 * Engram × Claude Code — persistent memory across sessions.
 *
 * The killer use case: your coding agent remembers your preferences,
 * architecture decisions, and patterns across different sessions.
 *
 * This example simulates what happens when Claude Code has Engram wired in:
 *   Session 1: User states preferences and decisions
 *   Session 2: Fresh agent — no context, but memory recalls everything
 *
 * Prerequisites:
 *   npm install @engram-mem/core @engram-mem/sqlite
 *
 * Run:
 *   node claude-code-memory.mjs
 */

import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'

const PROJECT_DB = './engram-coding.db'

// ============================================================================
// SESSION 1: User onboards a coding agent with preferences and decisions
// ============================================================================

{
  console.log('━━━ SESSION 1: Monday morning ━━━\n')

  const memory = createMemory({ storage: sqliteAdapter({ path: PROJECT_DB }) })
  await memory.initialize()

  const session1 = [
    { role: 'user', content: 'Stack: TypeScript strict, Next.js 15 App Router, Postgres via Drizzle ORM, Tailwind v4.' },
    { role: 'user', content: 'Error handling: Result types, never throw. I hate silent catches.' },
    { role: 'user', content: 'Auth is Supabase Auth with RLS. Session handled via middleware.ts.' },
    { role: 'user', content: 'Decided: pgvector for embeddings, not Pinecone. Keep it in Postgres.' },
    { role: 'user', content: 'Testing: Vitest + Playwright. No Jest. Colocated test files.' },
    { role: 'assistant', content: 'Noted the stack, error handling preference, auth setup, pgvector decision, and testing approach.' },
  ]

  for (const msg of session1) {
    await memory.ingest({ sessionId: 'monday-kickoff', ...msg })
  }

  // Consolidate so preferences become queryable semantic memories
  await memory.consolidate('light')
  await memory.consolidate('deep')

  console.log(`Ingested ${session1.length} messages. Preferences consolidated.`)
  await memory.dispose()
}

// ============================================================================
// SESSION 2: A week later — fresh agent, no conversation context
// ============================================================================

{
  console.log('\n━━━ SESSION 2 (a week later): "Scaffold a new user endpoint" ━━━\n')

  const memory = createMemory({ storage: sqliteAdapter({ path: PROJECT_DB }) })
  await memory.initialize()

  const queries = [
    'What stack am I using for this project?',
    'How do I handle errors?',
    'How is authentication done?',
    'What do we use for vector storage?',
    'What test framework?',
  ]

  for (const q of queries) {
    const result = await memory.recall(q)
    console.log(`Q: ${q}`)
    if (result.memories.length > 0) {
      const top = result.memories[0]
      console.log(`   → ${top.content}`)
    } else {
      console.log('   → (nothing recalled)')
    }
    console.log()
  }

  await memory.dispose()
}

console.log('━━━ The agent remembers. No CLAUDE.md needed. ━━━')
console.log(`\nDatabase: ${PROJECT_DB}`)
