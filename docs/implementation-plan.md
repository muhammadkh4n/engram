# OpenClaw Memory Plugin — LCM Parity Implementation Plan

**Status**: Planning  
**Target**: Match lossless-claw (Martian Engineering) core guarantees  
**Timeline**: 3-4 weeks  
**Current Location**: VPS (RexUbuntuDO)  
**Implementation Location**: MacBook (local development)

---

## Overview

Transform openclaw-memory from a 3-tier knowledge extraction system into a **lossless, hierarchical context management engine** that combines:
- LCM's **lossless retrievability** + **hierarchical DAG** + **expansion tools**
- Our existing **knowledge extraction** + **automation** + **deduplication**

---

## Phase 1: Lossless Retrievability (Critical)

**Goal**: Never delete episode data; always preserve originals  
**Effort**: Low (1-2 days)  
**Impact**: Critical (foundation for all other features)

### Changes

#### 1.1 Database Schema
```sql
-- Add preservation flag to episodes
ALTER TABLE memory_episodes
ADD COLUMN preserved BOOLEAN DEFAULT TRUE;

-- Add backlinks to digests
ALTER TABLE memory_digests
ADD COLUMN source_episode_ids TEXT[]; -- Array of episode IDs

-- Add created_from to track provenance
ALTER TABLE memory_digests
ADD COLUMN created_from JSONB; -- {episode_ids: [], digest_ids: []}
```

#### 1.2 Digestion Logic
**File**: `src/cron/daily-summarizer.ts`

**Current Behavior**:
```typescript
// Episodes are deleted after digestion (implicit)
const unsummarized = await this.getUnsummarizedEpisodes();
```

**New Behavior**:
```typescript
// Mark episodes as summarized but keep them
await this.episodeStore.markAsSummarized(episodeIds);

// Store backlinks in digest
const digest = await this.digestStore.insert({
  summary,
  key_topics,
  source_episode_ids: episodeIds, // NEW
  created_from: { episode_ids: episodeIds, digest_ids: [] }, // NEW
});
```

#### 1.3 Episode Store Updates
**File**: `src/tiers/episodes.ts`

**Add Methods**:
```typescript
async markAsSummarized(ids: string[]): Promise<void> {
  await this.supabase
    .from('memory_episodes')
    .update({ summarized_at: new Date().toISOString() })
    .in('id', ids);
}

async getByIds(ids: string[]): Promise<Episode[]> {
  const { data } = await this.supabase
    .from('memory_episodes')
    .select('*')
    .in('id', ids);
  return data || [];
}
```

#### 1.4 Config Update
**File**: `openclaw.json` (plugin config)

```json
{
  "plugins": {
    "entries": {
      "openclaw-memory": {
        "config": {
          "preserveEpisodes": true, // NEW
          "episodeRetentionDays": -1 // -1 = forever
        }
      }
    }
  }
}
```

### Testing
- [ ] Verify episodes are not deleted after digestion
- [ ] Verify `source_episode_ids` populates correctly
- [ ] Query episodes by ID to confirm retrieval works

---

## Phase 2: Expansion Tool (High Priority)

**Goal**: Agents can drill back to original episodes from digests  
**Effort**: Medium (2-3 days)  
**Impact**: High (core LCM feature)

### Changes

#### 2.1 New Tool: `memory_expand`
**File**: `src/tools/memory-expand-tool.ts`

