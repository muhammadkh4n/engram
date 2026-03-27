# @engram/openclaw

Engram plug-and-play plugin for OpenClaw. Adds cognitive memory with 5 memory systems, intent-driven recall, and consolidation cycles.

## Installation

### One-Command Install

From the packages/openclaw directory:

```bash
bash install.sh
```

This script will:
1. Create ~/.openclaw/engram directory
2. Write package.json and plugin manifest
3. Install dependencies
4. Update openclaw.json to load the plugin
5. Auto-configure the context engine slot

Then restart OpenClaw:

```bash
openclaw gateway restart
```

Verify installation:

```bash
openclaw plugins inspect engram
```

### Manual Installation

If the script doesn't work for your setup:

```bash
# 1. Create plugin directory
mkdir -p ~/.openclaw/engram/dist

# 2. Build the plugin from source
cd packages/openclaw && npx tsup

# 3. Copy built plugin
cp dist/openclaw-plugin.js ~/.openclaw/engram/dist/

# 4. Install dependencies
cd ~/.openclaw/engram
npm init -y
npm install @engram/core @engram/sqlite @engram/openai

# 5. Update openclaw.json manually
# Add to plugins.load.paths:
# - ~/.openclaw/engram
# Set plugins.slots.contextEngine: "engram"
# Set plugins.entries.engram:
#   enabled: true
#   config:
#     storagePath: ~/.openclaw/engram/engram.db
```

## Configuration

### Basic (No Embeddings)

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "engram"
    },
    "entries": {
      "engram": {
        "enabled": true,
        "config": {
          "storagePath": "~/.openclaw/engram/engram.db"
        }
      }
    }
  }
}
```

### With Embeddings

```json
{
  "plugins": {
    "entries": {
      "engram": {
        "enabled": true,
        "config": {
          "storagePath": "~/.openclaw/engram/engram.db",
          "intelligence": {
            "type": "openai",
            "apiKey": "${OPENAI_API_KEY}"
          }
        }
      }
    }
  }
}
```

Or use environment variable:

```bash
export OPENAI_API_KEY=sk-...
```

## Features

### Automatic Message Ingestion

The plugin hooks into OpenClaw's `afterTurn` event. Every conversation turn is automatically saved to Engram without any agent code changes.

```
User: "I prefer TypeScript"
Assistant: "Got it, TypeScript noted."
[Engram auto-saves both messages]

