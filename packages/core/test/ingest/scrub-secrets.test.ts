import { describe, it, expect } from 'vitest'
import { scrubSecrets } from '../../src/ingest/scrub-secrets.js'

// Token-shaped fixtures are assembled at runtime so the source file never
// carries a literal that a push-time secret scanner would flag. None of them
// is a real credential.
const MIXED = 'Q7xk2Lm9Vp4Rt8Wz'
const OPENAI_KEY = 'sk-proj-' + MIXED + MIXED + 'Ab3'
const OPENROUTER_KEY = 'sk-or-v1-' + '9f8e7d6c5b4a3210'.repeat(4)
const ANTHROPIC_KEY = 'sk-ant-api03-' + MIXED + MIXED + MIXED
const GITHUB_PAT_CLASSIC = 'ghp_' + MIXED + MIXED + 'Zq4Y'
const GITHUB_OAUTH = 'gho_' + MIXED + MIXED + 'Zq4Y'
const GITHUB_SERVER = 'ghs_' + MIXED + MIXED + 'Zq4Y'
const GITHUB_FINE_GRAINED = 'github_pat_' + '11ABCDE2F0' + MIXED + '_' + MIXED + MIXED
const AWS_ACCESS_KEY = 'AKIA' + 'Z7Q2W4E6R8T1Y3U5'
const SLACK_BOT = 'xoxb-' + '1234567890-0987654321-' + MIXED
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
  '.' +
  'eyJzdWIiOiJzZXJ2aWNlLXJvbGUiLCJpYXQiOjE3MDAwMDAwMDB9' +
  '.' +
  'dGhpcy1pcy1ub3QtYS1yZWFsLXNpZ25hdHVyZQ'
const HIGH_ENTROPY = 'Zx8Kq2Lr7Vm4Tn9Wp3Ys6Hd1Jf5Gb0Ce'
const PEM_BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'bm90IGEgcmVhbCBrZXkgbWF0ZXJpYWw=']

function kinds(text: string): string[] {
  return scrubSecrets(text).redactions.map((r) => r.kind)
}

