import { describe, it, expect } from 'vitest'
import { scrubSecrets } from '../../src/ingest/scrub-secrets.js'
import { secretlintSpans } from '../../src/ingest/secretlint-spans.js'

// Token-shaped fixtures are assembled at runtime so the source file never
// carries a literal that a push-time secret scanner would flag. None of them
// is a real credential.
const MIXED = 'Q7xk2Lm9Vp4Rt8Wz'
const mixed = (n: number): string => MIXED.repeat(Math.ceil(n / MIXED.length)).slice(0, n)
const OPENAI_KEY = 'sk-proj-' + mixed(74) + 'T3BlbkFJ' + mixed(74)
const OPENROUTER_KEY = 'sk-or-v1-' + '9f8e7d6c5b4a3210'.repeat(4)
const ANTHROPIC_KEY = 'sk-ant-api03-' + mixed(93) + 'AA'
const ANTHROPIC_OAUTH = 'sk-ant-oat01-' + mixed(60)
const GITHUB_PAT_CLASSIC = 'ghp_' + MIXED + MIXED + 'Zq4Y'
const GITHUB_OAUTH = 'gho_' + MIXED + MIXED + 'Zq4Y'
const GITHUB_SERVER = 'ghs_' + MIXED + MIXED + 'Zq4Y'
const GITHUB_FINE_GRAINED = 'github_pat_' + '11ABCDE2F0' + mixed(12) + '_' + mixed(59)
const AWS_ACCESS_KEY = 'AKIA' + 'Z7Q2W4E6R8T1Y3U5'
const AWS_SECRET_KEY = mixed(40)
const SLACK_BOT = 'xoxb-' + '1234567890-0987654321-' + MIXED
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
  '.' +
  'eyJzdWIiOiJzZXJ2aWNlLXJvbGUiLCJpYXQiOjE3MDAwMDAwMDB9' +
  '.' +
  'dGhpcy1pcy1ub3QtYS1yZWFsLXNpZ25hdHVyZQ'
const HIGH_ENTROPY = 'Zx8Kq2Lr7Vm4Tn9Wp3Ys6Hd1Jf5Gb0Ce'
const PEM_BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'bm90IGEgcmVhbCBrZXkgbWF0ZXJpYWw=']
// Long enough, and with the ASN.1 magic bytes, for secretlint to treat it as key material.
const PEM_FULL_BODY = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + mixed(32), mixed(64), mixed(40) + '==']

async function kinds(text: string): Promise<string[]> {
  return ((await scrubSecrets(text))).redactions.map((r) => r.kind)
}

