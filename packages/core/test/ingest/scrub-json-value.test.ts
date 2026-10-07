import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scrubJsonValue } from '../../src/ingest/scrub-json-value.js'
import type { ScrubResult } from '../../src/ingest/scrub-secrets.js'
import { useNoRegistry, useTempRegistry } from './registry-fixture.js'

// Made-up values; none is a real credential.
const PASSWORD = 'Zq7-made-up-not-real-91x'
const BEARER = 'Bearer Zq7madeupNotReal91xAbc'
const TOKEN = 'Zq7madeupTokenNotReal91xQw'
const REGISTERED = 'Kd4madeupRegisteredValue73pX'

describe('scrubJsonValue — values are read beside their keys', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useNoRegistry()
  })
  afterAll(() => restore())

  it('masks the value under a credential-named key', async () => {
    const result = await scrubJsonValue({ db_password: PASSWORD })
    expect(result).toEqual({
      ok: true,
      value: { db_password: '[REDACTED:db_password]' },
      redactions: [{ kind: 'named-secret', name: 'db_password' }],
    })
  })

  it('masks an Authorization header value', async () => {
    const result = await scrubJsonValue({ Authorization: BEARER })
    expect(result.ok && result.value).toEqual({ Authorization: '[REDACTED:Authorization]' })
  })

  it('masks a nested credential key', async () => {
    const result = await scrubJsonValue({ deploy: { api_token: TOKEN, region: 'eu-west' } })
    expect(result.ok && result.value).toEqual({ deploy: { api_token: '[REDACTED:api_token]', region: 'eu-west' } })
  })

  it('masks a credential-named key inside an array of objects', async () => {
    const result = await scrubJsonValue({ servers: [{ host: 'db.local', password: PASSWORD }, { host: 'cache.local' }] })
    expect(result.ok && result.value).toEqual({
      servers: [{ host: 'db.local', password: '[REDACTED:password]' }, { host: 'cache.local' }],
    })
  })

  it('returns a plain key and value unchanged, with no redactions', async () => {
    const input = { title: 'Release notes', tags: ['plan', 'docs'], draft: false, order: 3 }
    expect(await scrubJsonValue(input)).toEqual({ ok: true, value: input, redactions: [] })
  })

  it('reports a scrub that changes the shape instead of returning a value', async () => {
    const dropsAKey = async (): Promise<ScrubResult> => ({
      text: JSON.stringify({ title: 'x' }),
      redactions: [{ kind: 'stub' }],
    })
    expect(await scrubJsonValue({ title: 'x', db_password: PASSWORD }, dropsAKey)).toEqual({ ok: false, reason: 'shape-changed' })

    const nests = async (): Promise<ScrubResult> => ({ text: '{"title":{"inner":"x"}}', redactions: [] })
    expect(await scrubJsonValue({ title: 'x' }, nests)).toEqual({ ok: false, reason: 'shape-changed' })
  })

  it('reports a scrub whose text no longer parses', async () => {
    const breaks = async (text: string): Promise<ScrubResult> => ({ text: text.slice(0, -1), redactions: [] })
    expect(await scrubJsonValue({ title: 'x' }, breaks)).toEqual({ ok: false, reason: 'unparseable' })
  })

  it('reports a placeholder that lands where a number was', async () => {
    const result = await scrubJsonValue({ db_password: 73914628 })
    expect(result).toEqual({ ok: false, reason: 'unparseable' })
  })
})

describe('scrubJsonValue — registered values', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useTempRegistry({ DEPLOY_SECRET: REGISTERED })
  })
  afterAll(() => restore())

  it('masks a registered value used as a key', async () => {
    const result = await scrubJsonValue({ [REGISTERED]: 'note', title: 'x' })
    expect(result.ok && result.value).toEqual({ '[REDACTED:DEPLOY_SECRET]': 'note', title: 'x' })
  })
})
