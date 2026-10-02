// Each recall primes topics from its results, and those priming boosts feed the
// next recall's scores whatever `reconsolidate` is. A harness that runs several
// recalls through one Memory and needs each one to read the same state resets
// the sensory buffer before every recall.

interface SensoryBufferLike {
  snapshot(sessionId: string): unknown
  restore(snapshot: unknown): void
  getIntent(): unknown
  setIntent(intent: unknown): void
}

function isSensoryBuffer(v: unknown): v is SensoryBufferLike {
  if (v === null || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return ['snapshot', 'restore', 'getIntent', 'setIntent'].every((m) => typeof s[m] === 'function')
}

/**
 * Captures the memory's sensory buffer (working items, primed topics, active
 * intent) as it is now and returns a function that puts it back. Memory keeps
 * the buffer private; this fails loudly if that field changes rather than
 * letting recalls leak into each other.
 */
export function sensoryResetter(memory: object, snapshotId: string): () => void {
  const sensory = (memory as { sensory?: unknown }).sensory
  if (!isSensoryBuffer(sensory)) {
    throw new Error('Memory has no sensory buffer with snapshot/restore; cannot isolate recalls from each other')
  }
  const snapshot = sensory.snapshot(snapshotId)
  const intent = sensory.getIntent()
  return () => {
    sensory.restore(snapshot)
    sensory.setIntent(intent)
  }
}