describe('scrubSecrets — named assignments keep the key name', () => {
  it('redacts a .env line and keeps the key', async () => {
    const { text, redactions } = await scrubSecrets('NEO4J_PASSWORD=hunter2hunter2')
    expect(text).toBe('NEO4J_PASSWORD=[REDACTED:NEO4J_PASSWORD]')
    expect(redactions).toEqual([{ kind: 'named-secret', name: 'NEO4J_PASSWORD' }])
  })

  it('redacts an export line', async () => {
    const { text } = await scrubSecrets(`export OPENAI_API_KEY=${OPENAI_KEY}`)
    expect(text).toBe('export OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]')
  })

  it('redacts a YAML-style colon assignment', async () => {
    const { text, redactions } = await scrubSecrets('db:\n  password: s3cr3t-Value\n  port: 5432')
    expect(text).toBe('db:\n  password: [REDACTED:password]\n  port: 5432')
    expect(redactions).toEqual([{ kind: 'named-secret', name: 'password' }])
  })

  it('preserves quotes around the placeholder in JSON', async () => {
    const { text, redactions } = await scrubSecrets('{"SESSION_SECRET": "abc123def456", "PORT": "3100"}')
    expect(text).toBe('{"SESSION_SECRET": "[REDACTED:SESSION_SECRET]", "PORT": "3100"}')
    expect(redactions).toEqual([{ kind: 'named-secret', name: 'SESSION_SECRET' }])
  })

  it('redacts every secret in a pm2 ecosystem env block', async () => {
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
    const { text, redactions } = await scrubSecrets(block)
    expect(text).toContain("OPENAI_API_KEY: '[REDACTED:OPENAI_API_KEY]',")
    expect(text).toContain("OPENROUTER_API_KEY: '[REDACTED:OPENROUTER_API_KEY]',")
    expect(text).toContain("NEO4J_PASSWORD: '[REDACTED:NEO4J_PASSWORD]',")
    expect(text).toContain("SUPABASE_SERVICE_ROLE_KEY: '[REDACTED:SUPABASE_SERVICE_ROLE_KEY]',")
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
      'SUPABASE_SERVICE_ROLE_KEY',
      'ENGRAM_AUTH_TOKEN',
    ])
  })

  it('redacts a .env dump line by line', async () => {
    const dump = [
      'NODE_ENV=production',
      `GITHUB_TOKEN=${GITHUB_PAT_CLASSIC}`,
      'SMTP_PASSWD="mail pass with spaces"',
      "GPG_PASSPHRASE='open sesame 42'",
      'GOOGLE_CREDENTIALS=b64creds0123',
      'NEO4J_URI=bolt://localhost:7687',
    ].join('\n')
    const { text } = await scrubSecrets(dump)
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

  it('redacts the token of a curl Authorization header and keeps the scheme', async () => {
    const cmd = `curl -s -H "Authorization: Bearer ${OPENAI_KEY}" https://api.example.com/v1/models`
    const { text, redactions } = await scrubSecrets(cmd)
    expect(text).toBe(
      'curl -s -H "Authorization: Bearer [REDACTED:Authorization]" https://api.example.com/v1/models',
    )
    expect(redactions).toEqual([{ kind: 'named-secret', name: 'Authorization' }])
  })

  it('redacts hyphenated header keys and CLI flags', async () => {
    expect((await scrubSecrets('curl -H "X-Api-Key: 0a1b2c3d4e5f"')).text).toBe(
      'curl -H "X-Api-Key: [REDACTED:X-Api-Key]"',
    )
    expect((await scrubSecrets('psql --password=Sup3rS3cret')).text).toBe('psql --password=[REDACTED:password]')
  })

  it('redacts query-string secrets without swallowing the next parameter', async () => {
    expect((await scrubSecrets('GET /cb?token=abc123&state=xyz')).text).toBe(
      'GET /cb?token=[REDACTED:token]&state=xyz',
    )
  })
})

describe('scrubSecrets — known credential formats anywhere in text', () => {
  const cases: Array<[string, string]> = [
    [OPENAI_KEY, 'openai'],
    [OPENROUTER_KEY, 'openrouter-key'],
    [ANTHROPIC_KEY, 'anthropic'],
    [ANTHROPIC_OAUTH, 'anthropic-key'],
    [GITHUB_PAT_CLASSIC, 'github'],
    [GITHUB_OAUTH, 'github'],
    [GITHUB_SERVER, 'github'],
    [GITHUB_FINE_GRAINED, 'github'],
    [AWS_ACCESS_KEY, 'aws'],
    [SLACK_BOT, 'slack'],
    [JWT, 'jwt'],
  ]

  for (const [secret, kind] of cases) {
    it(`redacts a ${kind} embedded in prose`, async () => {
      const { text, redactions } = await scrubSecrets(`I pasted ${secret} into the terminal by mistake.`)
      expect(text).toBe(`I pasted [REDACTED:${kind}] into the terminal by mistake.`)
      expect(redactions).toEqual([{ kind }])
    })
  }

  it('redacts a PEM private key block through its END line', async () => {
    const pem = [
      'here is the deploy key:',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...PEM_BODY,
      '-----END OPENSSH PRIVATE KEY-----',
      'and that is all',
    ].join('\n')
    const { text, redactions } = await scrubSecrets(pem)
    expect(text).toBe('here is the deploy key:\n[REDACTED:private-key]\nand that is all')
    expect(redactions).toEqual([{ kind: 'private-key' }])
  })

  it('redacts a PEM block assigned to a named key without leaking the body', async () => {
    const escaped = `PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n${PEM_BODY.join('\\n')}\\n-----END PRIVATE KEY-----\\n"`
    const { text } = await scrubSecrets(escaped)
    expect(text).toBe('PRIVATE_KEY="[REDACTED:PRIVATE_KEY]"')
    for (const line of PEM_BODY) expect(text).not.toContain(line)
  })

  it('redacts a truncated PEM block to the end of the text', async () => {
    const { text } = await scrubSecrets(`key:\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY[0]}`)
    expect(text).toBe('key:\n[REDACTED:private-key]')
  })

  it('redacts only the password of a postgres URL', async () => {
    const { text, redactions } = await scrubSecrets('psql postgres://engram:Pg-Pass-99@localhost:5432/engram -c "select 1"')
    expect(text).toBe('psql postgres://engram:[REDACTED:postgres-url]@localhost:5432/engram -c "select 1"')
    expect(redactions).toEqual([{ kind: 'postgres-url' }])
  })

  it('redacts only the password of an https URL', async () => {
    const { text, redactions } = await scrubSecrets('git clone https://mk:gh-pass-77@git.example.com/repo.git')
    expect(text).toBe('git clone https://mk:[REDACTED:http-url]@git.example.com/repo.git')
    expect(redactions).toEqual([{ kind: 'http-url' }])
  })

  it('redacts the password of other connection-string schemes', async () => {
    expect((await scrubSecrets('redis://:r3dis-pw@cache:6379/0')).text).toBe('redis://:[REDACTED:url-password]@cache:6379/0')
  })
})

