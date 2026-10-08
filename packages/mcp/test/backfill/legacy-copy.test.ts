/**
 * The legacy copy scrubs with the process-wide secret registry, so it must
 * refuse whenever that registry cannot be trusted: a registered value would
 * otherwise be copied in clear, and stored content can never be rewritten.
 */
import { describe, expect, it } from 'vitest'
import type { SecretRegistryStatus } from '@engram-mem/core'
import {
  planLegacyProjects,
  runLegacyCopy,
  type LegacyCopyRow,
  type LegacyCopyStore,
  type LegacyStep,
} from '../../src/backfill/legacy-copy.js'

const HEALTHY: SecretRegistryStatus = { configured: true, unreadable: [], values: 1 }
const UNCONFIGURED: SecretRegistryStatus = { configured: false, unreadable: [], values: 0 }
const UNREADABLE: SecretRegistryStatus = { configured: false, unreadable: ['/srv/engram/sources.json'], values: 0 }

/** Episodes pending in batches of `perBatch`; every other step has nothing left. */
function fakeStore(episodes: number): { store: LegacyCopyStore; sent: LegacyCopyRow[][] } {
  let left = episodes
  let next = 0
  const sent: LegacyCopyRow[][] = []
  const store: LegacyCopyStore = {
    projectValues: async (table) => new Map(table === 'memory_episodes' ? [['tst-app', episodes]] : []),
    proceduralRows: async () => 0,
    pendingCount: async (step: LegacyStep) => (step === 'episodes' ? left : 0),
    pending: async (step, limit) => {
      if (step !== 'episodes') return []
      return Array.from({ length: Math.min(limit, left) }, () => ({
        id: `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`,
        text: 'an old note',
      }))
    },
    copy: async (step, _map, rows) => {
      if (rows === null) return { step, copied: 0, remaining: 0 }
      sent.push(rows)
      left -= rows.length
      return { step, copied: rows.length, remaining: left }
    },
  }
  return { store, sent }
}

const MAP = { 'tst-app': { project_id: 'tst-app', workspace_id: 'tst-ws' } }

function options(store: LegacyCopyStore, status: () => SecretRegistryStatus, apply = true) {
  return { store, map: MAP, projects: [], apply, log: () => {}, batchRows: 2, status }
}

describe('the legacy copy and the secret registry', () => {
  it('names the reason in the plan when the registry read no sources configuration', async () => {
    const { store } = fakeStore(1)
    const plan = await planLegacyProjects(store, () => ({ project_id: null, workspace_id: null, rule: 'unregistered' }), () => UNCONFIGURED)
    expect(plan.copy_refused).toMatch(/no sources configuration/)
  })

  it('plans with no refusal while the registry is healthy', async () => {
    const { store } = fakeStore(1)
    const plan = await planLegacyProjects(store, () => ({ project_id: null, workspace_id: null, rule: 'unregistered' }), () => HEALTHY)
    expect(plan.copy_refused).toBeNull()
  })

  it.each([
    ['unset', UNCONFIGURED, /no sources configuration/],
    ['unreadable', UNREADABLE, /could not read: \/srv\/engram\/sources\.json/],
  ])('refuses before the first batch when the sources file is %s, with or without --apply', async (_name, status, reason) => {
    for (const apply of [true, false]) {
      const { store, sent } = fakeStore(3)
      const summary = await runLegacyCopy(options(store, () => status, apply))
      expect(summary.refused).toMatch(reason)
      expect(summary.steps).toEqual([])
      expect(sent).toEqual([])
    }
  })

  it('refuses before a later batch once the registry degrades, keeping the counts so far', async () => {
    const { store, sent } = fakeStore(5)
    let calls = 0
    // Healthy for the first batch's two checks, degraded from the second batch on.
    const summary = await runLegacyCopy(options(store, () => (++calls <= 3 ? HEALTHY : UNREADABLE)))
    expect(summary.refused).toMatch(/could not read/)
    expect(sent.map((b) => b.length)).toEqual([2])
    expect(summary.steps).toEqual([expect.objectContaining({ step: 'episodes', copied: 2, sent: 2, remaining: 3 })])
  })

  it('does not send a batch the registry degraded under while it was scrubbed', async () => {
    const { store, sent } = fakeStore(2)
    let calls = 0
    const summary = await runLegacyCopy(options(store, () => (++calls <= 2 ? HEALTHY : UNREADABLE)))
    expect(summary.refused).toMatch(/could not read/)
    expect(sent).toEqual([])
    expect(summary.steps).toEqual([expect.objectContaining({ step: 'episodes', copied: 0, sent: 0 })])
  })

  it('copies every step while the registry stays healthy', async () => {
    const { store, sent } = fakeStore(5)
    const summary = await runLegacyCopy(options(store, () => HEALTHY))
    expect(summary.refused).toBeNull()
    expect(sent.map((b) => b.length)).toEqual([2, 2, 1])
    expect(summary.steps.map((s) => s.step)).toEqual(['episodes', 'digests', 'facts', 'fact_supersession', 'forgets'])
  })
})