User: "What are my preferences?"
[Engram recalls: "TypeScript"]
[Context injected into system prompt]
```

### Agent Tools

The plugin registers 4 tools for agent use:

#### engram_search
Deep search across all memory systems.

```typescript
{
  name: 'engram_search',
  parameters: { query: string }
}
```

Example:
```
Agent: "engram_search({ query: 'deployment preferences' })"
Result: "User prefers AWS ECS with Fargate..."
```

#### engram_stats
Get memory statistics.

```typescript
{
  name: 'engram_stats',
  parameters: {}
}
```

Returns:
```json
{
  "episodes": 152,
  "digests": 8,
  "semantic": 12,
  "procedural": 4,
  "associations": 23
}
```

#### engram_forget
Deprioritize memories (lossless).

```typescript
{
  name: 'engram_forget',
  parameters: { query: string, confirm?: boolean }
}
```

Example:
```
Agent: "engram_forget({ query: 'legacy API', confirm: true })"
Result: "Deprioritized 3 memories"
```

#### engram_consolidate
Run consolidation cycles manually.

```typescript
{
  name: 'engram_consolidate',
  parameters: { cycle?: 'light' | 'deep' | 'dream' | 'decay' | 'all' }
}
```

Example:
```
Agent: "engram_consolidate({ cycle: 'deep' })"
Result: "Promoted 2 semantic memories, created 1 procedural memory"
```

## How It Works

### Ingestion Pipeline

1. **afterTurn Hook** — OpenClaw calls this after every assistant response
2. **Extract Content** — Handle text, tool calls, tool results
3. **Truncate** — Cap at 10,000 chars to avoid bloat
4. **Ingest** — Save to Engram with auto-detected salience
5. **Auto-Consolidate** — Every 100 episodes, run light sleep

All automatic. Agent code doesn't need to know about memory.

### Context Injection

1. **Extract Query** — Get last user message from conversation
2. **Recall** — Search all memory systems with intent analysis
3. **Format** — Return ranked memories ready for system prompt
4. **Inject** — OpenClaw adds `systemPromptAddition` to prompt

Agent never sees the memory machinery. Context just appears in its system prompt.

### Session File Import

On bootstrap, the plugin checks for a session file and imports historical messages. This prevents amnesia on restart:

```javascript
// ~/.openclaw/openclaw.json
{
  "sessionFile": "~/.openclaw/sessions/conversation.jsonl"
}
```

The plugin will:
1. Check if file exists
2. Check if already imported (via marker file)
3. Parse as JSONL or JSON array
4. Ingest up to 500 recent messages
5. Create marker file to prevent re-import

## Important: afterTurn Contract

**CRITICAL for understanding the plugin behavior**:

When `afterTurn` exists on the context engine:
- OpenClaw **does NOT** call `ingest()` or `ingestBatch()`
- OpenClaw **ONLY** calls `afterTurn()`
- You **MUST** handle all message persistence in `afterTurn()`

The plugin extracts only new messages from this turn:

```typescript
async afterTurn({ messages, prePromptMessageCount }) {
  // messages = full session history
  // messages[0:prePromptMessageCount] = history from before this turn
  // messages[prePromptMessageCount:] = new messages this turn

  const newMessages = messages.slice(prePromptMessageCount)
  // Ingest only the new ones
}
```

This prevents re-ingesting old messages on every turn.

### Content Extraction

The plugin handles multiple content types:

- **text** — Extracted as-is
- **tool_use** — Summarized as "[Tool call: name]"
- **tool_result** — Extract text content
- **image** — Skipped (not useful for text search)
- **thinking** — Skipped (internal to model)

Multipart content from Claude's new API is automatically flattened into searchable text.

## Auto-Consolidation

Consolidation runs automatically every 100 episodes:

```
Episode 100 → light sleep (create digests)
Episode 200 → light sleep (more digests)
Episode 300 → light sleep (more digests)
...
```

This keeps memory fresh without manual intervention. You can also call `engram_consolidate` explicitly for deeper cycles.

## Troubleshooting

**Q: Plugin not loading**

A: Check `openclaw plugins list`. Verify openclaw.json has correct path. Check ~/.openclaw/engram/dist/openclaw-plugin.js exists.

**Q: afterTurn errors**

A: Check OpenClaw logs. Common issues:
- Database locked (concurrent writes)
- Out of disk space
- Corrupted database file

**Q: Context not being injected**

A: Check that:
1. Plugin status shows "enabled"
2. Context engine slot is set to "engram"
3. Memories exist (run `engram_stats` to verify)
4. Query is matching (test with `engram_search`)

**Q: High CPU usage during consolidation**

A: Expected. Consolidation is CPU-intensive. If it's causing issues, reduce frequency or move to a lower tier (light instead of all).

**Q: Database file is huge**

A: Engram is lossless (never deletes). Files grow with message count. Typical: 5-10 MB per 10K messages. This is normal.

**Q: Can I run consolidation in the background?**

A: Currently, consolidation runs synchronously in `afterTurn`. For background jobs, you could:
1. Run a separate Node.js service with the same database
2. Call `consolidate()` on a schedule
3. This will work safely (concurrent reads, serialized writes)

**Q: How do I disable the plugin?**

A: Set `enabled: false` in openclaw.json, or remove the plugin directory entirely.

## Advanced: Custom Storage Path

Store memories in a specific location:

```json
{
  "engram": {
    "enabled": true,
    "config": {
      "storagePath": "/mnt/memory/agent-memory.db"
    }
  }
}
```

Useful for agents with specific storage requirements.

## Advanced: Cloud Storage

To use Supabase instead of SQLite:

1. Create a Supabase project
2. Run migrations (see @engram/supabase README)
3. Modify plugin to use supabaseAdapter:

Edit the plugin source (advanced):

```typescript
// packages/openclaw/src/openclaw-plugin.ts
import { supabaseAdapter } from '@engram/supabase'

// In register():
const storage = supabaseAdapter({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_KEY
})
```

Then rebuild:

```bash
cd packages/openclaw && npx tsup
cp dist/openclaw-plugin.js ~/.openclaw/engram/dist/
```

## Consolidation Strategies

Different use cases call for different schedules:

| Scenario | Strategy |
|----------|----------|
| Research agent | Auto (every 100) — Consolidate frequently |
| Customer support | Manual `engram_consolidate` hourly — Full control |
| Long-running daemon | Auto-light sleep, manual deep sleep — Balance |

You control the schedule. Auto-consolidation only runs light sleep (episodes → digests). For deeper consolidation (→ semantic/procedural), call `engram_consolidate` manually.

## Contributing

The plugin code lives in `packages/openclaw/src/openclaw-plugin.ts`.

To modify:
1. Edit source
2. Build: `cd packages/openclaw && npx tsup`
3. Copy: `cp dist/openclaw-plugin.js ~/.openclaw/engram/dist/`
4. Restart OpenClaw: `openclaw gateway restart`

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

## License

MIT
