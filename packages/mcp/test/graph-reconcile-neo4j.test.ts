import { describe, it, expect } from 'vitest'
import { encodeEdgeProps, restoreContextCypher, splitEdgeProps } from '../src/graph-reconcile-neo4j.js'

/** Shaped like a neo4j-driver Integer: what the driver returns for an integer property. */
const driverInt = (n: number) => ({ low: n, high: 0, toNumber: () => n, toString: () => String(n) })

describe('encodeEdgeProps', () => {
  it('logs integers losslessly and keeps strings, floats, booleans and scalar lists as they are', () => {
    const encoded = encodeEdgeProps({
      weight: 0.42,
      createdAt: '2026-09-01T00:00:00Z',
      traversalCount: driverInt(3),
      pinned: true,
      tags: ['a', 'b'],
    })

    expect(JSON.parse(JSON.stringify(encoded))).toEqual({
      weight: 0.42,
      createdAt: '2026-09-01T00:00:00Z',
      traversalCount: { $int: '3' },
      pinned: true,
      tags: ['a', 'b'],
    })
  })

  it('refuses a property type the undo could not write back', () => {
    expect(() => encodeEdgeProps({ at: { year: driverInt(2026), month: driverInt(9) } })).toThrow(/"at"/)
    expect(() => encodeEdgeProps({ counts: [driverInt(1)] })).toThrow(/"counts"/)
  })
})

describe('splitEdgeProps', () => {
  it('separates logged integers from plain values', () => {
    const logged = JSON.parse(JSON.stringify(encodeEdgeProps({ weight: 1, traversalCount: driverInt(7) })))

    expect(splitEdgeProps(logged)).toEqual({ plain: { weight: 1 }, ints: { traversalCount: '7' } })
  })

  it('treats a map that is not an integer tag as a plain value', () => {
    expect(splitEdgeProps({ x: { $int: 'abc' } })).toEqual({ plain: { x: { $int: 'abc' } }, ints: {} })
  })
})

describe('restoreContextCypher', () => {
  it('merges the edge, replaces its properties and sets each integer through toInteger', () => {
    const cypher = restoreContextCypher('Person', ['traversalCount', 'odd`key', 'traversalCount'])

    expect(cypher).toContain('MATCH (ctx:Person {id: row.ctxNodeId})')
    expect(cypher).not.toContain('elementId')
    expect(cypher).toContain('MERGE (m)-[r:CONTEXTUAL]->(ctx)')
    expect(cypher).toContain('SET r = row.plain')
    expect(cypher.match(/toInteger\(row\.ints\.`traversalCount`\)/g)).toHaveLength(1)
    expect(cypher).toContain('SET r.`odd``key` = toInteger(row.ints.`odd``key`)')
  })

  it('sets no integer when the batch has none', () => {
    expect(restoreContextCypher('Topic', [])).not.toContain('toInteger')
  })

  it('refuses a label outside Person, Entity and Topic', () => {
    expect(() => restoreContextCypher('Memory' as never, [])).toThrow(/unknown context label/)
  })
})
