import { afterEach, describe, expect, it } from 'vitest'
import type { IntelligenceAdapter } from '@engram-mem/core'
import { buildIntelligence, type ArmModules } from '../src/replay/replay-stack.js'

function fakeMods(withTimeZone: boolean): { mods: ArmModules; built: Array<Record<string, unknown>> } {
  const built: Array<Record<string, unknown>> = []
  const mods = {
    openaiIntelligence: (opts: Record<string, unknown>) => (built.push(opts), {} as IntelligenceAdapter),
    ...(withTimeZone
      ? { parseTimeZoneEnv: (env: NodeJS.ProcessEnv) => ({ timeZone: env['ENGRAM_TIMEZONE']?.trim() || 'UTC' }) }
      : {}),
  } as unknown as ArmModules
  return { mods, built }
}

describe('buildIntelligence time zone', () => {
  const saved = process.env['ENGRAM_TIMEZONE']
  afterEach(() => {
    if (saved === undefined) delete process.env['ENGRAM_TIMEZONE']
    else process.env['ENGRAM_TIMEZONE'] = saved
  })

  it('passes the arm build its ENGRAM_TIMEZONE as the server does', () => {
    process.env['ENGRAM_TIMEZONE'] = 'Asia/Karachi'
    const { mods, built } = fakeMods(true)
    buildIntelligence(mods, true)
    expect(built[0]).toMatchObject({ timeZone: 'Asia/Karachi' })
  })

  it('refuses ENGRAM_TIMEZONE for a build that has no time zone setting', () => {
    process.env['ENGRAM_TIMEZONE'] = 'Asia/Karachi'
    expect(() => buildIntelligence(fakeMods(false).mods, true)).toThrow(/ENGRAM_TIMEZONE is set but this engram build/)
  })

  it('builds an older arm unchanged when ENGRAM_TIMEZONE is unset', () => {
    delete process.env['ENGRAM_TIMEZONE']
    const { mods, built } = fakeMods(false)
    buildIntelligence(mods, true)
    expect('timeZone' in built[0]!).toBe(false)
  })
})
