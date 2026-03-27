import { describe, it, expect, beforeEach, vi } from 'vitest'
import { decayPass } from '../../src/consolidation/decay-pass.js'
import { makeMockStorage, resetIdCounter } from './mock-storage.js'

describe('decayPass', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  // -------------------------------------------------------------------------
  // Calls batchDecay on semantic storage
  // -------------------------------------------------------------------------

  describe('semantic batchDecay', () => {
    it('calls storage.semantic.batchDecay with daysThreshold 30', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      expect(storage.semantic.batchDecay).toHaveBeenCalledOnce()
      const [opts] = vi.mocked(storage.semantic.batchDecay).mock.calls[0]
      expect(opts.daysThreshold).toBe(30)
    })

    it('calls storage.semantic.batchDecay with default decayRate 0.02', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      const [opts] = vi.mocked(storage.semantic.batchDecay).mock.calls[0]
      expect(opts.decayRate).toBe(0.02)
    })

    it('uses custom semanticDecayRate when provided', async () => {
      const storage = makeMockStorage()

      await decayPass(storage, { semanticDecayRate: 0.05 })

      const [opts] = vi.mocked(storage.semantic.batchDecay).mock.calls[0]
      expect(opts.decayRate).toBe(0.05)
    })

    it('returns semanticDecayed count from batchDecay result', async () => {
      const storage = makeMockStorage()
      vi.mocked(storage.semantic.batchDecay).mockResolvedValue(7)

      const result = await decayPass(storage)

      expect(result.semanticDecayed).toBe(7)
    })
  })

  // -------------------------------------------------------------------------
  // Calls batchDecay on procedural storage
  // -------------------------------------------------------------------------

  describe('procedural batchDecay', () => {
    it('calls storage.procedural.batchDecay with daysThreshold 60', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      expect(storage.procedural.batchDecay).toHaveBeenCalledOnce()
      const [opts] = vi.mocked(storage.procedural.batchDecay).mock.calls[0]
      expect(opts.daysThreshold).toBe(60)
    })

    it('calls storage.procedural.batchDecay with default decayRate 0.01', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      const [opts] = vi.mocked(storage.procedural.batchDecay).mock.calls[0]
      expect(opts.decayRate).toBe(0.01)
    })

    it('uses custom proceduralDecayRate when provided', async () => {
      const storage = makeMockStorage()

      await decayPass(storage, { proceduralDecayRate: 0.03 })

      const [opts] = vi.mocked(storage.procedural.batchDecay).mock.calls[0]
      expect(opts.decayRate).toBe(0.03)
    })

    it('returns proceduralDecayed count from batchDecay result', async () => {
      const storage = makeMockStorage()
      vi.mocked(storage.procedural.batchDecay).mockResolvedValue(4)

      const result = await decayPass(storage)

      expect(result.proceduralDecayed).toBe(4)
    })

    it('procedural decayRate (0.01) is half of semantic (0.02) — stickier', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      const [semOpts] = vi.mocked(storage.semantic.batchDecay).mock.calls[0]
      const [procOpts] = vi.mocked(storage.procedural.batchDecay).mock.calls[0]
      expect(procOpts.decayRate).toBeLessThan(semOpts.decayRate)
    })

    it('procedural daysThreshold (60) is double semantic (30) — stickier', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      const [semOpts] = vi.mocked(storage.semantic.batchDecay).mock.calls[0]
      const [procOpts] = vi.mocked(storage.procedural.batchDecay).mock.calls[0]
      expect(procOpts.daysThreshold).toBeGreaterThan(semOpts.daysThreshold)
    })
  })

  // -------------------------------------------------------------------------
  // Calls pruneWeak on associations
  // -------------------------------------------------------------------------

  describe('association pruneWeak', () => {
    it('calls storage.associations.pruneWeak', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      expect(storage.associations.pruneWeak).toHaveBeenCalledOnce()
    })

    it('calls pruneWeak with maxStrength 0.05 by default', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      const [opts] = vi.mocked(storage.associations.pruneWeak).mock.calls[0]
      expect(opts.maxStrength).toBe(0.05)
    })

    it('calls pruneWeak with olderThanDays 90 by default', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      const [opts] = vi.mocked(storage.associations.pruneWeak).mock.calls[0]
      expect(opts.olderThanDays).toBe(90)
    })

    it('uses custom edgePruneThreshold when provided', async () => {
      const storage = makeMockStorage()

      await decayPass(storage, { edgePruneThreshold: 0.1 })

      const [opts] = vi.mocked(storage.associations.pruneWeak).mock.calls[0]
      expect(opts.maxStrength).toBe(0.1)
    })

    it('uses custom edgePruneDays when provided', async () => {
      const storage = makeMockStorage()

      await decayPass(storage, { edgePruneDays: 60 })

      const [opts] = vi.mocked(storage.associations.pruneWeak).mock.calls[0]
      expect(opts.olderThanDays).toBe(60)
    })

    it('returns edgesPruned count from pruneWeak result', async () => {
      const storage = makeMockStorage()
      vi.mocked(storage.associations.pruneWeak).mockResolvedValue(12)

      const result = await decayPass(storage)

      expect(result.edgesPruned).toBe(12)
    })
  })

  // -------------------------------------------------------------------------
  // Returns correct counts
  // -------------------------------------------------------------------------

  describe('returns correct ConsolidateResult', () => {
    it('includes cycle: "decay"', async () => {
      const storage = makeMockStorage()
      const result = await decayPass(storage)
      expect(result.cycle).toBe('decay')
    })

    it('aggregates all three counts correctly', async () => {
      const storage = makeMockStorage()
      vi.mocked(storage.semantic.batchDecay).mockResolvedValue(10)
      vi.mocked(storage.procedural.batchDecay).mockResolvedValue(5)
      vi.mocked(storage.associations.pruneWeak).mockResolvedValue(8)

      const result = await decayPass(storage)

      expect(result.semanticDecayed).toBe(10)
      expect(result.proceduralDecayed).toBe(5)
      expect(result.edgesPruned).toBe(8)
    })

    it('returns all expected fields', async () => {
      const storage = makeMockStorage()
      const result = await decayPass(storage)
      expect(result).toHaveProperty('cycle')
      expect(result).toHaveProperty('semanticDecayed')
      expect(result).toHaveProperty('proceduralDecayed')
      expect(result).toHaveProperty('edgesPruned')
    })

    it('all three storage operations are always called', async () => {
      const storage = makeMockStorage()

      await decayPass(storage)

      expect(storage.semantic.batchDecay).toHaveBeenCalledOnce()
      expect(storage.procedural.batchDecay).toHaveBeenCalledOnce()
      expect(storage.associations.pruneWeak).toHaveBeenCalledOnce()
    })
  })
})
