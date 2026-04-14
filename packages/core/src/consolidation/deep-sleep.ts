import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import type { GraphPort } from '../adapters/graph.js'
import type { ConsolidateResult } from '../types.js'
import { extractCounters } from './graph-counters.js'

export interface DeepSleepOptions {
  minDigests?: number
}

// ---------------------------------------------------------------------------
// Extraction patterns
// ---------------------------------------------------------------------------

interface KnowledgeCandidate {
  topic: string
  content: string
  fullMatch?: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
  kind: 'semantic' | 'procedural'
  trigger?: string
}

const SEMANTIC_PATTERNS: Array<{ pattern: RegExp; topic: string; confidence: number }> = [
  { pattern: /I prefer\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I like\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I want\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.85 },
  { pattern: /I don'?t like\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I hate\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /let'?s go with\s+(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /we decided\s+(?:to\s+)?(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /the plan is to\s+(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /my (?:name|email|timezone|location) is\s+(.+?)(?:\.|,|$)/gi, topic: 'personal_info', confidence: 0.9 },
]

const PROCEDURAL_TRIGGER_PATTERNS: Array<{ pattern: RegExp; category: 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention' }> = [
  { pattern: /\bmy workflow is\b(.+)/i, category: 'workflow' },
  { pattern: /\bi usually\b(.+)/i, category: 'habit' },
  { pattern: /\bmy process is\b(.+)/i, category: 'workflow' },
  { pattern: /\bi always\b(.+)/i, category: 'habit' },
  { pattern: /\bbefore (?:i|we) \w+,\s*(?:i|we)\b(.+)/i, category: 'workflow' },
  { pattern: /\bafter (?:i|we) \w+,\s*(?:i|we)\b(.+)/i, category: 'workflow' },
  { pattern: /\bnever use\b(.+)/i, category: 'convention' },
  { pattern: /\balways run\b(.+)/i, category: 'convention' },
  { pattern: /\bmake sure to\b(.+)/i, category: 'convention' },
]

const CONTRADICTION_PAIRS: Array<[RegExp, RegExp]> = [
  [/I prefer\s+(.+)/i, /I don'?t like\s+(.+)/i],
  [/I like\s+(.+)/i, /I hate\s+(.+)/i],
  [/I like\s+(.+)/i, /I don'?t like\s+(.+)/i],
  [/I always\s+(.+)/i, /I never\s+(.+)/i],
  [/I don'?t like\s+(.+)/i, /I prefer\s+(.+)/i],
  [/I don'?t like\s+(.+)/i, /I like\s+(.+)/i],
  [/I hate\s+(.+)/i, /I like\s+(.+)/i],
  [/I hate\s+(.+)/i, /I prefer\s+(.+)/i],
  [/I never\s+(.+)/i, /I always\s+(.+)/i],
]

function subjectsOverlap(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  let overlap = 0
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++
  }
  const maxSize = Math.max(wordsA.size, wordsB.size)
  if (maxSize === 0) return false
  return overlap / maxSize > 0.5
}

function extractCandidatesFromText(text: string, digestId: string): KnowledgeCandidate[] {
  const candidates: KnowledgeCandidate[] = []
  const seen = new Set<string>()

  for (const { pattern, category } of PROCEDURAL_TRIGGER_PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) {
      const procedure = match[1].trim()
      if (procedure.length < 3) continue
      const key = `procedural:${category}:${procedure}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        topic: category,
        content: procedure,
        confidence: 0.85,
        sourceDigestIds: [digestId],
        sourceEpisodeIds: [],
        kind: 'procedural',
        trigger: category,
      })
    }
  }

  for (const { pattern, topic, confidence } of SEMANTIC_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const content = match[1].trim()
      if (content.length < 3) continue
      const key = `semantic:${topic}:${content}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        topic,
        content,
        fullMatch: match[0].trim(),
        confidence,
        sourceDigestIds: [digestId],
        sourceEpisodeIds: [],
        kind: 'semantic',
      })
    }
  }

  return candidates
}

function detectSupersession(newPhrase: string, existingContent: string): boolean {
  for (const [patternA, patternB] of CONTRADICTION_PAIRS) {
    const newMatchA = newPhrase.match(patternA)
    const existMatchB = existingContent.match(patternB)
    if (newMatchA && existMatchB) {
      if (subjectsOverlap(newMatchA[1], existMatchB[1])) return true
    }
  }
  return false
}

/**
 * Deep Sleep (Weekly) — Digests -> Semantic + Procedural.
 *
 * Brain analogy: Slow-wave sleep. Transfers hippocampal memories to neocortex,
 * extracting facts, patterns, and procedural rules.
 *
 * Neo4j operations (when graph is available):
 * - Creates Semantic/Procedural Memory nodes
 * - DERIVES_FROM edges to source digests
 * - Transitive context inheritance with MAX weight attenuation
 * - CONTRADICTS relationships on supersession
 * - Temporal validity (validFrom from earliest source episode)
 */
export async function deepSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  opts?: DeepSleepOptions,
  graph?: GraphPort | null,
): Promise<ConsolidateResult> {
  const minDigests = opts?.minDigests ?? 3

  const digests = await storage.digests.getRecent(7)

  if (digests.length < minDigests) {
    return { cycle: 'deep', promoted: 0, procedural: 0, deduplicated: 0, superseded: 0 }
  }

  const graphAvailable = graph?.runCypherWrite && await graph.isAvailable().catch(() => false)

  let promoted = 0
  let procedural = 0
  let deduplicated = 0
  let superseded = 0
  let graphNodesCreated = 0
  let graphEdgesCreated = 0

  // Collect all candidates from all digests
  const allCandidates: KnowledgeCandidate[] = []
  for (const digest of digests) {
    const candidates = extractCandidatesFromText(digest.summary, digest.id)
    allCandidates.push(...candidates)
  }

  // If intelligence adapter supports extractKnowledge, use it to augment
  if (intelligence?.extractKnowledge) {
    for (const digest of digests) {
      try {
        const aiCandidates = await intelligence.extractKnowledge(digest.summary)
        for (const c of aiCandidates) {
          allCandidates.push({
            ...c,
            sourceDigestIds: c.sourceDigestIds.length > 0 ? c.sourceDigestIds : [digest.id],
            kind: 'semantic',
          })
        }
      } catch {
        // ignore intelligence errors
      }
    }
  }

  // Process semantic candidates
  const semanticCandidates = allCandidates.filter(c => c.kind === 'semantic')
  for (const candidate of semanticCandidates) {
    const existing = await storage.semantic.search(candidate.content, { limit: 5 })
    const duplicate = existing.find(e => e.similarity > 0.92)

    if (duplicate) {
      await storage.semantic.recordAccessAndBoost(duplicate.item.id, 0.1)
      deduplicated++
      continue
    }

    let supersededId: string | null = null
    const phraseForSupersession = candidate.fullMatch ?? candidate.content
    for (const e of existing) {
      if (detectSupersession(phraseForSupersession, e.item.content)) {
        supersededId = e.item.id
        break
      }
    }

    const knowledge = await storage.semantic.insert({
      topic: candidate.topic,
      content: candidate.content,
      confidence: candidate.confidence,
      sourceDigestIds: candidate.sourceDigestIds,
      sourceEpisodeIds: candidate.sourceEpisodeIds,
      decayRate: 0.02,
      supersedes: supersededId,
      supersededBy: null,
      embedding: null,
      metadata: {},
      projectId: null,
    })

    if (supersededId) {
      await storage.semantic.markSuperseded(supersededId, knowledge.id)
      superseded++
    }

    // SQL derives_from associations
    for (const digestId of candidate.sourceDigestIds) {
      await storage.associations.insert({
        sourceId: digestId,
        sourceType: 'digest',
        targetId: knowledge.id,
        targetType: 'semantic',
        edgeType: 'derives_from',
        strength: 0.8,
        lastActivated: null,
        metadata: {},
      })
    }

    // --- Neo4j: Semantic Memory node ---
    if (graphAvailable && graph?.runCypherWrite) {
      try {
        const now = new Date().toISOString()

        // AUDIT FIX: validFrom = earliest source episode, not consolidation time
        let validFrom = now
        if (storage.episodes.findEarliestInDigests) {
          const earliest = await storage.episodes.findEarliestInDigests(candidate.sourceDigestIds)
          if (earliest) validFrom = earliest.createdAt.toISOString()
        }

        // Step 1: Create Semantic Memory node
        const nodeResult = await graph.runCypherWrite(`
          MERGE (s:Memory {id: $semanticId})
          SET s.memoryType = 'semantic',
              s.label = $label,
              s.topic = $topic,
              s.createdAt = $now,
              s.validFrom = $validFrom,
              s.validUntil = null,
              s.pageRank = 0.0,
              s.betweenness = 0.0,
              s.isBridge = false,
              s.activationCount = 0
        `, {
          semanticId: knowledge.id,
          label: `${candidate.topic}: ${candidate.content.slice(0, 60)}`,
          topic: candidate.topic,
          now,
          validFrom,
        })
        graphNodesCreated += extractCounters(nodeResult).nodesCreated

        // Step 2: DERIVES_FROM edges to source digests
        const derivesResult = await graph.runCypherWrite(`
          UNWIND $sourceDigestIds AS digestId
          MATCH (dig:Memory {id: digestId})
          MATCH (s:Memory {id: $semanticId})
          MERGE (s)-[r:DERIVES_FROM]->(dig)
          ON CREATE SET r.weight = 0.8,
                        r.createdAt = $now,
                        r.lastTraversed = null,
                        r.traversalCount = 0
        `, { sourceDigestIds: candidate.sourceDigestIds, semanticId: knowledge.id, now })
        graphEdgesCreated += extractCounters(derivesResult).relationshipsCreated

        // Step 3: Transitive context inheritance with MAX weight
        const ctxResult = await graph.runCypherWrite(`
          MATCH (dig:Memory)-[r:CONTEXTUAL]->(ctx)
          WHERE dig.id IN $sourceDigestIds
            AND (ctx:Person OR ctx:Entity OR ctx:Topic)
          WITH ctx, max(r.weight) * 0.7 AS inheritedWeight
          MATCH (s:Memory {id: $semanticId})
          MERGE (s)-[rel:CONTEXTUAL]->(ctx)
          ON CREATE SET rel.weight = inheritedWeight,
                        rel.createdAt = $now,
                        rel.lastTraversed = null,
                        rel.traversalCount = 0
          ON MATCH SET rel.weight = CASE
                         WHEN rel.weight < inheritedWeight THEN inheritedWeight
                         ELSE rel.weight
                       END,
                       rel.lastTraversed = $now
        `, { sourceDigestIds: candidate.sourceDigestIds, semanticId: knowledge.id, now })
        graphEdgesCreated += extractCounters(ctxResult).relationshipsCreated

        // Step 4: Supersession → CONTRADICTS + validUntil
        if (supersededId) {
          await graph.runCypherWrite(`
            MATCH (old:Memory {id: $oldId})
            MATCH (new:Memory {id: $newId})
            SET old.validUntil = $now
            MERGE (new)-[r:CONTRADICTS]->(old)
            ON CREATE SET r.weight = 1.0,
                          r.createdAt = $now,
                          r.lastTraversed = null,
                          r.traversalCount = 0
          `, { oldId: supersededId, newId: knowledge.id, now })
          graphEdgesCreated++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[deep-sleep] Neo4j graph update failed for ${knowledge.id}: ${msg}`)
      }
    }

    promoted++
  }

  // Process procedural candidates
  const proceduralCandidates = allCandidates.filter(c => c.kind === 'procedural')
  for (const candidate of proceduralCandidates) {
    const searchQuery = `${candidate.trigger ?? candidate.topic} ${candidate.content}`
    const existing = await storage.procedural.searchByTrigger(searchQuery, { limit: 3 })
    const match = existing.find(e => e.similarity > 0.85)

    if (match) {
      await storage.procedural.incrementObservation(match.item.id)
      continue
    }

    const proceduralRecord = await storage.procedural.insert({
      category: (candidate.trigger as 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention') ?? 'preference',
      trigger: candidate.trigger ?? candidate.topic,
      procedure: candidate.content,
      confidence: candidate.confidence,
      observationCount: 1,
      lastObserved: new Date(),
      firstObserved: new Date(),
      decayRate: 0.01,
      sourceEpisodeIds: candidate.sourceEpisodeIds,
      embedding: null,
      metadata: {},
      projectId: null,
    })

    // --- Neo4j: Procedural Memory node ---
    if (graphAvailable && graph?.runCypherWrite) {
      try {
        const now = new Date().toISOString()
        const nodeResult = await graph.runCypherWrite(`
          MERGE (p:Memory {id: $proceduralId})
          SET p.memoryType = 'procedural',
              p.label = $label,
              p.triggerPattern = $triggerPattern,
              p.createdAt = $now,
              p.validFrom = $now,
              p.validUntil = null,
              p.pageRank = 0.0,
              p.betweenness = 0.0,
              p.isBridge = false,
              p.activationCount = 0
        `, {
          proceduralId: proceduralRecord.id,
          label: `${candidate.trigger}: ${candidate.content.slice(0, 60)}`,
          triggerPattern: candidate.trigger ?? candidate.topic,
          now,
        })
        graphNodesCreated += extractCounters(nodeResult).nodesCreated
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[deep-sleep] Neo4j graph update failed for procedural ${proceduralRecord.id}: ${msg}`)
      }
    }

    procedural++
  }

  return {
    cycle: 'deep',
    promoted,
    procedural,
    deduplicated,
    superseded,
    graphNodesCreated: graphAvailable ? graphNodesCreated : undefined,
    graphEdgesCreated: graphAvailable ? graphEdgesCreated : undefined,
  }
}
