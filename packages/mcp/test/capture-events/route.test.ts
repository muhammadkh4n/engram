/**
 * runCaptureEventsRequest with a fake store: response counts across valid,
 * duplicate, invalid and scope-rejected events; a registered secret reaches
 * the store masked and as a hit; unregistered scope is stored NULL and
 * reported; nothing is stored before the registry syncs or while the secret
 * registry is degraded; a store failure is a retryable 500 whose log line
 * carries no row data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretRegistry, resetDefaultSecretRegistry } from '@engram-mem/core'
import type { IngestedEvent, SecretRegistryStatus, StoredEvent } from '@engram-mem/core'
import { parseProjectRegistry, type ProjectRegistry } from '../../src/capture-events/project-registry.js'
import { runCaptureEventsRequest, type CaptureEventsRouteDeps } from '../../src/capture-events/route.js'
import { RECEIVED_AT, envelope, validEvent } from './fixtures.js'

const TOKEN = ('c4' + randomBytes(24).toString('hex')).slice(0, 40)
const HEALTHY: SecretRegistryStatus = { configured: true, unreadable: [], values: 3 }

const REGISTRY: ProjectRegistry = parseProjectRegistry({
  version: 1,
  workspaces: { 'ws-test': { root: '~/work/ws-test', vault_folder: 'Sample Workspace', register_prefix: 'TSTW' } },
  projects: { 'sample-repo': { workspace: 'ws-test', vault_folder: 'Sample Repo', register_prefix: 'TST' } },
})

interface Harness {
  deps: CaptureEventsRouteDeps
  stored: StoredEvent[][]
  logs: string[]
}

function harness(
  opts: {
    duplicates?: ReadonlySet<string>
    ready?: ProjectRegistry | null
    status?: () => SecretRegistryStatus
    fail?: Error
  } = {},
): Harness {
  const stored: StoredEvent[][] = []
  const logs: string[] = []
  const ingestEvents = async (events: readonly StoredEvent[]): Promise<IngestedEvent[]> => {
    if (opts.fail) throw opts.fail
    stored.push([...events])
    return events.map((e, i) => ({
      eventId: String(100 + i),
      status: opts.duplicates?.has(e.eventUuid) ? 'duplicate' : 'accepted',
    }))
  }
  const deps: CaptureEventsRouteDeps = {
    store: { ingestEvents },
    ready: () => (opts.ready === undefined ? REGISTRY : opts.ready),
    status: opts.status ?? (() => HEALTHY),
    log: (line) => logs.push(line),
    now: () => RECEIVED_AT,
  }
  return { deps, stored, logs }
}

beforeEach(() => {
  vi.stubEnv('ENGRAM_SECRET_SOURCES_FILE', '')
  vi.stubEnv('ENGRAM_CAPTURE_TOKEN', TOKEN)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetDefaultSecretRegistry()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetDefaultSecretRegistry()
})

describe('runCaptureEventsRequest', () => {
  it('counts accepted, duplicate and rejected events, the counts summing to the batch', async () => {
    const invalid = validEvent('assistant_turn', 9)
    invalid.role = 'assistant'
    const events = [
      validEvent('user_prompt', 1),
      invalid,
      validEvent('git_commit', 2),
      validEvent('session_end', 3),
      validEvent('ledger_ruling', 4),
    ]
    const h = harness({ duplicates: new Set(['evt-session_end-3']) })

    const res = await runCaptureEventsRequest(h.deps, envelope(events))

    expect(res).toEqual({
      status: 200,
      body: {
        accepted: 3,
        duplicates: 1,
        rejected: [
          { index: 1, session_id: 'sess-a1', event_uuid: 'evt-assistant_turn-9', reason: 'unknown field(s): role' },
        ],
      },
    })
    expect(h.stored).toHaveLength(1)
    expect(h.stored[0]!.map((e) => e.eventUuid)).toEqual([
      'evt-user_prompt-1',
      'evt-git_commit-2',
      'evt-session_end-3',
      'evt-ledger_ruling-4',
    ])
    expect(h.stored[0]![0]).toMatchObject({
      sessionId: 'sess-a1',
      type: 'user_prompt',
      occurredAt: '2026-10-05T11:30:00Z',
      client: { name: 'sample-client', version: '1.0.0' },
      project: { id: 'sample-repo', workspace: 'ws-test', repo_root: '/home/dev/sample-repo', branch: 'main', worktree: null },
      scrub: { masked: [] },
      hits: [],
    })
  })

  it('stores a registered value masked and lists it as a hit, never by value', async () => {
    const prompt = validEvent('user_prompt')
    prompt.payload.text = `deploy with ${TOKEN} tonight`
    prompt.cwd = `/tmp/${TOKEN}`
    const h = harness()

    const res = await runCaptureEventsRequest(h.deps, envelope([prompt]))

    expect(res.body).toMatchObject({ accepted: 1, duplicates: 0, rejected: [] })
    const stored = h.stored[0]![0]!
    expect(stored.payload.text).toBe('deploy with [REDACTED:ENGRAM_CAPTURE_TOKEN] tonight')
    expect(stored.cwd).toBe('/tmp/[REDACTED:ENGRAM_CAPTURE_TOKEN]')
    expect(stored.hits).toEqual([
      { field: 'cwd', detector: 'known', secretName: 'ENGRAM_CAPTURE_TOKEN' },
      { field: 'payload.text', detector: 'known', secretName: 'ENGRAM_CAPTURE_TOKEN' },
    ])
    expect(stored.scrub.masked).toEqual([
      { field: 'cwd', detector: 'known', secret_name: 'ENGRAM_CAPTURE_TOKEN' },
      { field: 'payload.text', detector: 'known', secret_name: 'ENGRAM_CAPTURE_TOKEN' },
    ])
    expect(JSON.stringify(h.stored)).not.toContain(TOKEN)
  })

  it('stores an unregistered project as NULL and reports the sent id', async () => {
    const worktree = validEvent('user_prompt')
    worktree.project = { ...(worktree.project as object), id: 'sample-repo-feature', workspace: 'ws-unknown' }
    const h = harness()

    await runCaptureEventsRequest(h.deps, envelope([worktree]))

    const stored = h.stored[0]![0]!
    expect(stored.project).toMatchObject({ id: null, workspace: null, repo_root: '/home/dev/sample-repo' })
    expect(stored.scrub).toEqual({
      masked: [],
      project_rejected: 'sample-repo-feature',
      workspace_rejected: 'ws-unknown',
    })
  })

  it('rejects a register entry whose scope does not match the registry, storing the rest', async () => {
    const entry = validEvent('register_entry')
    entry.payload.id = 'R-TSTX-4'
    const h = harness()

    const res = await runCaptureEventsRequest(h.deps, envelope([validEvent('user_prompt'), entry]))

    expect(res.body).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [
        {
          index: 1,
          session_id: 'sess-a1',
          event_uuid: 'evt-register_entry-1',
          reason: "payload.scope: names no registry project with the entry id's prefix",
        },
      ],
    })
  })

  it('makes no store call when every event is rejected', async () => {
    const bad = validEvent('user_prompt')
    bad.occurred_at = '2019-12-31T23:59:59Z'
    const h = harness()

    const res = await runCaptureEventsRequest(h.deps, envelope([bad]))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ accepted: 0, duplicates: 0 })
    expect(h.stored).toHaveLength(0)
  })

  it('answers 400 to a bad envelope, storing nothing', async () => {
    const h = harness()
    const res = await runCaptureEventsRequest(h.deps, { ...envelope([validEvent('user_prompt')]), dry_run: true })
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
    expect(h.stored).toHaveLength(0)
  })

  it('answers 503 before the project registry syncs', async () => {
    const h = harness({ ready: null })
    const res = await runCaptureEventsRequest(h.deps, envelope([validEvent('user_prompt')]))
    expect(res).toEqual({ status: 503, body: { error: expect.any(String), retryable: true } })
    expect(h.stored).toHaveLength(0)
  })

  it('answers 503 while the secret registry is degraded, logging each change once', async () => {
    let status: SecretRegistryStatus = { configured: true, unreadable: ['/etc/engram/sources/db.env'], values: 2 }
    const h = harness({ status: () => status })
    const body = envelope([validEvent('user_prompt')])

    expect((await runCaptureEventsRequest(h.deps, body)).status).toBe(503)
    expect((await runCaptureEventsRequest(h.deps, body)).status).toBe(503)
    status = { configured: false, unreadable: [], values: 2 }
    expect((await runCaptureEventsRequest(h.deps, body)).status).toBe(503)
    status = HEALTHY
    expect((await runCaptureEventsRequest(h.deps, body)).status).toBe(200)

    expect(h.logs).toEqual([
      'capture events refused until the secret registry recovers: the secret registry could not read: /etc/engram/sources/db.env',
      'capture events refused until the secret registry recovers: the secret registry read no sources configuration',
      'capture events: the secret registry recovered',
    ])
    expect(h.stored).toHaveLength(1)
  })

  // A mode-000 directory is still readable by root.
  it.skipIf(process.getuid?.() === 0)('answers 503 while a source directory of the secret registry is unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-capture-route-'))
    const lockedDir = join(dir, 'locked')
    mkdirSync(lockedDir)
    writeFileSync(join(lockedDir, 'app.env'), `API_TOKEN=${TOKEN}-locked\n`)
    chmodSync(lockedDir, 0o000)
    try {
      writeFileSync(join(dir, 'sources.json'), JSON.stringify({ sources: [{ path: 'locked/*.env', format: 'dotenv' }] }))
      const secrets = createSecretRegistry({ configPath: join(dir, 'sources.json'), log: () => {} })
      const h = harness({ status: () => secrets.status() })
      const res = await runCaptureEventsRequest(h.deps, envelope([validEvent('user_prompt')]))
      expect(res).toEqual({ status: 503, body: { error: expect.any(String), retryable: true } })
      expect(h.stored).toHaveLength(0)
      expect(h.logs).toEqual([
        `capture events refused until the secret registry recovers: the secret registry could not read: ${lockedDir}`,
      ])
    } finally {
      chmodSync(lockedDir, 0o755)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers a store failure with a retryable 500, logging code and message only', async () => {
    const failure = Object.assign(new Error('ingestEvents failed (08006): connection lost'), {
      code: '08006',
      details: 'Failing row contains (secret row data)',
    })
    const h = harness({ fail: failure })

    const res = await runCaptureEventsRequest(h.deps, envelope([validEvent('user_prompt')]))

    expect(res).toEqual({ status: 500, body: { error: 'capture events failed; retry later', retryable: true } })
    expect(h.logs).toEqual(['capture events: store failed: 08006 ingestEvents failed (08006): connection lost'])
    expect(h.logs.join('\n')).not.toContain('secret row data')
  })
})
