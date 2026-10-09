import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createSecretRegistry, resetDefaultSecretRegistry } from '@engram-mem/core'
import type { CaptureStore, ScanRow, ScanTarget, SecretRegistry } from '@engram-mem/core'
import { runSecretScan, runSecretScanCli, SECRET_SCAN_PAGE_SIZE } from '../../src/capture-events/secret-scan-cli.js'
import { CAPTURE_SERVER_REQUIRED_ENV } from '../../src/capture-events/server-env.js'

const VALUE = ('e6' + randomBytes(24).toString('hex')).slice(0, 32)
const ITEM_ID = '00000000-0000-4000-8000-0000000000c3'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-secret-scan-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A registry configured from a temp `json-keys` source holding one secret. */
function registry(): SecretRegistry {
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ DEPLOY_TOKEN: VALUE }))
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
  return createSecretRegistry({ configPath: join(dir, 'sources.json'), log: () => {} })
}

function fakeStore(tables: Partial<Record<ScanTarget, ScanRow[]>>) {
  const reads: Array<{ target: ScanTarget; afterId: string | null; limit: number }> = []
  const store: Pick<CaptureStore, 'scanPage'> = {
    scanPage: vi.fn(async (target: ScanTarget, afterId: string | null, limit: number) => {
      reads.push({ target, afterId, limit })
      const rows = tables[target] ?? []
      const from = afterId === null ? 0 : rows.findIndex((r) => r.id === afterId) + 1
      return rows.slice(from, from + limit)
    }),
  }
  return { store, reads }
}

async function run(store: Pick<CaptureStore, 'scanPage'>, reg: SecretRegistry) {
  const out: string[] = []
  const err: string[] = []
  const code = await runSecretScan(store, reg, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out, err }
}

describe('engram-secret-scan', () => {
  it('counts a registered value in an item context under its name and exits 3', async () => {
    const { store } = fakeStore({
      memory_items: [{ id: ITEM_ID, texts: ['plain content', `the deploy used ${VALUE} once`, 'search text'] }],
      memory_capture_events: [{ id: '7', texts: ['nothing here'] }],
    })
    const { code, out, err } = await run(store, registry())
    expect(code).toBe(3)
    expect(out).toEqual([
      'memory_items scanned=1 matches=1',
      'memory_capture_events scanned=1 matches=0',
      `secret DEPLOY_TOKEN matches=1 ids=memory_items:${ITEM_ID}`,
      'stored secrets: 1',
    ])
    expect(err).toEqual([])
    expect([...out, ...err].join('\n')).not.toContain(VALUE)
  })

  it('exits 0 on clean tables and pages through every row', async () => {
    const events = Array.from({ length: SECRET_SCAN_PAGE_SIZE + 2 }, (_, i) => ({ id: String(i + 1), texts: ['clean'] }))
    const { store, reads } = fakeStore({ memory_capture_events: events })
    const { code, out } = await run(store, registry())
    expect(code).toBe(0)
    expect(out).toEqual([
      'memory_items scanned=0 matches=0',
      `memory_capture_events scanned=${SECRET_SCAN_PAGE_SIZE + 2} matches=0`,
      'stored secrets: 0',
    ])
    expect(reads).toEqual([
      { target: 'memory_items', afterId: null, limit: SECRET_SCAN_PAGE_SIZE },
      { target: 'memory_capture_events', afterId: null, limit: SECRET_SCAN_PAGE_SIZE },
      { target: 'memory_capture_events', afterId: String(SECRET_SCAN_PAGE_SIZE), limit: SECRET_SCAN_PAGE_SIZE },
    ])
  })

  it('refuses a degraded registry before reading any page and exits 1', async () => {
    const configDir = join(dir, 'sources-dir')
    mkdirSync(configDir)
    const degraded = createSecretRegistry({ configPath: configDir, log: () => {} })
    const { store, reads } = fakeStore({ memory_items: [{ id: ITEM_ID, texts: [VALUE] }] })
    const { code, out, err } = await run(store, degraded)
    expect(code).toBe(1)
    expect(reads).toEqual([])
    expect(out).toEqual([])
    expect(err.join('\n')).toContain(configDir)
  })

  // A mode-000 directory is still readable by root.
  it.skipIf(process.getuid?.() === 0)('refuses a registry whose source directory is unreadable, naming it', async () => {
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ DEPLOY_TOKEN: VALUE }))
    const lockedDir = join(dir, 'locked')
    mkdirSync(lockedDir)
    writeFileSync(join(lockedDir, 'app.env'), `API_TOKEN=${VALUE}-locked\n`)
    chmodSync(lockedDir, 0o000)
    try {
      writeFileSync(
        join(dir, 'sources.json'),
        JSON.stringify({
          sources: [
            { path: 'secrets.json', format: 'json-keys' },
            { path: 'locked/*.env', format: 'dotenv' },
          ],
        }),
      )
      const reg = createSecretRegistry({ configPath: join(dir, 'sources.json'), log: () => {} })
      expect(reg.status().values).toBeGreaterThan(0)
      const { store, reads } = fakeStore({ memory_items: [{ id: ITEM_ID, texts: [VALUE] }] })
      const { code, out, err } = await run(store, reg)
      expect(code).toBe(1)
      expect(reads).toEqual([])
      expect(out).toEqual([])
      expect(err.join('\n')).toContain(lockedDir)
    } finally {
      chmodSync(lockedDir, 0o755)
    }
  })

  it('refuses a registry with no configuration, or one holding no value', async () => {
    const { store, reads } = fakeStore({})
    const unconfigured = createSecretRegistry({ configPath: undefined, values: [{ name: 'X_TOKEN', value: VALUE }], log: () => {} })
    expect((await run(store, unconfigured)).code).toBe(1)
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ sources: [] }))
    const empty = createSecretRegistry({ configPath: join(dir, 'empty.json'), log: () => {} })
    const result = await run(store, empty)
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('holds no value')
    expect(reads).toEqual([])
  })

  it('exits 1 on a store error without printing a stored text', async () => {
    const store: Pick<CaptureStore, 'scanPage'> = {
      scanPage: vi.fn(async () => {
        throw new Error('scanPage failed (42501): permission denied for table memory_items')
      }),
    }
    const { code, out, err } = await run(store, registry())
    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err).toEqual(['engram-secret-scan: failed: scanPage failed (42501): permission denied for table memory_items'])
  })
})

