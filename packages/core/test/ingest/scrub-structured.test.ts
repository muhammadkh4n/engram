import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scrubStructured } from '../../src/ingest/scrub-structured.js'
import { scrubSecrets, type ScrubResult } from '../../src/ingest/scrub-secrets.js'
import { useNoRegistry, useTempRegistry } from './registry-fixture.js'

// Made-up values; none is a real credential. Token-shaped ones are assembled at
// runtime so the source never carries a literal a push-time scanner would flag.
const PASSWORD = 'Zq7-made-up-not-real-91x'
const BEARER = 'Bearer Zq7madeupNotReal91xAbc'
const TOKEN = 'Zq7madeupTokenNotReal91xQw'
const REGISTERED = 'Kd4madeupRegisteredValue73pX'
const MIXED = 'Q7xk2Lm9Vp4Rt8Wz'
const mixed = (n: number): string => MIXED.repeat(Math.ceil(n / MIXED.length)).slice(0, n)
const ANTHROPIC_OAUTH = 'sk-ant-oat01-' + mixed(60)
const OPENROUTER_KEY = 'sk-or-v1-' + '9f8e7d6c5b4a3210'.repeat(4)
const GITHUB_PAT = 'ghp_' + MIXED + MIXED + 'Zq4Y'
const JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiJzZXJ2aWNlLXJvbGUiLCJpYXQiOjE3MDAwMDAwMDB9',
  'dGhpcy1pcy1ub3QtYS1yZWFsLXNpZ25hdHVyZQ',
].join('.')
const PEM_BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + mixed(32), 'bm90IGEgcmVhbCBrZXkgbWF0ZXJpYWw=']
const API_KEY_VALUE = mixed(32)

// Each value is masked when scrubbed on its own text. Escaped into a JSON text
// the newline or tab before a token becomes `\n` or `\t`, so the token follows
// a word character, and an env or JSON block is no longer the whole text.
const OWN_TEXT_CASES: Array<[string, string, string]> = [
  ['an OAuth token after a newline', `first line\n${ANTHROPIC_OAUTH}`, ANTHROPIC_OAUTH],
  ['a JWT after a tab', `header\t${JWT}`, JWT],
  ['a GitHub token after a newline', `token below\n${GITHUB_PAT}`, GITHUB_PAT],
  ['an OpenRouter key after a newline', `router\n${OPENROUTER_KEY}`, OPENROUTER_KEY],
  ['an env block', `API_KEY=${API_KEY_VALUE}\nDB_PASSWORD=${PASSWORD}`, PASSWORD],
  ['a JSON document', JSON.stringify({ client_secret: TOKEN }), TOKEN],
]

const MORE_PARITY_CASES: Array<[string, string, string]> = [
  ['a PEM block', `-----BEGIN PRIVATE KEY-----\n${PEM_BODY.join('\n')}\n-----END PRIVATE KEY-----`, PEM_BODY[0]!],
  ['a URL userinfo password', `postgres://app:${PASSWORD}@db.internal:5432/main`, PASSWORD],
]

describe('scrubStructured — each string is scrubbed on its own text', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useNoRegistry()
  })
  afterAll(() => restore())

  it.each([...OWN_TEXT_CASES, ...MORE_PARITY_CASES])(
    'gives a member under a plain key exactly what scrubSecrets gives its text: %s',
    async (_name, value, secret) => {
      const alone = await scrubSecrets(value)
      const result = await scrubStructured({ notes: value })
      expect(result.ok && result.value).toEqual({ notes: alone.text })
      expect(alone.text).not.toContain(secret)
      expect(result.ok && result.redactions).toEqual(alone.redactions.map((r) => ({ ...r, path: ['notes'], part: 'value' })))
    },
  )

  it('scrubs an array element on its own text', async () => {
    const [, value, secret] = OWN_TEXT_CASES[0]!
    const result = await scrubStructured({ lines: ['plain', value] })
    expect(result.ok && result.value).toEqual({ lines: ['plain', (await scrubSecrets(value)).text] })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.ok && result.redactions[0]?.path).toEqual(['lines', 1])
  })

  it('hands the scrubber each key, string, number and boolean alone, then the walked document once', async () => {
    const seen: string[] = []
    const record = async (text: string): Promise<ScrubResult> => {
      seen.push(text)
      return { text, redactions: [] }
    }
    const input = { title: 'Release', meta: { owner: 'ops', tags: ['a', 'b'] }, count: 2, draft: true, owner: null }
    await scrubStructured(input, record)
    const whole = seen.pop()
    expect(whole).toBe(JSON.stringify(input))
    expect(seen.sort()).toEqual(
      ['Release', 'a', 'b', 'count', 'meta', 'ops', 'owner', 'owner', 'tags', 'title', '2', 'draft', 'true'].sort(),
    )
  })
})

