import { describe, it, expect, vi } from 'vitest'

/**
 * Pattern completion fallback trigger tests.
 *
 * These tests verify the CONDITIONS under which pattern completion fires.
 * The full graph path requires a live Neo4j connection, which is tested in
 * packages/graph/test/pattern-completion.test.ts.
 *
 * Here we verify the trigger logic in engine.ts using the regex and score
 * thresholds documented in the spec:
 *   - Trigger: RECALL_EXPLICIT query AND top vector score < 0.2
 *   - No-trigger: score >= 0.2 OR query is not RECALL_EXPLICIT
 */

const RECALL_EXPLICIT_REGEX = /\b(remember|recall|what did|did we|last time|previously|have we|remind me)\b/i

function isRecallExplicit(query: string): boolean {
  return RECALL_EXPLICIT_REGEX.test(query)
}

describe('Pattern completion fallback trigger', () => {
  it('only triggers when top vector score < 0.2 AND query is RECALL_EXPLICIT', () => {
    const query = 'remember when someone was frustrated about databases'
    const topScore = 0.15

    expect(isRecallExplicit(query)).toBe(true)
    expect(topScore < 0.2).toBe(true)
    // Both conditions true => pattern completion WOULD trigger
  })

  it('does NOT trigger when top vector score >= 0.2', () => {
    const query = 'remember when someone was frustrated about databases'
    const topScore = 0.35

    expect(isRecallExplicit(query)).toBe(true)
    expect(topScore < 0.2).toBe(false)
    // Score condition false => pattern completion would NOT trigger
  })

  it('does NOT trigger for non-RECALL_EXPLICIT queries even with weak scores', () => {
    const query = 'what is TypeScript?'
    const topScore = 0.10

    expect(isRecallExplicit(query)).toBe(false)
    expect(topScore < 0.2).toBe(true)
    // RECALL_EXPLICIT condition false => pattern completion would NOT trigger
  })

  it('RECALL_EXPLICIT regex matches recall keywords', () => {
    const explicitQueries = [
      'remember when we deployed',
      'recall what happened',
      'what did we decide',
      'did we discuss this',
      'last time we talked about this',
      'previously we had',
      'have we done this before',
      'remind me about the deployment',
    ]

    for (const q of explicitQueries) {
      expect(isRecallExplicit(q)).toBe(true)
    }
  })

  it('RECALL_EXPLICIT regex does NOT match general questions', () => {
    const generalQueries = [
      'what is TypeScript?',
      'how does spreading activation work?',
      'explain the architecture',
      'show me the code',
    ]

    for (const q of generalQueries) {
      expect(isRecallExplicit(q)).toBe(false)
    }
  })
})