describe('scrubSecrets — named assignments keep the key name', () => {
  it('redacts a .env line and keeps the key', () => {
    const { text, redactions } = scrubSecrets('NEO4J_PASSWORD=hunter2hunter2')
    expect(text).toBe('NEO4J_PASSWORD=[REDACTED:NEO4J_PASSWORD]')
    expect(redactions).toEqual([{ kind: 'named-secret', name: 'NEO4J_PASSWORD' }])
  })

  it('redacts an export line', () => {
    const { text } = scrubSecrets(`export OPENAI_API_KEY=${OPENAI_KEY}`)
    expect(text).toBe('export OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]')
  })

  it('redacts a YAML-style colon assignment', () => {
    const { text, redactions } = scrubSecrets('db:\n  password: s3cr3t-Value\n  port: 5432')
    expect(text).toBe('db:\n  password: [REDACTED:password]\n  port: 5432')
    expect(redactions).toEqual([{ kind: 'named-secret', name: 'password' }])
  })

  it('preserves quotes around the placeholder in JSON', () => {
    const { text, redactions } = scrubSecrets('{"SESSION_SECRET": "abc123def456", "PORT": "3100"}')
    expect(text).toBe('{"SESSION_SECRET": "[REDACTED:SESSION_SECRET]", "PORT": "3100"}')
    expect(redactions).toEqual([{ kind: 'named-secret', name: 'SESSION_SECRET' }])
  })

  it('redacts every secret in a pm2 ecosystem env block', () => {
    const block = [
      'module.exports = {',
      '  apps: [{',
      "    name: 'engram-mcp-http',",
      "    script: 'dist/server.js',",
      '    env: {',
      `      OPENAI_API_KEY: '${OPENAI_KEY}',`,
      `      OPENROUTER_API_KEY: '${OPENROUTER_KEY}',`,
      "      NEO4J_PASSWORD: 'correct-horse-battery',",
      `      SUPABASE_SERVICE_ROLE_KEY: '${JWT}',`,
      "      DATABASE_URL: 'postgresql://engram:Pg-Pass-99@db.internal:5432/engram',",
      "      ENGRAM_AUTH_TOKEN: 'tok_live_5a6b7c8d',",
      '      PORT: 3100,',
      '    },',
      '  }],',
      '}',
    ].join('\n')
    const { text, redactions } = scrubSecrets(block)
    expect(text).toContain("OPENAI_API_KEY: '[REDACTED:OPENAI_API_KEY]',")
    expect(text).toContain("OPENROUTER_API_KEY: '[REDACTED:OPENROUTER_API_KEY]',")
    expect(text).toContain("NEO4J_PASSWORD: '[REDACTED:NEO4J_PASSWORD]',")
    expect(text).toContain("SUPABASE_SERVICE_ROLE_KEY: '[REDACTED:jwt]',")
    expect(text).toContain("DATABASE_URL: 'postgresql://engram:[REDACTED:postgres-url]@db.internal:5432/engram',")
    expect(text).toContain("ENGRAM_AUTH_TOKEN: '[REDACTED:ENGRAM_AUTH_TOKEN]',")
    expect(text).toContain("name: 'engram-mcp-http',")
    expect(text).toContain('PORT: 3100,')
    for (const secret of [OPENAI_KEY, OPENROUTER_KEY, JWT, 'correct-horse-battery', 'Pg-Pass-99', 'tok_live_5a6b7c8d']) {
      expect(text).not.toContain(secret)
    }
    expect(redactions.map((r) => r.name).filter(Boolean)).toEqual([
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'NEO4J_PASSWORD',
      'ENGRAM_AUTH_TOKEN',
    ])
  })

  it('redacts a .env dump line by line', () => {
    const dump = [
      'NODE_ENV=production',
      `GITHUB_TOKEN=${GITHUB_PAT_CLASSIC}`,
      'SMTP_PASSWD="mail pass with spaces"',
      "GPG_PASSPHRASE='open sesame 42'",
      'GOOGLE_CREDENTIALS=b64creds0123',
      'NEO4J_URI=bolt://localhost:7687',
    ].join('\n')
    const { text } = scrubSecrets(dump)
    expect(text).toBe(
      [
        'NODE_ENV=production',
        'GITHUB_TOKEN=[REDACTED:GITHUB_TOKEN]',
        'SMTP_PASSWD="[REDACTED:SMTP_PASSWD]"',
        "GPG_PASSPHRASE='[REDACTED:GPG_PASSPHRASE]'",
        'GOOGLE_CREDENTIALS=[REDACTED:GOOGLE_CREDENTIALS]',
        'NEO4J_URI=bolt://localhost:7687',
      ].join('\n'),
    )
  })

  it('redacts the token of a curl Authorization header and keeps the scheme', () => {
    const cmd = `curl -s -H "Authorization: Bearer ${OPENAI_KEY}" https://api.example.com/v1/models`
    const { text, redactions } = scrubSecrets(cmd)
    expect(text).toBe(
      'curl -s -H "Authorization: Bearer [REDACTED:Authorization]" https://api.example.com/v1/models',
    )
    expect(redactions).toEqual([{ kind: 'named-secret', name: 'Authorization' }])
  })

  it('redacts hyphenated header keys and CLI flags', () => {
    expect(scrubSecrets('curl -H "X-Api-Key: 0a1b2c3d4e5f"').text).toBe(
      'curl -H "X-Api-Key: [REDACTED:X-Api-Key]"',
    )
    expect(scrubSecrets('psql --password=Sup3rS3cret').text).toBe('psql --password=[REDACTED:password]')
  })

  it('redacts query-string secrets without swallowing the next parameter', () => {
    expect(scrubSecrets('GET /cb?token=abc123&state=xyz').text).toBe(
      'GET /cb?token=[REDACTED:token]&state=xyz',
    )
  })
})

