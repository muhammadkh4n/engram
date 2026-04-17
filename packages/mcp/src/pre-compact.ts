#!/usr/bin/env node
/**
 * PreCompact Hook — Extract & persist important context before compaction
 *
 * Fires before Claude Code compresses the conversation. Reads the transcript,
 * extracts key decisions/facts via gpt-4o-mini, ingests into Engram, and
 * returns additionalContext so Claude retains awareness post-compaction.
 *
 * stdin: { session_id, transcript_path, cwd, hook_event_name, trigger }
 * stdout: { additionalContext: "..." } (injected into post-compaction context)
 */

import { readFileSync } from 'node:fs'
import { createMemory } from '@engram-mem/core'
import { tryCreateGraph } from './graph-helper.js'
import { SupabaseStorageAdapter } from '@engram-mem/supabase'
import { openaiIntelligence } from '@engram-mem/openai'
import { findDuplicate, boostDuplicate } from './ingest/dedup.js'
import OpenAI from 'openai'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env['SUPABASE_URL']
const SUPABASE_KEY = process.env['SUPABASE_KEY']
const OPENAI_API_KEY = process.env['OPENAI_API_KEY']

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  process.stderr.write('[engram-compact] Missing env vars, skipping.\n')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Read hook input
// ---------------------------------------------------------------------------

interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  trigger?: string
}

function readHookInput(): HookInput {
  try {
    const stdin = readFileSync(0, 'utf-8').trim()
    return stdin ? JSON.parse(stdin) : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Extract conversation from transcript
// ---------------------------------------------------------------------------

function extractConversation(transcriptPath: string): string {
  const raw = readFileSync(transcriptPath, 'utf-8')
  const lines = raw.split('\n').filter(Boolean)
  const turns: string[] = []
  let totalChars = 0
  const MAX_CHARS = 40000

  // Read recent turns (end of file = most recent)
  for (let i = lines.length - 1; i >= 0 && totalChars < MAX_CHARS; i--) {
    try {
      const entry = JSON.parse(lines[i])
      if (entry.type === 'human' || entry.type === 'assistant') {
        const role = entry.type === 'human' ? 'User' : 'Assistant'
        let text = ''
        if (typeof entry.message?.content === 'string') {
          text = entry.message.content
        } else if (Array.isArray(entry.message?.content)) {
          text = entry.message.content
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join('\n')
        }
        if (text.trim().length > 10) {
          turns.unshift(`${role}: ${text.slice(0, 3000)}`)
          totalChars += Math.min(text.length, 3000)
        }
      }
    } catch { /* skip */ }
  }

  return turns.join('\n\n')
}

// ---------------------------------------------------------------------------
// Extract key facts via LLM
// ---------------------------------------------------------------------------

async function extractKeyFacts(conversation: string): Promise<{
  summary: string
  keyFacts: string
}> {
  const client = new OpenAI({ apiKey: OPENAI_API_KEY })

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You analyze Claude Code conversations before context compaction.

Extract TWO outputs:

1. MEMORY (for long-term storage):
Bullet points of ONLY high-value items:
- Architectural decisions with rationale
- User preferences / requirements stated
- Non-obvious solutions found
- Important facts learned (credentials, endpoints, configs discovered)
- Bugs found and their root causes
- Action items / next steps agreed on
Skip: routine operations, file reads, test runs, greps, build commands.
Max 200 words.

2. CONTEXT (for immediate re-injection after compaction):
A brief paragraph (max 100 words) summarizing what the user is currently working on and what was just decided, so Claude can resume seamlessly.

Format your response EXACTLY as:
MEMORY:
<bullet points>

CONTEXT:
<paragraph>`,
      },
      {
        role: 'user',
        content: conversation,
      },
    ],
    max_tokens: 600,
    temperature: 0.2,
  })

  const output = response.choices[0]?.message?.content ?? ''

  const memoryMatch = output.match(/MEMORY:\s*([\s\S]*?)(?=CONTEXT:|$)/)
  const contextMatch = output.match(/CONTEXT:\s*([\s\S]*)$/)

  return {
    summary: memoryMatch?.[1]?.trim() ?? output,
    keyFacts: contextMatch?.[1]?.trim() ?? '',
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const hookInput = readHookInput()

  if (!hookInput.transcript_path) {
    process.stderr.write('[engram-compact] No transcript_path in hook input.\n')
    return
  }

  let conversation: string
  try {
    conversation = extractConversation(hookInput.transcript_path)
  } catch (err) {
    process.stderr.write(`[engram-compact] Failed to read transcript: ${err}\n`)
    return
  }

  if (conversation.length < 200) {
    process.stderr.write('[engram-compact] Conversation too short, skipping.\n')
    return
  }

  const { summary, keyFacts } = await extractKeyFacts(conversation)

  // Ingest the summary into Engram long-term memory
  const storage = new SupabaseStorageAdapter({ url: SUPABASE_URL!, key: SUPABASE_KEY! })
  const intelligence = openaiIntelligence({ apiKey: OPENAI_API_KEY! })
  const graph = await tryCreateGraph('[engram-compact]')
  const memory = createMemory({
    storage,
    intelligence,
    ...(graph ? { graph } : {}),
  })
  await memory.initialize()

  // Dedup: session summaries re-state long-running facts across days.
  // If this summary substantially overlaps a recent one, boost the
  // existing memory instead of inserting a near-duplicate.
  //
  // Threshold tuning: empirically on text-embedding-3-small, cosine
  // similarity between two day-over-day session summaries paraphrasing
  // the same work sits around 0.65; cosine between unrelated long
  // summaries sits around 0.40. We pick 0.62 — below that, paraphrased
  // summaries are reliably caught; above 0.70, near-duplicates slip
  // through because long-text cosine simply doesn't reach higher values.
  // See /tmp/dedup-tune.mjs sweep (2026-04-17).
  //
  // Window is wider than the 7-day dedup default because session
  // summaries echo facts that persist for weeks.
  const dup = await findDuplicate(summary, storage, intelligence, {
    threshold: 0.62,
    windowDays: 30,
  })

  if (dup.duplicateId) {
    await boostDuplicate(storage, dup.duplicateId)
    process.stderr.write(
      `[engram-compact] Duplicate of ${dup.duplicateId} (sim=${dup.similarity.toFixed(3)}) — boosted, not re-ingested.\n`,
    )
  } else {
    await memory.ingest({
      content: summary,
      role: 'system',
      sessionId: hookInput.session_id ?? 'claude-code',
      metadata: {
        source: 'claude-code',
        type: 'pre-compact-summary',
        trigger: hookInput.trigger,
        cwd: hookInput.cwd,
        extractedAt: new Date().toISOString(),
      },
    })
    process.stderr.write(`[engram-compact] Persisted ${summary.length} chars to long-term memory.\n`)
  }

  // Return additionalContext to inject after compaction
  if (keyFacts) {
    const output = JSON.stringify({
      additionalContext: `[Engram Memory — preserved before compaction]\n${keyFacts}`,
    })
    process.stdout.write(output)
  }
}

main().catch((err) => {
  process.stderr.write(`[engram-compact] Error: ${err instanceof Error ? err.message : String(err)}\n`)
})
