import { describe, it, expect } from 'vitest'
import { namedEntities } from '../../src/consolidation/named-entities.js'

function matches(text: string, name: string): boolean {
  return namedEntities(text, [{ id: 'x', name }]).ids.includes('x')
}

describe('namedEntities', () => {
  describe('prod-shaped names', () => {
    it('matches a hyphenated model id', () => {
      expect(matches('Swapped the reranker to gte-reranker-modernbert-base q8.', 'gte-reranker-modernbert-base')).toBe(true)
    })

    it('matches a ticket key written with a space instead of a hyphen', () => {
      expect(matches('Opened aca 2613 for the export header.', 'ACA-2613')).toBe(true)
      expect(matches('ACA-2613: export header fix', 'ACA-2613')).toBe(true)
    })

    it('does not match a ticket key with a different number', () => {
      expect(matches('ACA-26130 is unrelated', 'ACA-2613')).toBe(false)
    })

    it('matches a scoped package name', () => {
      expect(matches('Bumped @aithentic/data-grid to 3.1.0', '@aithentic/data-grid')).toBe(true)
    })

    it('does not match a scoped package when only part of it appears', () => {
      expect(matches('the data grid toolbar', '@aithentic/data-grid')).toBe(false)
    })

    it('matches a plan path', () => {
      expect(
        matches(
          'Read plans/aca-2330-portfolio-installs-drilldown/notes first.',
          'plans/aca-2330-portfolio-installs-drilldown',
        ),
      ).toBe(true)
    })

    it('matches a camel-cased product name case-insensitively', () => {
      expect(matches('postgrest returned a 406', 'PostgREST')).toBe(true)
    })

    it('matches a person named in a possessive', () => {
      expect(matches("Kam's review asked for a rename", 'Kam')).toBe(true)
    })

    it('does not match a person name inside a longer word', () => {
      expect(matches('Kamal approved it', 'Kam')).toBe(false)
    })

    it('matches a PR reference and a sprint name', () => {
      expect(matches('Merged in PR #986 last night', 'PR #986')).toBe(true)
      expect(matches('Planned for sprint 12.', 'Sprint 12')).toBe(true)
      expect(matches('Planned for sprint 120.', 'Sprint 12')).toBe(false)
    })

    it('does not match "PR" inside "PRs"', () => {
      expect(matches('Two PRs are waiting on review', 'PR')).toBe(false)
      expect(matches('The PR is waiting on review', 'PR')).toBe(true)
    })

    it('matches node-stress but not inside node-stressful', () => {
      expect(matches('Deployed node-stress to dev', 'node-stress')).toBe(true)
      expect(matches('node stress resolvers', 'node-stress')).toBe(true)
      expect(matches('a node-stressful afternoon', 'node-stress')).toBe(false)
    })

    it('matches a name in another script after NFKC and lowercasing', () => {
      expect(matches('Notes from ÜNÏCØDÉ sync', 'Ünïcødé')).toBe(true)
      expect(matches('Notes from Unicode sync', 'Ünïcødé')).toBe(false)
    })

    it('applies NFKC so compatibility forms match', () => {
      expect(matches('ﬁle watcher restarted', 'file watcher')).toBe(true)
      expect(matches('Ｋａｍ signed off', 'Kam')).toBe(true)
    })

    it('matches across line breaks and repeated punctuation', () => {
      expect(matches('ran\n\nnode -- stress\tagain', 'node-stress')).toBe(true)
    })
  })

  describe('names that never match', () => {
    it('skips a name that normalises to a single character', () => {
      const result = namedEntities('Rewrote the parser in C++ and c', [{ id: 'cpp', name: 'C++' }])
      expect(result.ids).toEqual([])
      expect(result.skipped).toBe(1)
    })

    it('skips a name that normalises to empty', () => {
      const result = namedEntities('-- ** --', [
        { id: 'punct', name: '***' },
        { id: 'blank', name: '   ' },
      ])
      expect(result.ids).toEqual([])
      expect(result.skipped).toBe(2)
    })

    it('does not count names it could match in skipped', () => {
      const result = namedEntities('nothing relevant here', [{ id: 'kam', name: 'Kam' }])
      expect(result).toEqual({ ids: [], skipped: 0 })
    })

    it('does not match against empty text', () => {
      expect(namedEntities('', [{ id: 'kam', name: 'Kam' }]).ids).toEqual([])
    })
  })

  describe('result order', () => {
    it('returns ids in candidate order, not text order', () => {
      const result = namedEntities('Kam deployed node-stress after ACA-2613 merged', [
        { id: 'ticket', name: 'ACA-2613' },
        { id: 'person', name: 'Kam' },
        { id: 'missing', name: 'PostgREST' },
        { id: 'repo', name: 'node-stress' },
      ])
      expect(result.ids).toEqual(['ticket', 'person', 'repo'])
    })

    it('returns each id once when it appears under several names', () => {
      const result = namedEntities('node-stress and node stress again; Kam too', [
        { id: 'repo', name: 'node-stress' },
        { id: 'person', name: 'Kam' },
        { id: 'repo', name: 'aithentic-node-stress' },
        { id: 'repo', name: 'node stress' },
      ])
      expect(result.ids).toEqual(['repo', 'person'])
    })

    it('returns an empty list for no candidates', () => {
      expect(namedEntities('anything', [])).toEqual({ ids: [], skipped: 0 })
    })
  })
})