describe('scrubStructured — the key rule', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useNoRegistry()
  })
  afterAll(() => restore())

  it('masks the value under a credential-named key', async () => {
    expect(await scrubStructured({ db_password: PASSWORD })).toEqual({
      ok: true,
      value: { db_password: '[REDACTED:db_password]' },
      redactions: [{ kind: 'named-secret', name: 'db_password', path: ['db_password'], part: 'value' }],
    })
  })

  it('masks an Authorization header value', async () => {
    const result = await scrubStructured({ Authorization: BEARER })
    expect(result.ok && result.value).toEqual({ Authorization: '[REDACTED:Authorization]' })
  })

  it('masks a nested credential key and names its path', async () => {
    const result = await scrubStructured({ deploy: { api_token: TOKEN, region: 'eu-west' } })
    expect(result.ok && result.value).toEqual({ deploy: { api_token: '[REDACTED:api_token]', region: 'eu-west' } })
    expect(result.ok && result.redactions).toEqual([
      { kind: 'named-secret', name: 'api_token', path: ['deploy', 'api_token'], part: 'value' },
    ])
  })

  it('masks a credential-named key inside an array of objects', async () => {
    const result = await scrubStructured({ servers: [{ host: 'db.local', password: PASSWORD }, { host: 'cache.local' }] })
    expect(result.ok && result.value).toEqual({
      servers: [{ host: 'db.local', password: '[REDACTED:password]' }, { host: 'cache.local' }],
    })
    expect(result.ok && result.redactions[0]?.path).toEqual(['servers', 0, 'password'])
  })

  it('masks a number under a credential key with a string placeholder', async () => {
    expect(await scrubStructured({ session: 3 })).toEqual({
      ok: true,
      value: { session: '[REDACTED:session]' },
      redactions: [{ kind: 'named-secret', name: 'session', path: ['session'], part: 'value' }],
    })
    const pin = await scrubStructured({ db_password: 73914628 })
    expect(pin.ok && pin.value).toEqual({ db_password: '[REDACTED:db_password]' })
  })

  it('returns plain keys and values unchanged, with no redactions', async () => {
    const input = { title: 'Release notes', tags: ['plan', 'docs'], draft: false, order: 3, owner: null }
    expect(await scrubStructured(input)).toEqual({ ok: true, value: input, redactions: [] })
  })

  it('keeps a __proto__ key as data', async () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"title":"x"}') as unknown
    const result = await scrubStructured(input)
    expect(result.ok).toBe(true)
    const value = result.ok ? (result.value as Record<string, unknown>) : {}
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('reports a value nested deeper than any document it walks', async () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 200; i++) deep = [deep]
    expect(await scrubStructured({ deep })).toEqual({ ok: false, reason: 'too-deep' })
  })
})

describe('scrubStructured — keys', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useTempRegistry({ DEPLOY_SECRET: REGISTERED })
  })
  afterAll(() => restore())

  it('masks a registered value used as a key', async () => {
    const result = await scrubStructured({ [REGISTERED]: 'note', title: 'x' })
    expect(result).toEqual({
      ok: true,
      value: { '[REDACTED:DEPLOY_SECRET]': 'note', title: 'x' },
      redactions: [{ kind: 'known', name: 'DEPLOY_SECRET', path: ['[REDACTED:DEPLOY_SECRET]'], part: 'key' }],
    })
  })

  it('reports two keys that scrub to the same text instead of merging their members', async () => {
    const result = await scrubStructured({ [REGISTERED]: 'a', '[REDACTED:DEPLOY_SECRET]': 'b' })
    expect(result).toEqual({ ok: false, reason: 'key-collision' })
  })

  it('names a key-rule placeholder by the scrubbed key, so a masked key never returns in its label and the label ends no placeholder early', async () => {
    const result = await scrubStructured({ [`${REGISTERED}_password`]: PASSWORD })
    expect(result.ok && result.value).toEqual({
      '[REDACTED:DEPLOY_SECRET]_password': '[REDACTED:DEPLOY_SECRET_password]',
    })
    expect(JSON.stringify(result)).not.toContain(REGISTERED)
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
  })
})

// A made-up registered secret written as a bare number in YAML or JSON.
const REGISTERED_NUMBER = 7304918265
const BEARER_TOKEN = BEARER.slice('Bearer '.length)