```typescript
import { Type } from '@sinclair/typebox';
import type { ToolRegistration } from '../types.js';

export function createMemoryExpandTool(
  episodeStore: EpisodeStore,
  config: { maxTokens: number }
): ToolRegistration {
  return {
    name: 'memory_expand',
    label: 'Expand Memory Episodes',
    description: 'Retrieve original episode text from episode IDs (sub-agent only)',
    parameters: Type.Object({
      episode_ids: Type.Array(Type.String(), {
        description: 'List of episode IDs to expand',
        minItems: 1,
        maxItems: 50, // Prevent abuse
      }),
    }),
    async execute(_toolCallId: string, params: { episode_ids: string[] }) {
      // Token budget check
      const episodes = await episodeStore.getByIds(params.episode_ids);
      
      const totalTokens = episodes.reduce((sum, ep) => 
        sum + estimateTokens(ep.content), 0
      );

      if (totalTokens > config.maxTokens) {
        return {
          content: [{
            type: 'text',
            text: `Error: Expansion would exceed token limit (${totalTokens} > ${config.maxTokens}). Request fewer episodes.`,
          }],
          details: { status: 'error', reason: 'token_limit_exceeded' },
        };
      }

      // Format output
      const output = episodes.map((ep, i) => 
        `### Episode ${i + 1} (ID: ${ep.id})\n` +
        `**Role**: ${ep.role}\n` +
        `**Created**: ${ep.created_at}\n` +
        `**Content**:\n${ep.content}\n`
      ).join('\n---\n\n');

      return {
        content: [{ type: 'text', text: output }],
        details: { status: 'ok', episodes_retrieved: episodes.length },
      };
    },
  };
}
```

#### 2.2 Register Tool (Sub-Agent Only)
**File**: `src/plugin-entry.ts`

```typescript
// Register expansion tool (restricted to sub-agents)
api.registerTool(createMemoryExpandTool(episodeStore, {
  maxTokens: config.maxExpandTokens || 4000,
}));
```

**Note**: OpenClaw's tool registration doesn't have built-in "sub-agent only" enforcement yet. Options:
1. Check caller session key (if `session_key` includes `subagent:`, allow)
2. Trust agent to self-regulate (document in tool description)
3. Add custom middleware (future)

#### 2.3 Update `memory_search` to Return Episode IDs
**File**: `src/tools/memory-search-tool.ts`

**Current Output**:
```typescript
output.push(`  - [${(e.similarity * 100).toFixed(0)}%] [${e.item.role}] ${e.item.content.slice(0, 150)}`);
```

**New Output**:
```typescript
output.push(
  `  - [${(e.similarity * 100).toFixed(0)}%] [${e.item.role}] (ID: ${e.item.id}) ` +
  e.item.content.slice(0, 150)
);
```

### Testing
- [ ] Call `memory_expand(episode_ids: ["abc123"])` and verify original text is returned
- [ ] Verify token limit enforcement (try 100 episodes, expect error)
- [ ] Verify `memory_search` now includes episode IDs in output

---

## Phase 3: Hierarchical Digests (Critical for Scaling)

**Goal**: Digest-of-digests to scale beyond 10K conversations  
**Effort**: High (4-5 days)  
**Impact**: Critical (prevents saturation at scale)

### Changes

#### 3.1 New Table: `memory_digest_groups`
**File**: `migrations/003_digest_groups.sql`

```sql
CREATE TABLE memory_digest_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_topics TEXT[] NOT NULL,
  source_digest_ids TEXT[] NOT NULL, -- IDs of child digests
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_digest_groups_session ON memory_digest_groups(session_id);
CREATE INDEX idx_digest_groups_embedding ON memory_digest_groups USING ivfflat (embedding vector_cosine_ops);
```

#### 3.2 Digest Grouping Logic
**File**: `src/cron/digest-grouper.ts`

```typescript
export class DigestGrouper {
  private supabase: SupabaseClient;
  private summarizer: Summarizer;
  private digestStore: DigestStore;
  private groupStore: DigestGroupStore; // NEW

  constructor(opts: DigestGrouperOptions) {
    this.supabase = opts.supabase;
    this.summarizer = opts.summarizer;
    this.digestStore = opts.digestStore;
    this.groupStore = opts.groupStore;
  }

  async run(): Promise<{ groupsCreated: number }> {
    // Group digests by session
    const digestCounts = await this.getDigestCountsBySession();
    
    let groupsCreated = 0;
    
    for (const [sessionId, count] of Object.entries(digestCounts)) {
      if (count < 100) continue; // Only group when >100 digests
      
      // Get ungrouped digests
      const ungrouped = await this.getUngroupedDigests(sessionId);
      
      if (ungrouped.length < 10) continue; // Need at least 10 to group
      
      // Group in batches of 20
      for (let i = 0; i < ungrouped.length; i += 20) {
        const batch = ungrouped.slice(i, i + 20);
        
        const groupSummary = await this.summarizer.summarizeDigests(batch);
        
        await this.groupStore.insert({
          session_id: sessionId,
          summary: groupSummary.text,
          key_topics: groupSummary.topics,
          source_digest_ids: batch.map(d => d.id),
        });
        
        groupsCreated++;
      }
    }
    
    return { groupsCreated };
  }
  
  private async getDigestCountsBySession(): Promise<Record<string, number>> {
    const { data } = await this.supabase
      .from('memory_digests')
      .select('session_id')
      .is('grouped_at', null);
    
    const counts: Record<string, number> = {};
    for (const row of data || []) {
      counts[row.session_id] = (counts[row.session_id] || 0) + 1;
    }
    return counts;
  }
  
