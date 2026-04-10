#!/usr/bin/env node
/**
 * Session Summary Ingestion Script
 *
 * Called by Claude Code's SessionEnd hook. Reads the session transcript,
 * summarizes key decisions/outcomes via OpenAI, and ingests into Engram.
 *
 * Receives hook data on stdin as JSON:
 *   { session_id, transcript_path, ... }
 *
 * Falls back to finding the latest transcript if no path is provided.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createMemory } from '@engram-mem/core'
import { tryCreateGraph } from './graph-helper.js'
import { SupabaseStorageAdapter } from '@engram-mem/supabase'
import { openaiIntelligence } from '@engram-mem/openai'
import OpenAI from 'openai'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env['SUPABASE_URL']
const SUPABASE_KEY = process.env['SUPABASE_KEY']
const OPENAI_API_KEY = process.env['OPENAI_API_KEY']

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  process.stderr.write('[engram-summary] Missing env vars, skipping.\n')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Find transcript
// ---------------------------------------------------------------------------

function findLatestTranscript(): string | null {
  const projectsDir = join(homedir(), '.claude', 'projects')
  try {
    const dirs = readdirSync(projectsDir)
    let latest: { path: string; mtime: number } | null = null

    for (const dir of dirs) {
      const fullDir = join(projectsDir, dir)
      try {
        const files = readdirSync(fullDir).filter(f => f.endsWith('.jsonl'))
        for (const file of files) {
          const fp = join(fullDir, file)
          const st = statSync(fp)
          if (!latest || st.mtimeMs > latest.mtime) {
            latest = { path: fp, mtime: st.mtimeMs }
          }
        }
      } catch { /* skip */ }
    }

    return latest?.path ?? null
  } catch {
    return null
  }
}

function extractConversation(transcriptPath: string): string {
  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean)
  const turns: string[] = []
  let totalChars = 0
  const MAX_CHARS = 30000 // cap input to summarizer

  // Read from end (most recent turns most relevant)
  for (let i = lines.length - 1; i >= 0 && totalChars < MAX_CHARS; i--) {
    try {
      const entry = JSON.parse(lines[i])
      if (entry.type === 'human' || entry.type === 'assistant') {
        const role = entry.type === 'human' ? 'User' : 'Assistant'
        // Extract text content only
        let text = ''
        if (typeof entry.message?.content === 'string') {
          text = entry.message.content
        } else if (Array.isArray(entry.message?.content)) {
          text = entry.message.content
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join('\n')
        }
        if (text.trim().length > 5) {
          turns.unshift(`${role}: ${text.slice(0, 2000)}`)
          totalChars += text.length
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return turns.join('\n\n')
}

// ---------------------------------------------------------------------------
// Summarize
// ---------------------------------------------------------------------------

async function summarize(conversation: string): Promise<string | null> {
  const client = new OpenAI({ apiKey: OPENAI_API_KEY })

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You summarize Claude Code work sessions. Extract ONLY:
- Key decisions made
- Problems solved (with solutions)
- Architectural choices
- User preferences expressed
- Important facts learned
- Action items / next steps

Skip: file reads, grep output, test runs, routine tool use, small talk.
Output a concise bullet-point summary (max 300 words). Start with a one-line session title.`,
      },
      {
        role: 'user',
        content: conversation,
      },
    ],
    max_tokens: 500,
    temperature: 0.3,
  })

  return response.choices[0]?.message?.content ?? null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Try to read hook data from stdin (non-blocking)
  let hookData: Record<string, unknown> = {}
  try {
    const stdin = readFileSync(0, 'utf-8').trim()
    if (stdin) hookData = JSON.parse(stdin)
  } catch { /* no stdin or invalid JSON */ }

  const transcriptPath = (hookData['transcript_path'] as string) ?? findLatestTranscript()
  if (!transcriptPath) {
    process.stderr.write('[engram-summary] No transcript found, skipping.\n')
    return
  }

  const conversation = extractConversation(transcriptPath)
  if (conversation.length < 100) {
    process.stderr.write('[engram-summary] Session too short to summarize.\n')
    return
  }

  const summary = await summarize(conversation)
  if (!summary) {
    process.stderr.write('[engram-summary] Summarization returned empty.\n')
    return
  }

  // Ingest into Engram
  const storage = new SupabaseStorageAdapter({ url: SUPABASE_URL!, key: SUPABASE_KEY! })
  const intelligence = openaiIntelligence({ apiKey: OPENAI_API_KEY! })
  const graph = await tryCreateGraph('[engram-summary]')
  const memory = createMemory({
    storage,
    intelligence,
    ...(graph ? { graph } : {}),
  })
  await memory.initialize()

  await memory.ingest({
    content: summary,
    role: 'system',
    sessionId: 'claude-code-summaries',
    metadata: {
      source: 'claude-code',
      type: 'session-summary',
      transcriptPath,
      summarizedAt: new Date().toISOString(),
    },
  })

  process.stderr.write(`[engram-summary] Session summary ingested (${summary.length} chars).\n`)
}

main().catch((err) => {
  process.stderr.write(`[engram-summary] Error: ${err instanceof Error ? err.message : String(err)}\n`)
})
