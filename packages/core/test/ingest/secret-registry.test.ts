import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSecretRegistry } from '../../src/ingest/secret-registry.js'
import type { SecretRegistry } from '../../src/ingest/secret-registry.js'

// Every value below is synthetic, assembled at runtime so no literal in this
// file looks like a credential to a push-time scanner.
const ALNUM = 'Qv8' + 'mZt2' + 'Lp9x' + 'Wr4'
const SPECIAL = 'Kx9"q' + "'L\\w&<z>" + '%+/v=Tb3'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const jsSingle = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const shellDouble = (s: string): string => s.replace(/[\\"$`]/g, '\\$&')
const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const xmlText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

let dir: string
let logs: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-secret-registry-'))
  logs = []
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content: string): string {
  const path = join(dir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function registryFor(sources: unknown[], now?: () => number): SecretRegistry {
  const configPath = write('sources.json', JSON.stringify({ sources }))
  return createSecretRegistry({ configPath, log: (line) => logs.push(line), now })
}

/** Replaces every span the registry reports, merging overlaps, as the scrubber does. */
function mask(registry: SecretRegistry, text: string): string {
  const spans = registry.findKnownValues(text).sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Array<{ start: number; end: number; name: string }> = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  let out = text
  for (const s of merged.reverse()) out = out.slice(0, s.start) + `[REDACTED:${s.name}]` + out.slice(s.end)
  return out
}

function isKnown(registry: SecretRegistry, value: string): boolean {
  return registry.findKnownValues(` ${value} `).some((s) => s.start === 1 && s.end === value.length + 1)
}

/** 4-character pieces of the value still present in the text. */
function fragments(text: string, value: string): string[] {
  const out: string[] = []
  for (let i = 0; i + 4 <= value.length; i++) if (text.includes(value.slice(i, i + 4))) out.push(value.slice(i, i + 4))
  return out
}

describe('sources configuration', () => {
  it('unset: empty registry, the reason logged once, nothing thrown', () => {
    const registry = createSecretRegistry({ configPath: undefined, log: (line) => logs.push(line) })
    expect(registry.findKnownValues(`text with ${ALNUM}`)).toEqual([])
    expect(registry.findKnownValues(`more text with ${ALNUM}`)).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/ENGRAM_SECRET_SOURCES_FILE is unset/)
  })

  it('unreadable: empty registry, the reason logged once', () => {
    const registry = createSecretRegistry({ configPath: join(dir, 'missing.json'), log: (line) => logs.push(line) })
    expect(registry.findKnownValues(`text with ${ALNUM}`)).toEqual([])
    registry.findKnownValues('again')
    expect(logs).toEqual([expect.stringMatching(/missing\.json \(ENOENT\)/)])
  })

  it('not valid JSON: empty registry, reported without the file content', () => {
    const configPath = write('sources.json', `{"sources": [{"path": "${ALNUM}"`)
    const registry = createSecretRegistry({ configPath, log: (line) => logs.push(line) })
    expect(registry.findKnownValues(ALNUM)).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain(ALNUM)
  })

  it('skips entries with no path or an unknown format, and keeps the rest', () => {
    write('app.env', `API_TOKEN=${ALNUM}\n`)
    const registry = registryFor([{ path: 'x', format: 'toml' }, { format: 'dotenv' }, { path: 'app.env', format: 'dotenv' }])
    expect(isKnown(registry, ALNUM)).toBe(true)
    expect(logs.filter((l) => /source #[12] /.test(l))).toHaveLength(2)
  })

  it('expands ~ to the home directory', () => {
    vi.stubEnv('HOME', dir)
    write('secrets/api_token', `${ALNUM}\n`)
    const registry = registryFor([{ path: '~/secrets/*', format: 'value' }])
    expect(mask(registry, `token ${ALNUM}`)).toBe('token [REDACTED:api_token]')
  })
})

describe('formats', () => {
  it('value: the whole trimmed file is one secret named after the file', () => {
    write('run/secrets/neo4j_password', `${ALNUM}\n`)
    write('run/secrets/notes_password', 'two words here\n')
    const registry = registryFor([{ path: 'run/secrets/*', format: 'value' }])
    expect(mask(registry, `password is ${ALNUM}.`)).toBe('password is [REDACTED:neo4j_password].')
    expect(isKnown(registry, 'two words here')).toBe(false)
    expect(logs).toEqual([expect.stringMatching(/notes_password: not a single token or PEM block; skipped$/)])
    expect(logs.join('\n')).not.toContain('two words')
  })

  it('value: the file name is the key; files not named as a credential are listed once and not registered', () => {
    write('store/JIRA_URL', 'https://tracker.example.test\n')
    write('store/OPS_EMAIL', 'ops@example.test\n')
    write('store/API_TOKEN', `${ALNUM}\n`)
    const registry = registryFor([{ path: 'store/*', format: 'value' }])
    expect(isKnown(registry, ALNUM)).toBe(true)
    expect(isKnown(registry, 'https://tracker.example.test')).toBe(false)
    expect(isKnown(registry, 'ops@example.test')).toBe(false)
    expect(logs).toEqual(['store/*: not registered, the file name names no credential: JIRA_URL, OPS_EMAIL'])
  })

  it('value: a PEM block registers whole and line by line, without its armor lines', () => {
    const body = ['MIIEvQ' + ALNUM + ALNUM, 'AoIBAQ' + ALNUM + 'Zy7', 'x9Kd2' + ALNUM]
    const pem = ['-----BEGIN PRIVATE KEY-----', ...body, '-----END PRIVATE KEY-----'].join('\n')
    write('keys/deploy_key', `${pem}\n`)
    const registry = registryFor([{ path: 'keys/deploy_key', format: 'value' }])
    expect(mask(registry, JSON.stringify({ key: pem }))).toBe('{"key":"[REDACTED:deploy_key]"}')
    expect(mask(registry, `  ${body[1]}\n`)).toBe('  [REDACTED:deploy_key]\n')
    expect(isKnown(registry, '-----BEGIN PRIVATE KEY-----')).toBe(false)
  })

  it('dotenv: export, quotes, comments, escapes and multi-line values; the key name decides', () => {
    write(
      'app.env',
      [
        '# a comment with API_TOKEN=commented-out-value',
        `export DB_PASSWORD="dq-${ALNUM}\\"end"`,
        `API_TOKEN='sq-${ALNUM}'`,
        `PLAIN_SECRET=plain-${ALNUM} # trailing comment`,
        'TOKEN_LIMIT=409600',
        'CACHE_KEY=cache-key-value-1',
        `PROJECT_KEY=proj-${ALNUM}`,
        `pass=bare-${ALNUM}`,
        `DATABASE_URL=postgres://app:url-${ALNUM}@db:5432/main`,
        'REF_SECRET=${OTHER_SECRET}',
        'FLAG_SECRET=true',
        'SHORT_SECRET=abc12',
        `NEXT_PUBLIC_API_KEY=pub-${ALNUM}`,
        `MULTI_PRIVATE_KEY="line-one-${ALNUM}`,
        `line-two-${ALNUM}"`,
      ].join('\n'),
    )
    const registry = registryFor([{ path: 'app.env', format: 'dotenv' }])
    for (const v of [`dq-${ALNUM}\\"end`, `dq-${ALNUM}"end`, `sq-${ALNUM}`, `plain-${ALNUM}`, `proj-${ALNUM}`, `bare-${ALNUM}`, `url-${ALNUM}`, `line-one-${ALNUM}`, `line-two-${ALNUM}`]) {
      expect(isKnown(registry, v), v).toBe(true)
    }
    for (const v of ['commented-out-value', '409600', 'cache-key-value-1', '${OTHER_SECRET}', 'true', 'abc12', `pub-${ALNUM}`, 'postgres://app']) {
      expect(isKnown(registry, v), v).toBe(false)
    }
    expect(mask(registry, `psql with url-${ALNUM} now`)).toBe('psql with [REDACTED:DATABASE_URL] now')
  })

  it('ini: key = value under sections, quotes stripped, comments skipped', () => {
    write('app.ini', ['[database]', `password = ini-${ALNUM}`, 'host = dbhost-01', `; secret = commented-${ALNUM}`, `api_token: "quoted-${ALNUM}"`].join('\n'))
    const registry = registryFor([{ path: 'app.ini', format: 'ini' }])
    expect(isKnown(registry, `ini-${ALNUM}`)).toBe(true)
    expect(isKnown(registry, `quoted-${ALNUM}`)).toBe(true)
    expect(isKnown(registry, 'dbhost-01')).toBe(false)
    expect(isKnown(registry, `commented-${ALNUM}`)).toBe(false)
  })

  it('json-keys: string leaves under secret keys, arrays inherit the key, Authorization minus its scheme', () => {
    write(
      'config.json',
      JSON.stringify({
        services: { api: { clientSecret: `cs-${ALNUM}`, url: 'https://svc.example.test' } },
        headers: { Authorization: `Bearer bt-${ALNUM}`, 'Proxy-Authorization': `Basic ${b64(`svc:basic-${ALNUM}`)}` },
        tokens: { refresh_token: [`rt1-${ALNUM}`, `rt2-${ALNUM}`] },
        list: [{ apiKey: `ak-${ALNUM}` }],
        sortKey: 'sort-key-value',
        count: 1234567,
      }),
    )
    const registry = registryFor([{ path: 'config.json', format: 'json-keys' }])
    for (const v of [`cs-${ALNUM}`, `bt-${ALNUM}`, `basic-${ALNUM}`, `rt1-${ALNUM}`, `rt2-${ALNUM}`, `ak-${ALNUM}`]) {
      expect(isKnown(registry, v), v).toBe(true)
    }
    for (const v of ['https://svc.example.test', 'sort-key-value', `Bearer bt-${ALNUM}`]) expect(isKnown(registry, v), v).toBe(false)
    expect(mask(registry, `Authorization: Bearer bt-${ALNUM}`)).toBe('Authorization: Bearer [REDACTED:Authorization]')
  })

  it('json-keys: invalid JSON is skipped and reported without its content', () => {
    write('broken.json', `{"password": "${ALNUM}"`)
    const registry = registryFor([{ path: 'broken.json', format: 'json-keys' }])
    expect(isKnown(registry, ALNUM)).toBe(false)
    expect(logs).toEqual([expect.stringMatching(/broken\.json: not valid JSON; skipped$/)])
  })

  it('yaml-keys: every scalar read as written, block scalars, several documents', () => {
    write(
      'secrets.yaml',
      [
        'db:',
        '  password: 12345678',
        '  user: appuser-01',
        'api:',
        '  token: |',
        `    block-one-${ALNUM}`,
        `    block-two-${ALNUM}`,
        '---',
        'other:',
        `  secret: "second-doc-${ALNUM}"`,
        '  sops_mac: ENC[AES256_GCM,data:abcdef,iv:xyz,type:str]',
        '  api_secret: ENC[AES256_GCM,data:ghijkl,iv:xyz,type:str]',
      ].join('\n'),
    )
    const registry = registryFor([{ path: 'secrets.yaml', format: 'yaml-keys' }])
    for (const v of ['12345678', `block-one-${ALNUM}`, `block-two-${ALNUM}`, `second-doc-${ALNUM}`]) {
      expect(isKnown(registry, v), v).toBe(true)
    }
    expect(isKnown(registry, 'appuser-01')).toBe(false)
    expect(isKnown(registry, 'ENC[AES256_GCM,data:ghijkl,iv:xyz,type:str]')).toBe(false)
  })

  it('yaml-keys: invalid YAML is skipped and reported without its content', () => {
    write('broken.yaml', `password: "${ALNUM}\n  bad: [`)
    const registry = registryFor([{ path: 'broken.yaml', format: 'yaml-keys' }])
    expect(isKnown(registry, ALNUM)).toBe(false)
    expect(logs).toEqual([expect.stringMatching(/broken\.yaml: not valid YAML; skipped$/)])
  })

  it('npmrc: _authToken, _auth and _password, with the base64 ones decoded; references skipped', () => {
    write(
      '.npmrc',
      [
        `//registry.npmjs.org/:_authToken=npm-${ALNUM}`,
        `_auth=${b64(`user:auth-${ALNUM}`)}`,
        `//npm.example.test/:_password=${b64(`pw-${ALNUM}`)}`,
        '//npm.pkg.github.com/:_authToken=${NPM_TOKEN}',
        'registry=https://registry.npmjs.org/',
      ].join('\n'),
    )
    const registry = registryFor([{ path: '.npmrc', format: 'npmrc' }])
    for (const v of [`npm-${ALNUM}`, `auth-${ALNUM}`, `pw-${ALNUM}`, b64(`pw-${ALNUM}`)]) expect(isKnown(registry, v), v).toBe(true)
    expect(mask(registry, 'token ${NPM_TOKEN} and https://registry.npmjs.org/')).toBe('token ${NPM_TOKEN} and https://registry.npmjs.org/')
  })

  it('git-credentials: URL passwords, percent-decoded, named after the host', () => {
    write('.git-credentials', `https://octo:gh%40${ALNUM}%2Fx@github.com\nhttps://nopassword@example.test\n`)
    const registry = registryFor([{ path: '.git-credentials', format: 'git-credentials' }])
    expect(mask(registry, `pushed with gh@${ALNUM}/x today`)).toBe('pushed with [REDACTED:git-credentials:github.com] today')
    expect(isKnown(registry, 'nopassword')).toBe(false)
  })
})

describe('globs', () => {
  it('matches files under a glob, skips excludes, and never enters node_modules or .git', () => {
    write('projects/alpha/.env', 'API_TOKEN=alpha-token-value\n')
    write('projects/beta/deep/.env', 'API_TOKEN=beta-token-value\n')
    write('projects/skip/.env', 'API_TOKEN=skipped-token-value\n')
    write('projects/alpha/node_modules/pkg/.env', 'API_TOKEN=module-token-value\n')
    write('projects/alpha/.git/.env', 'API_TOKEN=gitdir-token-value\n')
    const registry = registryFor([{ path: 'projects/**/.env', format: 'dotenv', exclude: ['**/skip/**'] }])
    expect(isKnown(registry, 'alpha-token-value')).toBe(true)
    expect(isKnown(registry, 'beta-token-value')).toBe(true)
    expect(isKnown(registry, 'skipped-token-value')).toBe(false)
    expect(isKnown(registry, 'module-token-value')).toBe(false)
    expect(isKnown(registry, 'gitdir-token-value')).toBe(false)
  })

  it('supports *, ? and {a,b} segments', () => {
    write('cfg/one.env', 'API_TOKEN=one-token-value\n')
    write('cfg/two.env', 'API_TOKEN=two-token-value\n')
    write('cfg/three.txt', 'API_TOKEN=three-token-value\n')
    const registry = registryFor([{ path: 'cfg/{one,tw?}.env', format: 'dotenv' }, { path: 'cfg/*.txt', format: 'dotenv' }])
    for (const v of ['one-token-value', 'two-token-value', 'three-token-value']) expect(isKnown(registry, v), v).toBe(true)
  })
})

describe('every spelling of a registered value is masked', () => {
  let registry: SecretRegistry
  beforeEach(() => {
    write('run/secrets/db_password', `${SPECIAL}\n`)
    registry = registryFor([{ path: 'run/secrets/db_password', format: 'value' }])
  })

  const P = '[REDACTED:db_password]'
  const cases: Array<[string, () => string]> = [
    ['prose', () => `the db password is ${SPECIAL} for now`],
    ['JS double-quoted', () => `const pw = ${JSON.stringify(SPECIAL)}`],
    ['JS single-quoted', () => `const pw = '${jsSingle(SPECIAL)}'`],
    ['TS typed declaration', () => `const dbPassword: string = '${jsSingle(SPECIAL)}';`],
    ['subscript assignment', () => `config["password"] = ${JSON.stringify(SPECIAL)}; env['DB_PW'] = '${jsSingle(SPECIAL)}'`],
    ['JSON', () => JSON.stringify({ password: SPECIAL })],
    ['JSON inside JSON', () => JSON.stringify({ body: JSON.stringify({ password: SPECIAL }) })],
    ['query string (component)', () => `https://api.example.test/login?user=a&pw=${encodeURIComponent(SPECIAL)}&x=1`],
    ['query string (form)', () => `curl -d '${new URLSearchParams({ pw: SPECIAL }).toString()}'`],
    ['YAML double-quoted', () => `db:\n  password: ${JSON.stringify(SPECIAL)}\n`],
    ['YAML single-quoted', () => `db:\n  password: '${SPECIAL.replaceAll("'", "''")}'\n`],
    ['XML attribute', () => `<db password="${xml(SPECIAL)}"/>`],
    ['XML text', () => `<password>${xmlText(SPECIAL)}</password>`],
    ['shell single quotes', () => `export DB_PASSWORD='${SPECIAL.replaceAll("'", "'\\''")}'`],
    ['shell double quotes', () => `curl -H "X-Db-Pw: ${shellDouble(SPECIAL)}" https://x.test`],
    ['shell inside JSON', () => JSON.stringify({ command: `mysql -p'${SPECIAL.replaceAll("'", "'\\''")}' main` })],
  ]

  it.each(cases)('%s', (_label, render) => {
    const text = render()
    const masked = mask(registry, text)
    expect(masked).toContain(P)
    expect(fragments(masked, SPECIAL)).toEqual([])
  })

  it.each([
    ['aligned', ''],
    ['one byte before', 'x'],
    ['two bytes before', 'xy'],
    ['Basic user:password', 'user:'],
  ])('base64, %s', (_label, prefix) => {
    const encoded = b64(prefix + SPECIAL)
    const masked = mask(registry, `Authorization: Basic ${encoded}`)
    const m = /^Authorization: Basic ([A-Za-z0-9+/]*)\[REDACTED:db_password\]([A-Za-z0-9+/=]*)$/.exec(masked)
    expect(m).not.toBeNull()
    // What remains encodes the prefix plus at most two leading bytes and one
    // trailing byte of the value: the characters shared with neighbouring bytes.
    expect(Math.floor((m![1]!.length * 3) / 4)).toBeLessThanOrEqual(prefix.length + 2)
    expect(m![2]!.replace(/=+$/, '').length).toBeLessThanOrEqual(2)
  })
})

describe('freshness', () => {
  it('re-reads a changed source, at most once a minute', () => {
    let t = 1_000_000
    const env = write('app.env', 'API_TOKEN=first-token-value\n')
    const registry = registryFor([{ path: 'app.env', format: 'dotenv' }], () => t)
    expect(isKnown(registry, 'first-token-value')).toBe(true)

    writeFileSync(env, 'API_TOKEN=second-token-value\n')
    utimesSync(env, new Date(), new Date(Date.now() + 10_000))
    t += 30_000
    expect(isKnown(registry, 'second-token-value')).toBe(false)
    t += 30_000
    expect(isKnown(registry, 'second-token-value')).toBe(true)
    expect(isKnown(registry, 'first-token-value')).toBe(false)
  })

  it('picks up a new file under a glob once its directory changes', () => {
    let t = 0
    write('projects/alpha/.env', 'API_TOKEN=alpha-token-value\n')
    const registry = registryFor([{ path: 'projects/*/.env', format: 'dotenv' }], () => t)
    expect(isKnown(registry, 'gamma-token-value')).toBe(false)
    write('projects/gamma/.env', 'API_TOKEN=gamma-token-value\n')
    utimesSync(join(dir, 'projects'), new Date(), new Date(Date.now() + 10_000))
    t += 60_000
    expect(isKnown(registry, 'gamma-token-value')).toBe(true)
  })

  it('re-reads when the configuration itself changes', () => {
    let t = 0
    write('a.env', 'API_TOKEN=a-token-value-1\n')
    write('b.env', 'API_TOKEN=b-token-value-2\n')
    const registry = registryFor([{ path: 'a.env', format: 'dotenv' }], () => t)
    expect(isKnown(registry, 'b-token-value-2')).toBe(false)
    const config = write('sources.json', JSON.stringify({ sources: [{ path: 'b.env', format: 'dotenv' }] }))
    utimesSync(config, new Date(), new Date(Date.now() + 10_000))
    t += 60_000
    expect(isKnown(registry, 'b-token-value-2')).toBe(true)
    expect(isKnown(registry, 'a-token-value-1')).toBe(false)
  })
})

describe('masked text', () => {
  it('masking already-masked text is a no-op, even for a value that occurs inside a placeholder', () => {
    write('run/secrets/word_secret', 'REDACTED\n')
    write('run/secrets/api_token', `${ALNUM}\n`)
    const registry = registryFor([{ path: 'run/secrets/*', format: 'value' }])
    const once = mask(registry, `a REDACTED b ${ALNUM}`)
    expect(once).toBe('a [REDACTED:word_secret] b [REDACTED:api_token]')
    expect(mask(registry, once)).toBe(once)
  })

  it('never logs a registered value', () => {
    write('run/secrets/api_token', `${ALNUM}\n`)
    write('run/secrets/bad_secret', `two ${ALNUM} words`)
    write('bad.json', `{"password": "${ALNUM}"`)
    const registry = registryFor([
      { path: 'run/secrets/*', format: 'value' },
      { path: 'bad.json', format: 'json-keys' },
      { path: 'missing.env', format: 'dotenv' },
    ])
    registry.findKnownValues(ALNUM)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(ALNUM)
  })
})

describe('scrubSecrets masks registered values', () => {
  it('replaces a known value with its key name, kind known', async () => {
    write('deploy.env', `DEPLOY_PASS=dp-${ALNUM}\n`)
    const configPath = write('sources.json', JSON.stringify({ sources: [{ path: 'deploy.env', format: 'dotenv' }] }))
    vi.stubEnv('ENGRAM_SECRET_SOURCES_FILE', configPath)
    vi.resetModules()
    const { scrubSecrets } = await import('../../src/ingest/scrub-secrets.js')
    const result = await scrubSecrets(`deploy with dp-${ALNUM} and a note`)
    expect(result.text).toBe('deploy with [REDACTED:DEPLOY_PASS] and a note')
    expect(result.redactions).toEqual([{ kind: 'known', name: 'DEPLOY_PASS' }])
  })
})