describe('scrubSecrets — known credential formats anywhere in text', () => {
  const cases: Array<[string, string]> = [
    [OPENAI_KEY, 'openai-key'],
    [OPENROUTER_KEY, 'openrouter-key'],
    [ANTHROPIC_KEY, 'anthropic-key'],
    [GITHUB_PAT_CLASSIC, 'github-token'],
    [GITHUB_OAUTH, 'github-token'],
    [GITHUB_SERVER, 'github-token'],
    [GITHUB_FINE_GRAINED, 'github-token'],
    [AWS_ACCESS_KEY, 'aws-access-key'],
    [SLACK_BOT, 'slack-token'],
    [JWT, 'jwt'],
  ]

  for (const [secret, kind] of cases) {
    it(`redacts a ${kind} embedded in prose`, () => {
      const { text, redactions } = scrubSecrets(`I pasted ${secret} into the terminal by mistake.`)
      expect(text).toBe(`I pasted [REDACTED:${kind}] into the terminal by mistake.`)
      expect(redactions).toEqual([{ kind }])
    })
  }

  it('redacts a PEM private key block through its END line', () => {
    const pem = [
      'here is the deploy key:',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...PEM_BODY,
      '-----END OPENSSH PRIVATE KEY-----',
      'and that is all',
    ].join('\n')
    const { text, redactions } = scrubSecrets(pem)
    expect(text).toBe('here is the deploy key:\n[REDACTED:private-key]\nand that is all')
    expect(redactions).toEqual([{ kind: 'private-key' }])
  })

  it('redacts a PEM block assigned to a named key without leaking the body', () => {
    const escaped = `PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n${PEM_BODY.join('\\n')}\\n-----END PRIVATE KEY-----\\n"`
    const { text } = scrubSecrets(escaped)
    expect(text).toBe('PRIVATE_KEY="[REDACTED:private-key]\\n"')
    for (const line of PEM_BODY) expect(text).not.toContain(line)
  })

  it('redacts a truncated PEM block to the end of the text', () => {
    const { text } = scrubSecrets(`key:\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY[0]}`)
    expect(text).toBe('key:\n[REDACTED:private-key]')
  })

  it('redacts only the password of a postgres URL', () => {
    const { text, redactions } = scrubSecrets('psql postgres://engram:Pg-Pass-99@localhost:5432/engram -c "select 1"')
    expect(text).toBe('psql postgres://engram:[REDACTED:postgres-url]@localhost:5432/engram -c "select 1"')
    expect(redactions).toEqual([{ kind: 'postgres-url' }])
  })

  it('redacts only the password of an https URL', () => {
    const { text, redactions } = scrubSecrets('git clone https://mk:gh-pass-77@git.example.com/repo.git')
    expect(text).toBe('git clone https://mk:[REDACTED:http-url]@git.example.com/repo.git')
    expect(redactions).toEqual([{ kind: 'http-url' }])
  })

  it('redacts the password of other connection-string schemes', () => {
    expect(scrubSecrets('redis://:r3dis-pw@cache:6379/0').text).toBe('redis://:[REDACTED:url-password]@cache:6379/0')
  })
})

describe('scrubSecrets — high-entropy values under unrecognised keys', () => {
  it('redacts a 32+ char mixed-class value after "="', () => {
    const { text, redactions } = scrubSecrets(`COOKIE_SIGNING_SALT=${HIGH_ENTROPY}`)
    expect(text).toBe('COOKIE_SIGNING_SALT=[REDACTED:high-entropy]')
    expect(redactions).toEqual([{ kind: 'high-entropy' }])
  })

  it('redacts a quoted 32+ char mixed-class value after ":"', () => {
    expect(scrubSecrets(`signingSalt: "${HIGH_ENTROPY}"`).text).toBe('signingSalt: "[REDACTED:high-entropy]"')
  })
})

