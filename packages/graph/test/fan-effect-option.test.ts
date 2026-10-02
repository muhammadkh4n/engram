import { afterEach, describe, it, expect, vi } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import { runPatternCompletion } from '../src/pattern-completion.js'
import type { ActivationParams } from '../src/types.js'

// The driver connects lazily: no query reaches Neo4j because
// activate is stubbed and fewer than two Memory nodes skip the Community pass.
function offlineGraph(): NeuralGraph {
  return new NeuralGraph({ neo4jUri: 'bolt://127.0.0.1:1', neo4jUser: 'u', neo4jPassword: 'p', enabled: true })
}

describe('NeuralGraph.spreadActivation fanEffect forwarding (unit, no Neo4j)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function forwardedParams(fanEffect?: boolean): Promise<ActivationParams> {
    const activate = vi.spyOn(SpreadingActivation.prototype, 'activate').mockResolvedValue([])
    const graph = offlineGraph()
    try {
      await graph.spreadActivation({
        seedNodeIds: ['a'],
        ...(fanEffect !== undefined ? { fanEffect } : {}),
      })
    } finally {
      await graph.dispose()
    }
    expect(activate).toHaveBeenCalledTimes(1)
    const params = activate.mock.calls[0]![1] as ActivationParams
    activate.mockRestore()
    return params
  }

  it('passes fanEffect true through to the activation params', async () => {
    expect((await forwardedParams(true)).fanEffect).toBe(true)
  })

  it('leaves the params without fanEffect when unset or false', async () => {
    expect(await forwardedParams()).not.toHaveProperty('fanEffect')
    expect(await forwardedParams(false)).not.toHaveProperty('fanEffect')
  })
})

describe('runPatternCompletion spreads without the fan effect', () => {
  it('sends no fanEffect on any attribute group', async () => {
    const spreadActivation = vi.fn().mockResolvedValue([])
    const graph = {
      findMatchingContextNodes: vi.fn().mockResolvedValue([
        { attributeType: 'topic', nodeIds: ['topic:auth'] },
        { attributeType: 'person', nodeIds: ['person:mk'] },
      ]),
      spreadActivation,
    } as unknown as NeuralGraph

    await runPatternCompletion(graph, { entities: [], emotions: [], persons: ['MK'], topics: ['auth'] })

    expect(spreadActivation).toHaveBeenCalledTimes(2)
    for (const [opts] of spreadActivation.mock.calls) {
      expect(opts).not.toHaveProperty('fanEffect')
    }
  })
})
