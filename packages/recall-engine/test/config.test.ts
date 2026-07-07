import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configFromEnv } from '../src/config.js'

const KEYS = [
  'ENGRAM_RECALL_ENGINE',
  'ENGRAM_ENGINE_BITS',
  'ENGRAM_ENGINE_TIER1_M',
  'ENGRAM_ENGINE_EXACT',
  'ENGRAM_ENGINE_SNAPSHOT_DIR',
  'ENGRAM_ENGINE_RECONCILE_MS',
  'ENGRAM_ENGINE_MAX_N',
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.restoreAllMocks()
})

describe('configFromEnv', () => {
  it('returns null unless ENGRAM_RECALL_ENGINE === "true"', () => {
    expect(configFromEnv()).toBeNull()
    process.env['ENGRAM_RECALL_ENGINE'] = 'false'
    expect(configFromEnv()).toBeNull()
    process.env['ENGRAM_RECALL_ENGINE'] = '1' // strict equality, not truthiness
    expect(configFromEnv()).toBeNull()
    process.env['ENGRAM_RECALL_ENGINE'] = 'true'
    expect(configFromEnv()).not.toBeNull()
  })

  it('enabled with nothing else set returns an empty opts object (engine owns all defaults)', () => {
    process.env['ENGRAM_RECALL_ENGINE'] = 'true'
    expect(configFromEnv()).toEqual({})
  })

  it('parses every valid value', () => {
    process.env['ENGRAM_RECALL_ENGINE'] = 'true'
    process.env['ENGRAM_ENGINE_BITS'] = '3'
    process.env['ENGRAM_ENGINE_TIER1_M'] = '1024'
    process.env['ENGRAM_ENGINE_EXACT'] = 'false'
    process.env['ENGRAM_ENGINE_SNAPSHOT_DIR'] = '/tmp/engine-cache'
    process.env['ENGRAM_ENGINE_RECONCILE_MS'] = '30000'
    process.env['ENGRAM_ENGINE_MAX_N'] = '500000'

    expect(configFromEnv()).toEqual({
      bits: 3,
      tier1M: 1024,
      exactRescore: false,
      snapshotDir: '/tmp/engine-cache',
      reconcileMs: 30000,
      maxVectors: 500000,
    })
  })

  it('empty ENGRAM_ENGINE_SNAPSHOT_DIR disables snapshotting (null)', () => {
    process.env['ENGRAM_RECALL_ENGINE'] = 'true'
    process.env['ENGRAM_ENGINE_SNAPSHOT_DIR'] = ''
    expect(configFromEnv()).toEqual({ snapshotDir: null })
  })

  it('invalid values warn and fall back to the default (field omitted), never throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env['ENGRAM_RECALL_ENGINE'] = 'true'
    process.env['ENGRAM_ENGINE_BITS'] = '9'
    process.env['ENGRAM_ENGINE_TIER1_M'] = '-4'
    process.env['ENGRAM_ENGINE_EXACT'] = 'yes'
    process.env['ENGRAM_ENGINE_RECONCILE_MS'] = 'soon'
    process.env['ENGRAM_ENGINE_MAX_N'] = '0'

    expect(configFromEnv()).toEqual({})
    expect(warn).toHaveBeenCalledTimes(5)
  })
})