describe('scrubSecrets — leaves non-secrets alone', () => {
  const untouched: Array<[string, string]> = [
    ['7-char commit sha', 'Fixed in commit dccfd86, see the log.'],
    ['40-char commit sha after a colon', 'head: dccfd86f9c05b9579a241a079e36950fed624795'],
    ['UUID', 'episode id: 3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b'],
    ['sha256 hex in prose', 'the tarball sha256 is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
    ['numeric token config', 'TOKEN_LIMIT=4096\nMAX_TOKENS: 8192\nAUTH_TIMEOUT_MS=30000'],
    ['key names listed without values', 'Set these: OPENAI_API_KEY= NEO4J_PASSWORD='],
    ['prose about passwords and tokens', 'I rotated the password yesterday and the token expired, so the password: see the runbook.'],
    [
      'base64 handling code',
      "const encoded = Buffer.from(payload).toString('base64')\nconst decoded = Buffer.from(encoded, 'base64').toString('utf8')",
    ],
    ['TypeScript interface fields', 'interface Opts {\n  apiKey: string\n  token?: string\n  password: string | null\n}'],
    ['env references in code', 'const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })'],
    ['shell variable references', 'curl -H "Authorization: Bearer $GITHUB_TOKEN" -d "password=${DB_PASSWORD}"'],
    ['code assignment from a call', 'const token = await getToken(session)'],
    ['git log author line', 'Author: Muhammad Khan <mk@example.com>'],
    ['plain URL', 'see https://github.com/muhammadkh4n/engram/blob/main/packages/core/src/memory.ts'],
    ['boolean auth flags', 'AUTH_ENABLED=true\nrequireAuth: false'],
    ['LLM token-count settings', 'max_tokens: ANSWER_MAX_TOKENS,\napprox_tokens=chars/4\ntokenizer: cl100k_base'],
    ['optional-chained member access', 'tokensIn: resp.usage?.prompt_tokens ?? 0,\nsecret: opts.secret!,'],
    ['a variable passed by name', 'const client = createClient({\n  apiKey: openaiKey,\n})'],
    ['an env var name as the value', "export const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'"],
    ['command substitution', '-e POSTGRES_PASSWORD="$(openssl rand -hex 24)"'],
    [
      'documentation placeholders',
      'export OPENAI_API_KEY=sk-...\n"NEO4J_PASSWORD": "...",\nDB_URI=postgresql://engram:<pwd>@db:5432/engram',
    ],
    ['cost estimates in comments', 'consol: ~2x passes x ~99K tokens  = ~$0.05'],
  ]

  for (const [label, input] of untouched) {
    it(`does not redact ${label}`, () => {
      const { text, redactions } = scrubSecrets(input)
      expect(redactions).toEqual([])
      expect(text).toBe(input)
    })
  }
})

describe('scrubSecrets — a literal under a secret-named key is redacted whatever its shape', () => {
  const redacted: Array<[string, string, string]> = [
    ['NEO4J_PASSWORD=correctHorse', 'NEO4J_PASSWORD=[REDACTED:NEO4J_PASSWORD]', 'NEO4J_PASSWORD'],
    ['DB_PASSWORD=SUPER_SECRET_PW', 'DB_PASSWORD=[REDACTED:DB_PASSWORD]', 'DB_PASSWORD'],
    ['ENGRAM_API_KEY=myApiKey', 'ENGRAM_API_KEY=[REDACTED:ENGRAM_API_KEY]', 'ENGRAM_API_KEY'],
    ['{"password": "MY_PROD_PASS"}', '{"password": "[REDACTED:password]"}', 'password'],
    ['API_KEY=abc.def.ghi', 'API_KEY=[REDACTED:API_KEY]', 'API_KEY'],
    ['export DB_PASSWORD=hunter2', 'export DB_PASSWORD=[REDACTED:DB_PASSWORD]', 'DB_PASSWORD'],
    ['password: hunter2', 'password: [REDACTED:password]', 'password'],
    ["      NEO4J_PASSWORD: 'correctHorse',", "      NEO4J_PASSWORD: '[REDACTED:NEO4J_PASSWORD]',", 'NEO4J_PASSWORD'],
    ['DB_PASSWORD: "SUPER_SECRET_PW",', 'DB_PASSWORD: "[REDACTED:DB_PASSWORD]",', 'DB_PASSWORD'],
    ['const password = `correctHorse`', 'const password = `[REDACTED:password]`', 'password'],
    ['docker run -e NEO4J_PASSWORD=correctHorse neo4j', 'docker run -e NEO4J_PASSWORD=[REDACTED:NEO4J_PASSWORD] neo4j', 'NEO4J_PASSWORD'],
    ['curl -H "X-Api-Key: myApiKey" https://api.example.com', 'curl -H "X-Api-Key: [REDACTED:X-Api-Key]" https://api.example.com', 'X-Api-Key'],
    ['Authorization: Bearer SUPER_SECRET_PW', 'Authorization: Bearer [REDACTED:Authorization]', 'Authorization'],
  ]

  for (const [input, expected, name] of redacted) {
    it(`redacts ${input.trim()}`, () => {
      const { text, redactions } = scrubSecrets(input)
      expect(text).toBe(expected)
      expect(redactions).toEqual([{ kind: 'named-secret', name }])
    })
  }

  const references: string[] = [
    "DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'",
    'const apiKey = openaiKey',
    '  apiKey: openaiKey,',
    '  apiKey: config.openai.apiKey,',
    'const token = await getToken()',
    '  password: args.password,',
    'OPENAI_API_KEY=$OPENAI_API_KEY',
    'API_KEY=${API_KEY}',
    'TOKEN=$(cat ~/.token)',
    'TOKEN_LIMIT=4096',
    'OPENAI_API_KEY= NEO4J_PASSWORD=',
    'NEO4J_PASSWORD_FILE=/run/secrets/neo4j',
    'const tokenName = "GITHUB_TOKEN"',
    'const auth = `Bearer ${token}`',
  ]

  for (const input of references) {
    it(`keeps the reference ${input.trim()}`, () => {
      const { text, redactions } = scrubSecrets(input)
      expect(redactions).toEqual([])
      expect(text).toBe(input)
    })
  }
})

describe('scrubSecrets — numeric values', () => {
  it('redacts a numeric value under a bare secret name', () => {
    expect(scrubSecrets('DB_PASSWORD=12345678').text).toBe('DB_PASSWORD=[REDACTED:DB_PASSWORD]')
  })

  it('keeps a numeric value under a qualified name', () => {
    expect(scrubSecrets('PASSWORD_MIN_LENGTH=12').redactions).toEqual([])
  })
})

describe('scrubSecrets — cost on long identifier-like runs', () => {
  it('stays linear on long runs that every pattern partially matches', () => {
    const inputs = [
      'foo.bar.'.repeat(20000),
      'eyJabc.'.repeat(20000),
      'ab-'.repeat(50000),
      '=abc'.repeat(50000),
      'iVBORw0KGgoAAAANSUhEUgAA'.repeat(4000),
    ]
    const started = Date.now()
    for (const input of inputs) scrubSecrets(input)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('scrubSecrets — idempotence', () => {
  const inputs = [
    'NEO4J_PASSWORD=hunter2hunter2',
    '{"SESSION_SECRET": "abc123def456"}',
    `curl -H "Authorization: Bearer ${OPENAI_KEY}"`,
    `I pasted ${ANTHROPIC_KEY} and ${JWT} and ${AWS_ACCESS_KEY}`,
    'postgres://engram:Pg-Pass-99@localhost/engram',
    `-----BEGIN PRIVATE KEY-----\n${PEM_BODY.join('\n')}\n-----END PRIVATE KEY-----`,
    `COOKIE_SIGNING_SALT=${HIGH_ENTROPY}`,
    'SUPABASE_SERVICE_ROLE_SECRET_KEY_FOR_PRODUCTION=abcdefgh',
  ]

  for (const input of inputs) {
    it(`re-scrubbing changes nothing: ${input.slice(0, 30)}`, () => {
      const once = scrubSecrets(input)
      expect(once.redactions.length).toBeGreaterThan(0)
      const twice = scrubSecrets(once.text)
      expect(twice.text).toBe(once.text)
      expect(twice.redactions).toEqual([])
    })
  }

  it('reports kinds in the order they were found per pass', () => {
    expect(kinds(`NEO4J_PASSWORD=x1y2 and ${SLACK_BOT}`)).toEqual(['named-secret', 'slack-token'])
  })
})