// Every input with the secret values it holds. Each case is either refused or
// comes back holding none of them; plain frontmatter is never refused.
const UNION_CORPUS: Array<[string, unknown, string[]]> = [
  ['an OAuth token after a newline', { notes: OWN_TEXT_CASES[0]![1] }, [ANTHROPIC_OAUTH]],
  ['a JWT after a tab', { notes: OWN_TEXT_CASES[1]![1] }, [JWT]],
  ['a GitHub token after a newline', { notes: OWN_TEXT_CASES[2]![1] }, [GITHUB_PAT]],
  ['an OpenRouter key after a newline', { notes: OWN_TEXT_CASES[3]![1] }, [OPENROUTER_KEY]],
  ['an env block', { notes: OWN_TEXT_CASES[4]![1] }, [API_KEY_VALUE, PASSWORD]],
  ['a JSON document', { notes: OWN_TEXT_CASES[5]![1] }, [TOKEN]],
  ['a PEM block', { notes: MORE_PARITY_CASES[0]![1] }, PEM_BODY],
  ['a URL userinfo password', { notes: MORE_PARITY_CASES[1]![1] }, [PASSWORD]],
  ['a credential-named key', { db_password: PASSWORD }, [PASSWORD]],
  ['an Authorization header', { Authorization: BEARER }, [BEARER_TOKEN]],
  ['a nested credential key', { deploy: { api_token: TOKEN } }, [TOKEN]],
  ['a credential key in an array of objects', { servers: [{ host: 'db.local', password: PASSWORD }] }, [PASSWORD]],
  ['a registered value used as a key', { [REGISTERED]: 'note' }, [REGISTERED]],
  ['a registered value inside a key', { [`${REGISTERED}_password`]: PASSWORD }, [REGISTERED, PASSWORD]],
  ['an Authorization header as a tuple', { headers: [['Authorization', BEARER]] }, [BEARER_TOKEN]],
  ['a registered number as a member', { backup: REGISTERED_NUMBER }, [String(REGISTERED_NUMBER)]],
  ['a registered number as an array element', { pins: [1, REGISTERED_NUMBER] }, [String(REGISTERED_NUMBER)]],
]

const PLAIN_FRONTMATTER: Array<[string, Record<string, unknown>]> = [
  ['title and tags', { title: 'Release notes', tags: ['plan', 'docs'] }],
  ['aliases', { aliases: ['Release', 'Ship notes'], cssclasses: ['wide'] }],
  ['dates', { created: '2026-09-30', updated: '2026-10-01T09:30:00.000Z', due: '2026-11-01' }],
  ['mixed scalars', { type: 'phase', order: 3, draft: false, owner: null, weight: 0.5, rating: -2 }],
  ['nested plain data', { links: [{ title: 'Spec', url: 'https://example.com/spec' }], status: { state: 'active' } }],
]

describe('scrubStructured — every scrub view', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useTempRegistry({ DEPLOY_SECRET: REGISTERED, BACKUP_PASSWORD: String(REGISTERED_NUMBER) })
  })
  afterAll(() => restore())

  it.each(UNION_CORPUS)('refuses %s or returns none of its secret values', async (_name, input, secrets) => {
    const result = await scrubStructured(input)
    if (!result.ok) return
    const stored = JSON.stringify(result.value)
    for (const secret of secrets) expect(stored).not.toContain(secret)
  })

  it('masks every corpus case but the Authorization tuple, which only the whole-text pass reads', async () => {
    const refused: string[] = []
    for (const [name, input] of UNION_CORPUS) if (!(await scrubStructured(input)).ok) refused.push(name)
    expect(refused).toEqual(['an Authorization header as a tuple'])
  })

  it.each(PLAIN_FRONTMATTER)('never refuses plain frontmatter: %s', async (_name, input) => {
    expect(await scrubStructured(input)).toEqual({ ok: true, value: input, redactions: [] })
  })

  it('refuses an Authorization tuple the walk cannot read across values', async () => {
    expect(await scrubStructured({ headers: [['Authorization', BEARER]] })).toEqual({ ok: false, reason: 'missed-by-walk' })
  })

  it('masks a registered secret written as a bare number, as a member and as an array element', async () => {
    expect(await scrubStructured({ backup: REGISTERED_NUMBER })).toEqual({
      ok: true,
      value: { backup: '[REDACTED:BACKUP_PASSWORD]' },
      redactions: [{ kind: 'known', name: 'BACKUP_PASSWORD', path: ['backup'], part: 'value' }],
    })
    expect(await scrubStructured([REGISTERED_NUMBER])).toEqual({
      ok: true,
      value: ['[REDACTED:BACKUP_PASSWORD]'],
      redactions: [{ kind: 'known', name: 'BACKUP_PASSWORD', path: [0], part: 'value' }],
    })
  })

  it('refuses when the whole-text pass reports a secret, and never returns that pass\'s text', async () => {
    const wholeText = (text: string): boolean => text.startsWith('{')
    const scrub = async (text: string): Promise<ScrubResult> =>
      wholeText(text) ? { text: '{"title":"[REDACTED:x]"}', redactions: [{ kind: 'known', name: 'x' }] } : { text, redactions: [] }
    expect(await scrubStructured({ title: 'Release' }, scrub)).toEqual({ ok: false, reason: 'missed-by-walk' })
  })
})