describe('engram-secret-scan from the environment', () => {
  const CAPTURE_TOKEN = ('c7' + randomBytes(24).toString('hex')).slice(0, 40)
  const BEARER = ('b8' + randomBytes(24).toString('hex')).slice(0, 40)

  /** The env a capture-enabled server runs with; the registry reads process.env, so it is stubbed. */
  function stubServerEnv(overrides: Record<string, string | undefined> = {}): void {
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ DEPLOY_TOKEN: VALUE }))
    writeFileSync(join(dir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
    const env: Record<string, string | undefined> = {
      XDG_CACHE_HOME: join(dir, 'cache'),
      BEARER_TOKEN: BEARER,
      ENGRAM_CAPTURE_TOKEN: CAPTURE_TOKEN,
      ENGRAM_PROJECT_REGISTRY_FILE: join(dir, 'projects.json'),
      ENGRAM_SECRET_SOURCES_FILE: join(dir, 'sources.json'),
      SUPABASE_URL: 'http://127.0.0.1:3000',
      SUPABASE_KEY: ('d4' + randomBytes(24).toString('hex')).slice(0, 40),
      OPENAI_API_KEY: ('a9' + randomBytes(24).toString('hex')).slice(0, 40),
      SUPABASE_SERVICE_KEY: '',
      ENGRAM_DOCUMENTS_TOKEN: '',
      NEO4J_PASSWORD: '',
      ENGRAM_CHAT_API_KEY: '',
      ENGRAM_SERVER_TOKEN: '',
      ...overrides,
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    resetDefaultSecretRegistry()
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    resetDefaultSecretRegistry()
  })

  async function runCli(store: Pick<CaptureStore, 'scanPage'>) {
    const out: string[] = []
    const err: string[] = []
    const urls: string[] = []
    const code = await runSecretScanCli({
      createStore: (url) => {
        urls.push(url)
        return store
      },
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    })
    return { code, out, err, urls }
  }

  it('shares one required list with the server, the capture token and the bearer token included', () => {
    expect(CAPTURE_SERVER_REQUIRED_ENV).toEqual(
      expect.arrayContaining(['BEARER_TOKEN', 'ENGRAM_CAPTURE_TOKEN', 'OPENAI_API_KEY', 'SUPABASE_KEY', 'ENGRAM_SECRET_SOURCES_FILE']),
    )
  })

  it('exits 1 without reading a page when ENGRAM_CAPTURE_TOKEN is unset, naming it and the fix', async () => {
    stubServerEnv({ ENGRAM_CAPTURE_TOKEN: undefined, BEARER_TOKEN: '' })
    const { store, reads } = fakeStore({ memory_items: [{ id: ITEM_ID, texts: [VALUE] }] })
    const { code, out, err, urls } = await runCli(store)
    expect(code).toBe(1)
    expect(reads).toEqual([])
    expect(urls).toEqual([])
    expect(out).toEqual([])
    const message = err.join('\n')
    expect(message).toContain('ENGRAM_CAPTURE_TOKEN')
    expect(message).toContain('BEARER_TOKEN')
    expect(message).not.toContain('OPENAI_API_KEY')
    expect(message).toContain('node --env-file=')
  })

  it('with the full list set, counts a stored copy of the capture token under its name and lists the registered names', async () => {
    stubServerEnv()
    const { store } = fakeStore({
      memory_capture_events: [{ id: '9', texts: [`curl -H "X-Token: ${CAPTURE_TOKEN}" localhost`] }],
    })
    const { code, out, err, urls } = await runCli(store)
    expect(err).toEqual([])
    expect(urls).toEqual(['http://127.0.0.1:3000'])
    expect(code).toBe(3)
    expect(out).toEqual([
      'memory_items scanned=0 matches=0',
      'memory_capture_events scanned=1 matches=1',
      'secret ENGRAM_CAPTURE_TOKEN matches=1 ids=memory_capture_events:9',
      'stored secrets: 1',
      'process credentials registered: SUPABASE_KEY,OPENAI_API_KEY,BEARER_TOKEN,ENGRAM_CAPTURE_TOKEN',
    ])
    const printed = [...out, ...err].join('\n')
    expect(printed).not.toContain(CAPTURE_TOKEN)
    expect(printed).not.toContain(BEARER)
  })
})
