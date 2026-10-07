/**
 * captureEventsConfigFromEnv: off while ENGRAM_CAPTURE_TOKEN is unset; with
 * it set, every variable the route needs is required by name and the project
 * registry must load, so the server never starts with a route that can only
 * answer 503. documentsConfigFromEnv follows the same rule for
 * ENGRAM_DOCUMENTS_TOKEN.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureEventsConfigFromEnv, documentsConfigFromEnv } from '../src/http-server.js'

let dir: string
let registryFile: string
let badRegistryFile: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-index-http-'))
  registryFile = join(dir, 'projects.json')
  writeFileSync(
    registryFile,
    JSON.stringify({
      version: 1,
      workspaces: { 'ws-test': { root: '~/work/ws-test', vault_folder: null, register_prefix: null } },
      projects: { 'sample-repo': { workspace: 'ws-test', vault_folder: null, register_prefix: 'TST' } },
    }),
  )
  badRegistryFile = join(dir, 'bad.json')
  writeFileSync(badRegistryFile, JSON.stringify({ version: 2, workspaces: {}, projects: {} }))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    BEARER_TOKEN: 'b'.repeat(32),
    ENGRAM_CAPTURE_TOKEN: 'c'.repeat(32),
    ENGRAM_PROJECT_REGISTRY_FILE: registryFile,
    ENGRAM_SECRET_SOURCES_FILE: join(dir, 'sources.json'),
    SUPABASE_URL: 'http://127.0.0.1:3000',
    SUPABASE_KEY: 'test-service-key',
    OPENAI_API_KEY: 'test-openai-key',
    ...overrides,
  }
}

describe('captureEventsConfigFromEnv', () => {
  it('is null while ENGRAM_CAPTURE_TOKEN is unset, whatever else is missing', () => {
    expect(captureEventsConfigFromEnv({})).toBeNull()
    expect(captureEventsConfigFromEnv({ ENGRAM_CAPTURE_TOKEN: '' })).toBeNull()
  })

  it('loads the registry and the store settings', () => {
    const config = captureEventsConfigFromEnv(env())
    expect(config).not.toBeNull()
    expect([...config!.registry.projects.keys()]).toEqual(['sample-repo'])
    expect(config!.supabaseUrl).toBe('http://127.0.0.1:3000')
    expect(config!.supabaseKey).toBe('test-service-key')
    expect(config!.openaiApiKey).toBe('test-openai-key')
  })

  it.each([
    'BEARER_TOKEN',
    'ENGRAM_PROJECT_REGISTRY_FILE',
    'ENGRAM_SECRET_SOURCES_FILE',
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'OPENAI_API_KEY',
  ])('throws naming %s when the token is set and it is missing', (name) => {
    expect(() => captureEventsConfigFromEnv(env({ [name]: undefined }))).toThrow(new RegExp(`${name} is required`))
  })

  it('throws naming the registry variable for a missing or invalid registry file', () => {
    expect(() => captureEventsConfigFromEnv(env({ ENGRAM_PROJECT_REGISTRY_FILE: join(dir, 'absent.json') }))).toThrow(
      /^ENGRAM_PROJECT_REGISTRY_FILE: /,
    )
    expect(() => captureEventsConfigFromEnv(env({ ENGRAM_PROJECT_REGISTRY_FILE: badRegistryFile }))).toThrow(
      /^ENGRAM_PROJECT_REGISTRY_FILE: .*version/,
    )
  })
})

describe('documentsConfigFromEnv', () => {
  const docsEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
    env({ ENGRAM_CAPTURE_TOKEN: undefined, OPENAI_API_KEY: undefined, ENGRAM_DOCUMENTS_TOKEN: 'd'.repeat(32), ...overrides })

  it('is null while ENGRAM_DOCUMENTS_TOKEN is unset', () => {
    expect(documentsConfigFromEnv({})).toBeNull()
    expect(documentsConfigFromEnv({ ENGRAM_DOCUMENTS_TOKEN: '' })).toBeNull()
  })

  it('loads the registry and the store settings without the capture variables', () => {
    const config = documentsConfigFromEnv(docsEnv())
    expect([...config!.registry.projects.keys()]).toEqual(['sample-repo'])
    expect(config).toMatchObject({ supabaseUrl: 'http://127.0.0.1:3000', supabaseKey: 'test-service-key' })
  })

  it.each(['ENGRAM_PROJECT_REGISTRY_FILE', 'ENGRAM_SECRET_SOURCES_FILE', 'SUPABASE_URL', 'SUPABASE_KEY'])(
    'throws naming %s when the token is set and it is missing',
    (name) => {
      expect(() => documentsConfigFromEnv(docsEnv({ [name]: undefined }))).toThrow(new RegExp(`${name} is required`))
    },
  )

  it('throws naming the registry variable for an invalid registry file', () => {
    expect(() => documentsConfigFromEnv(docsEnv({ ENGRAM_PROJECT_REGISTRY_FILE: badRegistryFile }))).toThrow(
      /^ENGRAM_PROJECT_REGISTRY_FILE: .*version/,
    )
  })
})
