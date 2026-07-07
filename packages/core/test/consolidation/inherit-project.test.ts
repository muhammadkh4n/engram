import { describe, it, expect } from 'vitest'
import { majorityProjectId } from '../../src/consolidation/inherit-project.js'

describe('majorityProjectId', () => {
  it('returns null for an empty list', () => {
    expect(majorityProjectId([])).toBeNull()
  })

  it('returns null when every source is untagged', () => {
    expect(majorityProjectId([null, undefined, null])).toBeNull()
  })

  it('returns the single project when all sources agree', () => {
    expect(majorityProjectId(['engram', 'engram'])).toBe('engram')
  })

  it('returns the majority project across mixed sources', () => {
    expect(majorityProjectId(['ouija', 'engram', 'engram'])).toBe('engram')
  })

  it('ignores untagged sources when a tagged majority exists', () => {
    expect(majorityProjectId([null, 'engram', undefined])).toBe('engram')
  })

  it('resolves ties to the first project encountered', () => {
    expect(majorityProjectId(['ouija', 'engram'])).toBe('ouija')
  })
})