describe('scrubSecrets — secretlint formats replace the value only', () => {
  const cases: Array<[string, string, string]> = [
    [`client = OpenAI(api="${OPENAI_KEY}", timeout=30)`, 'client = OpenAI(api="[REDACTED:openai]", timeout=30)', 'openai'],
    [`ANTHROPIC=${ANTHROPIC_KEY} claude -p hi`, 'ANTHROPIC=[REDACTED:anthropic] claude -p hi', 'anthropic'],
    [
      `git remote set-url origin https://${GITHUB_PAT_CLASSIC}@github.com/mk/engram.git`,
      'git remote set-url origin https://[REDACTED:github]@github.com/mk/engram.git',
      'github',
    ],
    [`echo ${GITHUB_FINE_GRAINED} | gh auth login --with-token`, 'echo [REDACTED:github] | gh auth login --with-token', 'github'],
    [`aws_access_key_id = ${AWS_ACCESS_KEY}\nregion = eu-west-1`, 'aws_access_key_id = [REDACTED:aws]\nregion = eu-west-1', 'aws'],
    [`SLACK_BOT=${SLACK_BOT} node bot.js`, 'SLACK_BOT=[REDACTED:slack] node bot.js', 'slack'],
    [
      `deploy key:\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_FULL_BODY.join('\n')}\n-----END RSA PRIVATE KEY-----\ndone`,
      'deploy key:\n[REDACTED:private-key]\ndone',
      'private-key',
    ],
    ['mongosh mongodb://admin:m0ngo-Pw-1@mongo:27017/db', 'mongosh mongodb://admin:[REDACTED:url-password]@mongo:27017/db', 'url-password'],
  ]

  for (const [input, expected, kind] of cases) {
    it(`redacts only the ${kind} value in ${input.slice(0, 24)}`, async () => {
      const { text, redactions } = await scrubSecrets(input)
      expect(text).toBe(expected)
      expect(redactions).toEqual([{ kind }])
    })
  }

  it('keeps the key name when secretlint reports an AWS secret key from the start of its key', async () => {
    const input = `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_KEY}`
    const spans = await secretlintSpans(input)
    expect(spans.map((s) => input.slice(s.start, s.end))).toEqual([AWS_SECRET_KEY])
    expect((await scrubSecrets(input)).text).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED:AWS_SECRET_ACCESS_KEY]')
  })

  it('narrows secretlint connection-string and basic-auth spans to the password', async () => {
    const pm2Line = "      DATABASE_URL: 'postgresql://engram:Pg-Pass-99@db.internal:5432/engram',"
    expect((await secretlintSpans(pm2Line)).map((s) => s.kind)).toEqual(['database-connection-string'])
    expect((await scrubSecrets(pm2Line)).text).toBe(
      "      DATABASE_URL: 'postgresql://engram:[REDACTED:postgres-url]@db.internal:5432/engram',",
    )
    const clone = 'git clone https://mk:gh-pass-77@git.example.com/repo.git'
    expect((await secretlintSpans(clone)).map((s) => s.kind)).toEqual(['basicauth'])
    expect((await scrubSecrets(clone)).text).toBe('git clone https://mk:[REDACTED:http-url]@git.example.com/repo.git')
  })

  it('ignores secretlint-disable comments inside the scanned text', async () => {
    const input = `// secretlint-disable\nI pasted ${OPENAI_KEY} here`
    expect((await scrubSecrets(input)).text).toBe('// secretlint-disable\nI pasted [REDACTED:openai] here')
  })

  it('leaves no performance marks behind, so repeated scans accumulate no state', async () => {
    const before = performance.getEntriesByType('mark').length
    for (let i = 0; i < 200; i++) await secretlintSpans(`DB_PASSWORD=value${i}`)
    expect(performance.getEntriesByType('mark').length).toBe(before)
  })

  it('keeps an AWS account id', async () => {
    const input = 'aws_account_id = 123456789012'
    expect(await scrubSecrets(input)).toEqual({ text: input, redactions: [] })
  })
})

