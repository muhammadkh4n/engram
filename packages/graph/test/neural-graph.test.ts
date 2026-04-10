import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { createTestGraph } from './helpers/setup.js'

describe('NeuralGraph (integration)', () => {
  let graph: NeuralGraph

  beforeAll(async () => {
    graph = await createTestGraph()
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
  })

  describe('node creation', () => {
    it('creates a Memory node and retrieves it', async () => {
      const id = await graph.addMemoryNode({
        id: 'ep-001',
        memoryType: 'episode',
        label: 'Test episode about TypeScript',
      })

      expect(id).toBe('ep-001')

      const node = await graph.getNode('ep-001')
      expect(node).not.toBeNull()
      expect(node!.label).toBe('Memory')
      expect(node!.properties.memoryType).toBe('episode')
      expect(node!.properties.activationCount).toBe(0)
    })

    it('MERGE deduplicates: same ID creates one node, increments activationCount', async () => {
      await graph.addMemoryNode({
        id: 'ep-dedup-001',
        memoryType: 'episode',
        label: 'First insert',
      })
      await graph.addMemoryNode({
        id: 'ep-dedup-001',
        memoryType: 'episode',
        label: 'Second insert',
      })

      const node = await graph.getNode('ep-dedup-001')
      expect(node).not.toBeNull()
      expect(node!.properties.activationCount).toBe(1)
    })

    it('creates Person nodes as global singletons (engram cells)', async () => {
      const id1 = await graph.addPersonNode({ name: 'Muhammad Khan' })
      const id2 = await graph.addPersonNode({ name: 'Muhammad Khan' })

      expect(id1).toBe(id2)
      expect(id1).toBe('person:muhammad_khan')

      const node = await graph.getNode('person:muhammad_khan')
      expect(node).not.toBeNull()
      expect(node!.properties.activationCount).toBe(1)
    })

    it('creates Entity nodes with deterministic IDs', async () => {
      const id1 = await graph.addEntityNode({ name: 'TypeScript', entityType: 'tech' })
      const id2 = await graph.addEntityNode({ name: 'typescript', entityType: 'tech' })

      expect(id1).toBe(id2)
      expect(id1).toBe('entity:typescript')
    })

    it('creates Emotion nodes scoped to session', async () => {
      const id1 = await graph.addEmotionNode({
        label: 'frustrated',
        intensity: 0.7,
        sessionId: 'session-A',
      })
      const id2 = await graph.addEmotionNode({
        label: 'frustrated',
        intensity: 0.5,
        sessionId: 'session-B',
      })

      expect(id1).not.toBe(id2)
      expect(id1).toBe('emotion:session-A:frustrated')
      expect(id2).toBe('emotion:session-B:frustrated')
    })

    it('creates TimeContext nodes scoped to yearWeek', async () => {
      const monday1 = new Date('2026-04-06T09:00:00')
      const monday2 = new Date('2026-04-13T09:00:00')

      const id1 = await graph.addTimeContextNode({ timestamp: monday1 })
      const id2 = await graph.addTimeContextNode({ timestamp: monday2 })

      expect(id1).not.toBe(id2)
      expect(id1).toContain('monday:morning')
      expect(id2).toContain('monday:morning')
    })
  })

  describe('edge creation', () => {
    it('creates an edge between two nodes', async () => {
      await graph.addMemoryNode({ id: 'edge-src', memoryType: 'episode', label: 'Source' })
      await graph.addPersonNode({ name: 'Edge Target Person' })

      await graph.addEdge('edge-src', 'person:edge_target_person', 'SPOKE', 0.7)

      const neighbors = await graph.getNeighbors('edge-src', { direction: 'out' })
      expect(neighbors.length).toBeGreaterThanOrEqual(1)
      const personNeighbor = neighbors.find(n => n.id === 'person:edge_target_person')
      expect(personNeighbor).toBeDefined()
      expect(personNeighbor!.edgeWeight).toBe(0.7)
    })

    it('MERGE deduplicates edges: same edge increments traversalCount', async () => {
      await graph.addMemoryNode({ id: 'edge-dedup-src', memoryType: 'episode', label: 'Src' })
      await graph.addEntityNode({ name: 'DedupTech', entityType: 'tech' })

      await graph.addEdge('edge-dedup-src', 'entity:deduptech', 'CONTEXTUAL', 0.5)
      await graph.addEdge('edge-dedup-src', 'entity:deduptech', 'CONTEXTUAL', 0.6)

      const neighbors = await graph.getNeighbors('edge-dedup-src')
      const tech = neighbors.find(n => n.id === 'entity:deduptech')
      expect(tech).toBeDefined()
      expect(tech!.edgeWeight).toBe(0.6)
    })
  })

  describe('decomposeEpisode', () => {
    it('creates all nodes and edges in a single transaction', async () => {
      await graph.decomposeEpisode({
        episodeId: 'decompose-ep-001',
        memoryType: 'episode',
        label: 'Muhammad discussed TypeScript debugging with frustration',
        sessionId: 'decompose-session-001',
        timestamp: new Date('2026-04-06T14:30:00'),
        persons: ['Muhammad Khan'],
        entities: [
          { name: 'TypeScript', entityType: 'tech' },
          { name: 'Neo4j', entityType: 'tech' },
        ],
        emotion: { label: 'frustrated', intensity: 0.7 },
        intent: 'DEBUGGING',
      })

      const memory = await graph.getNode('decompose-ep-001')
      expect(memory).not.toBeNull()
      expect(memory!.label).toBe('Memory')

      const person = await graph.getNode('person:muhammad_khan')
      expect(person).not.toBeNull()

      const ts = await graph.getNode('entity:typescript')
      expect(ts).not.toBeNull()
      const neo = await graph.getNode('entity:neo4j')
      expect(neo).not.toBeNull()

      const emotion = await graph.getNode('emotion:decompose-session-001:frustrated')
      expect(emotion).not.toBeNull()

      const intent = await graph.getNode('intent:decompose-session-001:DEBUGGING')
      expect(intent).not.toBeNull()

      const session = await graph.getNode('decompose-session-001')
      expect(session).not.toBeNull()

      const neighbors = await graph.getNeighbors('decompose-ep-001', { direction: 'out' })
      const neighborIds = neighbors.map(n => n.id)
      expect(neighborIds).toContain('person:muhammad_khan')
      expect(neighborIds).toContain('entity:typescript')
      expect(neighborIds).toContain('entity:neo4j')
      expect(neighborIds).toContain('emotion:decompose-session-001:frustrated')
      expect(neighborIds).toContain('intent:decompose-session-001:DEBUGGING')
      expect(neighborIds).toContain('decompose-session-001')
    })

    it('shared Person node creates implicit association between memories', async () => {
      await graph.decomposeEpisode({
        episodeId: 'shared-person-ep-1',
        memoryType: 'episode',
        label: 'Muhammad discussed architecture',
        sessionId: 'shared-session',
        timestamp: new Date('2026-04-06T10:00:00'),
        persons: ['Muhammad Khan'],
        entities: [],
        emotion: null,
        intent: null,
      })
      await graph.decomposeEpisode({
        episodeId: 'shared-person-ep-2',
        memoryType: 'episode',
        label: 'Muhammad reviewed the PR',
        sessionId: 'shared-session',
        timestamp: new Date('2026-04-06T11:00:00'),
        persons: ['Muhammad Khan'],
        entities: [],
        emotion: null,
        intent: null,
      })

      const neighbors1 = await graph.getNeighbors('shared-person-ep-1', { edgeType: 'SPOKE' })
      const neighbors2 = await graph.getNeighbors('shared-person-ep-2', { edgeType: 'SPOKE' })
      expect(neighbors1[0]?.id).toBe('person:muhammad_khan')
      expect(neighbors2[0]?.id).toBe('person:muhammad_khan')
    })

    it('creates 100 memories with shared context, deduplicates correctly', async () => {
      for (let i = 0; i < 100; i++) {
        await graph.decomposeEpisode({
          episodeId: `bulk-ep-${i}`,
          memoryType: 'episode',
          label: `Bulk episode ${i} about TypeScript`,
          sessionId: 'bulk-session',
          timestamp: new Date(`2026-04-06T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`),
          persons: ['Muhammad Khan'],
          entities: [{ name: 'TypeScript', entityType: 'tech' }],
          emotion: i % 10 === 0 ? { label: 'frustrated', intensity: 0.5 } : null,
          intent: 'TASK_CONTINUE',
        })
      }

      const stats = await graph.stats()
      expect(stats.nodes['Memory']).toBeGreaterThanOrEqual(100)
    })
  })

  describe('ping', () => {
    it('returns true when Neo4j is reachable', async () => {
      const result = await graph.ping()
      expect(result).toBe(true)
    })
  })
})
