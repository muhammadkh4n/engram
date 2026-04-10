/**
 * Wave 2 — Context assembly unit tests.
 *
 * Verifies that assembleContext() correctly maps activated graph nodes
 * into a CompositeMemory with speakers, emotions, topics, temporal context,
 * and dominant intent.
 */
import { describe, it, expect } from 'vitest'
import type { ActivatedNode } from '@engram-mem/graph'
import { assembleContext } from '../../src/retrieval/context-assembly.js'

function node(
  nodeType: string,
  properties: Record<string, unknown>,
  activation = 0.5,
): ActivatedNode {
  return {
    nodeId: `${nodeType}:${properties['id'] ?? properties['name'] ?? 'x'}`,
    nodeType,
    activation,
    depth: 1,
    properties,
  }
}

describe('Wave 2 — assembleContext', () => {
  it('extracts speakers from Person nodes', () => {
    const result = assembleContext(
      [],
      [],
      [],
      [node('Person', { name: 'Muhammad', role: 'user' })],
    )
    expect(result.speakers).toEqual([{ name: 'Muhammad', role: 'user' }])
  })

  it('deduplicates speakers by name (case insensitive)', () => {
    const result = assembleContext(
      [],
      [],
      [],
      [
        node('Person', { name: 'Sarah', role: 'user' }, 0.7),
        node('Person', { name: 'SARAH', role: 'user' }, 0.5),
        node('Person', { name: 'sarah', role: 'user' }, 0.3),
      ],
    )
    expect(result.speakers).toHaveLength(1)
  })

  it('extracts emotional context from Emotion nodes', () => {
    const result = assembleContext(
      [],
      [],
      [],
      [node('Emotion', { label: 'frustrated', intensity: 0.8 })],
    )
    expect(result.emotionalContext).toEqual([{ label: 'frustrated', intensity: 0.8 }])
  })

  it('extracts related topics from Topic and Entity nodes', () => {
    const result = assembleContext(
      [],
      [],
      [],
      [
        node('Topic', { name: 'TypeScript' }),
        node('Entity', { name: 'Neo4j' }),
        node('Topic', { name: 'TypeScript' }), // duplicate — should be deduped
      ],
    )
    expect(result.relatedTopics).toContain('TypeScript')
    expect(result.relatedTopics).toContain('Neo4j')
    expect(result.relatedTopics).toHaveLength(2)
  })

  it('caps related topics at 10', () => {
    const topics: ActivatedNode[] = Array.from({ length: 20 }, (_, i) =>
      node('Topic', { name: `topic-${i}` }),
    )
    const result = assembleContext([], [], [], topics)
    expect(result.relatedTopics).toHaveLength(10)
  })

  it('determines dominant intent from Intent node frequency', () => {
    const result = assembleContext(
      [],
      [],
      [],
      [
        node('Intent', { intentType: 'DEBUGGING' }),
        node('Intent', { intentType: 'DEBUGGING' }),
        node('Intent', { intentType: 'DEBUGGING' }),
        node('Intent', { intentType: 'QUESTION' }),
      ],
    )
    expect(result.dominantIntent).toBe('DEBUGGING')
  })

  it('defaults dominantIntent to INFORMATIONAL when no Intent nodes present', () => {
    const result = assembleContext([], [], [], [node('Person', { name: 'A' })])
    expect(result.dominantIntent).toBe('INFORMATIONAL')
  })

  it('merges Session and TimeContext nodes into temporal entries', () => {
    const result = assembleContext(
      [],
      [],
      [],
      [
        node('Session', { sessionId: 'sess-001', id: 'sess-001' }),
        node('TimeContext', {
          dayOfWeek: 'tuesday',
          timeOfDay: 'evening',
          timestamp: '2026-04-01T19:00:00Z',
        }),
      ],
    )
    expect(result.temporalContext).toHaveLength(1)
    expect(result.temporalContext[0]).toMatchObject({
      session: 'sess-001',
      timeOfDay: 'evening',
    })
    expect(result.temporalContext[0]!.date).not.toBe('unknown')
  })

  it('creates standalone temporal entry when TimeContext has no prior Session', () => {
    const result = assembleContext(
      [],
      [],
      [],
      [
        node('TimeContext', {
          timeOfDay: 'morning',
          timestamp: '2026-04-01T08:00:00Z',
        }),
      ],
    )
    expect(result.temporalContext).toHaveLength(1)
    expect(result.temporalContext[0]!.session).toBe('unknown')
    expect(result.temporalContext[0]!.timeOfDay).toBe('morning')
  })

  it('preserves coreMemories and faintAssociations passthrough', () => {
    const core = [
      {
        id: 'm1',
        type: 'episode' as const,
        content: 'hello',
        relevance: 0.8,
        source: 'recall' as const,
        metadata: {},
      },
    ]
    const faint = [
      {
        id: 'm2',
        type: 'episode' as const,
        content: 'faint',
        relevance: 0.05,
        source: 'association' as const,
        metadata: {},
      },
    ]
    const result = assembleContext(core, [], faint, [])
    expect(result.coreMemories).toBe(core)
    expect(result.faintAssociations).toBe(faint)
  })
})