  private async getUngroupedDigests(sessionId: string): Promise<Digest[]> {
    const { data } = await this.supabase
      .from('memory_digests')
      .select('*')
      .eq('session_id', sessionId)
      .is('grouped_at', null)
      .order('created_at', { ascending: true });
    
    return (data || []) as Digest[];
  }
}
```

#### 3.3 Cron Job
**File**: `scripts/weekly-digest-grouping-cron.mjs`

```javascript
#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { DigestGrouper } from '../dist/cron/digest-grouper.js';
import { Summarizer } from '../dist/tiers/summarizer.js';
// ... (similar structure to daily-digest-cron.mjs)

const grouper = new DigestGrouper({
  supabase,
  summarizer,
  digestStore,
  groupStore,
});

const result = await grouper.run();
console.log(`Digest groups created: ${result.groupsCreated}`);
```

**Crontab Entry**:
```cron
# Weekly digest grouping (Sundays at 2 AM PKT = 21:00 UTC Saturday)
0 21 * * 6 cd /root/.openclaw/openclaw-memory && /usr/bin/node scripts/weekly-digest-grouping-cron.mjs >> /tmp/openclaw-memory-grouping.log 2>&1
```

#### 3.4 Update Retrieval to Query Groups
**File**: `src/retrieval/tier-router.ts`

**Add**:
```typescript
if (tiers.includes('digest')) {
  // Query both digests AND digest groups
  const [digests, groups] = await Promise.all([
    digestStore.search({ query, limit }),
    groupStore.search({ query, limit }), // NEW
  ]);
  
  // Merge and re-rank
  return [...digests, ...groups].sort((a, b) => b.similarity - a.similarity);
}
```

### Testing
- [ ] Create 150 digests manually
- [ ] Run digest grouper, verify 7-8 groups created
- [ ] Query memory_search, verify groups appear in results
- [ ] Expand a group (via episode IDs), verify originals are retrievable

---

## Phase 4: Three-Level Escalation (Reliability)

**Goal**: Guarantee summarization convergence (prevent infinite loops)  
**Effort**: Medium (2-3 days)  
**Impact**: High (production reliability)

### Changes

#### 4.1 Escalation Logic
**File**: `src/tiers/summarizer.ts`

```typescript
export class Summarizer {
  async summarizeWithEscalation(
    content: string,
    targetTokens: number
  ): Promise<string> {
    const inputTokens = estimateTokens(content);
    
    // Level 1: Detail-preserving summarization
    const level1 = await this.summarize(content, {
      mode: 'preserve_details',
      targetTokens,
    });
    
    if (estimateTokens(level1) <= targetTokens) {
      return level1;
    }
    
    console.warn(`[Summarizer] Level 1 failed to reduce tokens, escalating to Level 2`);
    
    // Level 2: Aggressive bullet-point summarization
    const level2 = await this.summarize(content, {
      mode: 'bullet_points',
      targetTokens: Math.floor(targetTokens * 0.8), // 20% stricter
    });
    
    if (estimateTokens(level2) <= targetTokens) {
      return level2;
    }
    
    console.warn(`[Summarizer] Level 2 failed, escalating to Level 3 (deterministic truncation)`);
    
    // Level 3: Deterministic truncation (no LLM)
    return this.deterministicTruncate(content, targetTokens);
  }
  
  private deterministicTruncate(content: string, targetTokens: number): string {
    const tokens = content.split(/\s+/);
    const truncated = tokens.slice(0, targetTokens).join(' ');
    return `[TRUNCATED] ${truncated}... (${tokens.length - targetTokens} tokens omitted)`;
  }
  
  private async summarize(
    content: string,
    opts: { mode: 'preserve_details' | 'bullet_points'; targetTokens: number }
  ): Promise<string> {
    const prompt = opts.mode === 'bullet_points'
      ? `Summarize the following in concise bullet points (target: ${opts.targetTokens} tokens):\n\n${content}`
      : `Summarize the following, preserving key details (target: ${opts.targetTokens} tokens):\n\n${content}`;
    
    // Call LLM (OpenAI, Claude, etc.)
    const response = await this.llm.complete(prompt);
    return response.text;
  }
}
```

#### 4.2 Use Escalation in Daily Summarizer
**File**: `src/cron/daily-summarizer.ts`

**Replace**:
```typescript
const digestData = await this.summarizer.summarizeToDigest(sessionId, batch);
```

**With**:
```typescript
const digestData = await this.summarizer.summarizeToDigestWithEscalation(
  sessionId,
  batch,
  { targetTokens: 1200 }
);
```

### Testing
- [ ] Feed 50K token input, verify Level 1 succeeds
- [ ] Feed pathological input (e.g., random UUIDs), verify Level 2 or 3 kicks in
- [ ] Verify no infinite loops (set timeout to 60s, expect completion)

---

## Phase 5: Large File Handling (Medium Priority)

**Goal**: Preserve structure for code/JSON files >25K tokens  
**Effort**: High (4-5 days)  
**Impact**: Medium (only matters for code-heavy workflows)

### Changes

#### 5.1 File Interception
**File**: `src/large-files/file-interceptor.ts`

```typescript
export class FileInterceptor {
  private threshold: number;
  