describe('scrubSecrets — high-entropy values under unrecognised keys', () => {
  it('redacts a 32+ char mixed-class value after "="', async () => {
    const { text, redactions } = await scrubSecrets(`COOKIE_SIGNING_SEED=${HIGH_ENTROPY}`)
    expect(text).toBe('COOKIE_SIGNING_SEED=[REDACTED:high-entropy]')
    expect(redactions).toEqual([{ kind: 'high-entropy' }])
  })

  it('redacts a quoted 32+ char mixed-class value after ":"', async () => {
    expect((await scrubSecrets(`signingSeed: "${HIGH_ENTROPY}"`)).text).toBe('signingSeed: "[REDACTED:high-entropy]"')
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
    ['a documentation placeholder in a URL', 'DB_URI=postgresql://engram:<pwd>@db:5432/engram'],
    ['cost estimates in comments', 'consol: ~2x passes x ~99K tokens  = ~$0.05'],
  ]

  for (const [label, input] of untouched) {
    it(`does not redact ${label}`, async () => {
      const { text, redactions } = await scrubSecrets(input)
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
    ['export OPENAI_API_KEY=sk-...', 'export OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]', 'OPENAI_API_KEY'],
    ['"NEO4J_PASSWORD": "...",', '"NEO4J_PASSWORD": "[REDACTED:NEO4J_PASSWORD]",', 'NEO4J_PASSWORD'],
    ['DB_PASSWORD=true', 'DB_PASSWORD=[REDACTED:DB_PASSWORD]', 'DB_PASSWORD'],
  ]

  for (const [input, expected, name] of redacted) {
    it(`redacts ${input.trim()}`, async () => {
      const { text, redactions } = await scrubSecrets(input)
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
    it(`keeps the reference ${input.trim()}`, async () => {
      const { text, redactions } = await scrubSecrets(input)
      expect(redactions).toEqual([])
      expect(text).toBe(input)
    })
  }
})

describe('scrubSecrets — numeric values', () => {
  it('redacts a numeric value under a bare secret name', async () => {
    expect((await scrubSecrets('DB_PASSWORD=12345678')).text).toBe('DB_PASSWORD=[REDACTED:DB_PASSWORD]')
  })

  it('keeps a numeric value under a qualified name', async () => {
    expect((await scrubSecrets('PASSWORD_MIN_LENGTH=12')).redactions).toEqual([])
  })
})

describe('scrubSecrets — cost on long identifier-like runs', () => {
  it('stays linear on long runs that every pattern partially matches', async () => {
    const inputs = [
      'foo.bar.'.repeat(20000),
      'eyJabc.'.repeat(20000),
      'ab-'.repeat(50000),
      '=abc'.repeat(50000),
      'iVBORw0KGgoAAAANSUhEUgAA'.repeat(4000),
    ]
    const started = Date.now()
    for (const input of inputs) await scrubSecrets(input)
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
    it(`re-scrubbing changes nothing: ${input.slice(0, 30)}`, async () => {
      const once = await scrubSecrets(input)
      expect(once.redactions.length).toBeGreaterThan(0)
      const twice = await scrubSecrets(once.text)
      expect(twice.text).toBe(once.text)
      expect(twice.redactions).toEqual([])
    })
  }

  it('reports kinds in text order', async () => {
    expect(await kinds(`${SLACK_BOT} and NEO4J_PASSWORD=x1y2`)).toEqual(['slack', 'named-secret'])
  })
})
