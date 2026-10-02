// A recall that names a conversation primes topics from its results, and
// those priming boosts feed that conversation's next recall whatever
// `reconsolidate` is. A recall without a conversation key reads and writes no
// priming state. A harness that runs several recalls through one Memory and
// needs each one to read the same state restores the conversation store
// before every recall, so isolation holds even if a harness passes keys.

interface ConversationStoreLike {
  snapshot(): unknown
  restore(snapshot: unknown): void
}

function isConversationStore(v: unknown): v is ConversationStoreLike {
  if (v === null || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return ['snapshot', 'restore'].every((m) => typeof s[m] === 'function')
}

/**
 * Captures the memory's per-conversation recall state (primed topics and
 * intent of every conversation) as it is now and returns a function that
 * puts it back. Memory keeps the store private; this fails loudly if that
 * field changes rather than letting recalls leak into each other.
 * `snapshotId` names the harness in the error message.
 */
export function sensoryResetter(memory: object, snapshotId: string): () => void {
  const conversations = (memory as { conversations?: unknown }).conversations
  if (!isConversationStore(conversations)) {
    throw new Error(`${snapshotId}: Memory has no conversation store with snapshot/restore; cannot isolate recalls from each other`)
  }
  const snapshot = conversations.snapshot()
  return () => {
    conversations.restore(snapshot)
  }
}