  constructor(thresholdTokens: number = 25000) {
    this.threshold = thresholdTokens;
  }
  
  shouldIntercept(content: string, mimeType?: string): boolean {
    return estimateTokens(content) > this.threshold;
  }
  
  async storeFile(
    content: string,
    metadata: { name: string; mimeType?: string }
  ): Promise<{ fileId: string; path: string }> {
    const fileId = uuidv4();
    const ext = metadata.mimeType?.includes('json') ? '.json' : '.txt';
    const path = `~/.openclaw/memory/files/${fileId}${ext}`;
    
    await fs.promises.writeFile(path, content);
    
    return { fileId, path };
  }
}
```

#### 5.2 Exploration Summaries
**File**: `src/large-files/exploration-summarizer.ts`

```typescript
export class ExplorationSummarizer {
  async summarize(
    content: string,
    metadata: { name: string; mimeType?: string }
  ): Promise<string> {
    if (metadata.mimeType?.includes('json')) {
      return this.summarizeJSON(content);
    } else if (metadata.mimeType?.includes('javascript') || metadata.mimeType?.includes('typescript')) {
      return this.summarizeCode(content);
    } else {
      return this.summarizeText(content);
    }
  }
  
  private summarizeJSON(content: string): string {
    try {
      const obj = JSON.parse(content);
      const schema = this.extractSchema(obj);
      return `JSON Schema:\n${JSON.stringify(schema, null, 2)}`;
    } catch {
      return '[Invalid JSON]';
    }
  }
  
  private extractSchema(obj: any, depth = 0): any {
    if (depth > 3) return '[nested]';
    if (Array.isArray(obj)) return [this.extractSchema(obj[0], depth + 1)];
    if (typeof obj === 'object' && obj !== null) {
      const schema: any = {};
      for (const key of Object.keys(obj)) {
        schema[key] = this.extractSchema(obj[key], depth + 1);
      }
      return schema;
    }
    return typeof obj;
  }
  
  private summarizeCode(content: string): string {
    // Extract function/class signatures (naive regex-based)
    const functions = content.match(/(?:function|async function|const \w+ =)\s+\w+\([^)]*\)/g) || [];
    const classes = content.match(/class \w+/g) || [];
    
    return `Code Structure:\n` +
      `Functions: ${functions.length}\n` +
      `Classes: ${classes.length}\n` +
      `Top-level exports:\n${functions.slice(0, 10).join('\n')}`;
  }
  
  private async summarizeText(content: string): Promise<string> {
    // Use LLM to summarize unstructured text
    return `[Text file: ${estimateTokens(content)} tokens]`;
  }
}
```

#### 5.3 Integration
**File**: `src/plugin-entry.ts`

```typescript
const fileInterceptor = new FileInterceptor(config.largeFileThreshold || 25000);
const explorationSummarizer = new ExplorationSummarizer();

// In ingestBatch:
if (fileInterceptor.shouldIntercept(msg.content, msg.metadata?.mimeType)) {
  const { fileId, path } = await fileInterceptor.storeFile(msg.content, msg.metadata);
  const exploration = await explorationSummarizer.summarize(msg.content, msg.metadata);
  
  // Store reference instead of full content
  await episodeStore.insert({
    session_id: sessionId,
    role: msg.role,
    content: `[File: ${msg.metadata?.name || 'untitled'}]\nID: ${fileId}\nPath: ${path}\n\n${exploration}`,
    metadata: { file_id: fileId, file_path: path, is_file_ref: true },
  });
}
```

### Testing
- [ ] Ingest 50KB JSON file, verify schema extraction works
- [ ] Ingest 100KB TypeScript file, verify function signatures are extracted
- [ ] Query for file content, verify exploration summary appears (not full file)
- [ ] Use `memory_expand` to retrieve full file (via file_id)

---

## Phase 6: Transactional Compaction (Polish)

**Goal**: Prevent data loss on crashes  
**Effort**: Medium (2-3 days)  
**Impact**: Medium (improves reliability)

### Changes

#### 6.1 Transaction Wrapper
**File**: `src/tiers/episodes.ts`

```typescript
async insertWithTransaction(episodes: Episode[]): Promise<void> {
  const { data, error } = await this.supabase.rpc('insert_episodes_transactional', {
    episodes_json: JSON.stringify(episodes),
  });
  
  if (error) {
    console.error('[EpisodeStore] Transaction failed, rolling back:', error);
    throw error;
  }
}
```

**SQL Function**:
```sql
CREATE OR REPLACE FUNCTION insert_episodes_transactional(episodes_json TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO memory_episodes (session_id, role, content, embedding, metadata)
  SELECT
    (ep->>'session_id')::TEXT,
    (ep->>'role')::TEXT,
    (ep->>'content')::TEXT,
    (ep->>'embedding')::VECTOR(1536),
    (ep->>'metadata')::JSONB
  FROM json_array_elements(episodes_json::JSON) AS ep;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No episodes inserted';
  END IF;
END;
$$ LANGUAGE plpgsql;
```

#### 6.2 Use in Ingest
**File**: `src/plugin-entry.ts`

```typescript
async ingestBatch({ sessionId, messages }) {
  // ... (fire-and-forget background work)
  
  setTimeout(async () => {
    try {
      await storageEpisodeStore.insertWithTransaction(storableMessages);
    } catch (err) {
      console.error('[openclaw-memory] Transaction failed, retrying...', err);
      // Retry logic or dead-letter queue
    }
  }, 0);
}
```

### Testing
- [ ] Kill process mid-insert, verify partial writes are rolled back
- [ ] Verify 100 episodes inserted atomically (all or nothing)

---

## Appendix: File Structure After Changes

```
openclaw-memory/
├── docs/
│   ├── lcm-comparison.md          # This analysis
│   └── implementation-plan.md     # This file
├── src/
│   ├── cron/
│   │   ├── daily-summarizer.ts
│   │   ├── weekly-promoter.ts
│   │   └── digest-grouper.ts      # NEW (Phase 3)
│   ├── large-files/               # NEW (Phase 5)
│   │   ├── file-interceptor.ts
│   │   └── exploration-summarizer.ts
│   ├── tiers/
│   │   ├── episodes.ts            # Updated (Phase 1, 6)
│   │   ├── digests.ts
│   │   ├── knowledge.ts
│   │   ├── digest-groups.ts       # NEW (Phase 3)
│   │   └── summarizer.ts          # Updated (Phase 4)
│   ├── tools/
│   │   ├── memory-search-tool.ts  # Updated (Phase 2)
│   │   └── memory-expand-tool.ts  # NEW (Phase 2)
│   └── plugin-entry.ts            # Updated (all phases)
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_add_backlinks.sql      # NEW (Phase 1)
│   └── 003_digest_groups.sql      # NEW (Phase 3)
├── scripts/
│   ├── daily-digest-cron.mjs
│   ├── weekly-knowledge-cron.mjs
│   └── weekly-digest-grouping-cron.mjs  # NEW (Phase 3)
└── package.json
```

---

## Timeline

| Phase | Feature | Days | Dependencies |
|-------|---------|------|--------------|
| 1 | Lossless Retrievability | 1-2 | None |
| 2 | Expansion Tool | 2-3 | Phase 1 |
| 3 | Hierarchical Digests | 4-5 | Phase 1 |
| 4 | Three-Level Escalation | 2-3 | None (parallel) |
| 5 | Large File Handling | 4-5 | None (parallel) |
| 6 | Transactional Compaction | 2-3 | None (parallel) |

**Total**: 15-21 days (3-4 weeks) if done sequentially  
**Parallel**: Can do Phases 4, 5, 6 in parallel after Phase 1 completes

---

## Success Criteria

- [ ] **Lossless**: Episodes never deleted; always retrievable via ID
- [ ] **Hierarchical**: Digest groups auto-created at 100+ digests
- [ ] **Expandable**: `memory_expand(episode_ids)` returns original text
- [ ] **Convergent**: Summarization never loops (three-level escalation)
- [ ] **Structured**: Large files preserve metadata (JSON schema, code signatures)
- [ ] **Transactional**: No partial writes on crashes

---

## Next Steps

1. **Set up local dev environment** on MacBook
2. **Run Phase 1 migration** (add backlinks, preserve episodes)
3. **Test Phase 1** with existing data (verify no deletions)
4. **Implement Phase 2** (expansion tool)
5. **Test end-to-end**: search → expand → verify original text
6. **Deploy to VPS** (test in production)
7. **Repeat for Phases 3-6**

---

**End of Implementation Plan**
