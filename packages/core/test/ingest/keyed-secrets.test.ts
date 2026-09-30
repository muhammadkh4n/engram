import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { isCandidateSecretKey, isPublicKey, isStructuredSecretKey } from '../../src/ingest/secret-keys.js'
import { findSecretCandidates } from '../../src/ingest/secret-candidates.js'
import { scrubSecrets } from '../../src/ingest/scrub-secrets.js'
import { scrubMessage } from '../../src/ingest/scrub-message.js'
import { useNoRegistry } from './registry-fixture.js'

let restoreRegistry: () => void = () => {}
beforeAll(() => {
  restoreRegistry = useNoRegistry()
})
afterAll(() => restoreRegistry())

/** Replaces each candidate span the way a redaction would, to show exactly what was flagged. */
function markCandidates(text: string): string {
  let out = text
  for (const c of findSecretCandidates(text).reverse()) out = out.slice(0, c.start) + `[REDACTED:${c.name ?? c.kind}]` + out.slice(c.end)
  return out
}

describe('isCandidateSecretKey — the last word of the key decides', () => {
  const secret = [
    'NEO4J_PASSWORD', 'PGPASSWORD', 'DB_PASSWD', 'DB_PWD', 'DB_PW', 'DB_PASS', 'smtpPass', 'OPENSEARCH_PASS', 'GPG_PASSPHRASE', 'CLIENT_SECRET',
    'clientsecret', 'authToken', 'GITHUB_TOKEN', 'GOOGLE_CREDENTIALS', 'basicAuth', 'Authorization', 'SENTRY_DSN',
    'COOKIE_SIGNING_SALT', 'Set-Cookie', 'X-Api-Key', 'API_KEY', 'APIKEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'AWS_SECRET_ACCESS_KEY', 'PRIVATE_KEY', 'SECRET_KEY_BASE', 'db.password', 'spring.datasource.password',
    'DB_PASSWORD_PROD', 'STRIPE_SECRET_KEY_LIVE', 'API_KEY_V2', 'PRIVATE_KEY_B64', 'SECRET_KEY_FOR_PRODUCTION',
  ]
  const notSecret = [
    'TOKEN_LIMIT', 'MAX_TOKENS', 'max_tokens', 'tokenizer', 'tokensIn', 'AUTH_ENABLED', 'ACCESS_KEY_ID', 'CLIENT_ID',
    'DEFAULT_API_KEY_ENV', 'PASSWORD_MIN_LENGTH', 'NEO4J_PASSWORD_FILE', 'tokenName', 'Author', 'DATABASE_URL',
    'cacheKey', 'sort_key', 'PRIMARY_KEY', 'foreignKey', 'partitionKey', 'idempotencyKey', 'queryKey', 'STORAGE_KEY',
    'key', 'KEY', 'PWD', 'OLDPWD', 'passwordHash', 'secrets', 'issue_key', 'COLUMN_KEY', 'stepKey', 'payloadKey',
    'sourceKey', 'project_key', 'pass', 'PASS', 'xKey', 'angleKey', 's3Key', 'no-auth', 'non-secret',
    'Access-Control-Allow-Credentials',
  ]

  for (const name of secret) it(`${name} holds a secret`, () => expect(isCandidateSecretKey(name)).toBe(true))
  for (const name of notSecret) it(`${name} does not`, () => expect(isCandidateSecretKey(name)).toBe(false))

  it('in structured data a bare pass and only the core data words before KEY decide', () => {
    for (const name of ['pass', 'PASS', 'project_key', 'issue_key', 'NO_AUTH_TOKEN', 'NEO4J_PASSWORD']) expect(isStructuredSecretKey(name)).toBe(true)
    for (const name of ['cacheKey', 'sort_key', 'translation_key', 'TOKEN_LIMIT', 'PWD']) expect(isStructuredSecretKey(name)).toBe(false)
  })

  it('treats browser-exposed and publishable keys as public', () => {
    for (const name of ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_API_KEY', 'REACT_APP_TOKEN', 'SUPABASE_ANON_KEY', 'STRIPE_PUBLISHABLE_KEY', 'publicKey', 'sentry_key']) {
      expect(isPublicKey(name)).toBe(true)
    }
    expect(isPublicKey('SUPABASE_SERVICE_ROLE_KEY')).toBe(false)
  })
})

describe('keyed candidates in free text — extent comes from the syntax', () => {
  const redacted: Array<[string, string]> = [
    ['SECRET_KEY_BASE=f00dfeed', 'SECRET_KEY_BASE=[REDACTED:SECRET_KEY_BASE]'],
    ['DB_PASSWORD_PROD=hunter2', 'DB_PASSWORD_PROD=[REDACTED:DB_PASSWORD_PROD]'],
    ['SUPABASE_SERVICE_ROLE_KEY=role-key-value', 'SUPABASE_SERVICE_ROLE_KEY=[REDACTED:SUPABASE_SERVICE_ROLE_KEY]'],
    ['PGPASSWORD=s3cr3t psql -h db -U engram', 'PGPASSWORD=[REDACTED:PGPASSWORD] psql -h db -U engram'],
    ['DB_PASSWORD=a;b,c)d psql', 'DB_PASSWORD=[REDACTED:DB_PASSWORD] psql'],
    ['DB_PASSWORD="with \\"quotes\\" and spaces"', 'DB_PASSWORD="[REDACTED:DB_PASSWORD]"'],
    ["export DB_PASSWORD='it'\\''s here' && run", "export DB_PASSWORD='[REDACTED:DB_PASSWORD]' && run"],
    ['{"password": "a\\"b\\\\c", "user": "x"}', '{"password": "[REDACTED:password]", "user": "x"}'],
    ['  password: two words here', '  password: [REDACTED:password]'],
    ['password = hunter2', 'password = [REDACTED:password]'],
    ['Cookie: session=abc; theme=dark', 'Cookie: [REDACTED:Cookie]'],
    ['SENTRY_DSN=https://k3y@o1.ingest.sentry.io/42', 'SENTRY_DSN=[REDACTED:SENTRY_DSN]'],
    ['send it with X-Api-Key: abc123 please', 'send it with X-Api-Key: [REDACTED:X-Api-Key] please'],
    ["curl -H 'x-api-key: ab'\\''cd' https://api.example.com", "curl -H 'x-api-key: [REDACTED:x-api-key]' https://api.example.com"],
    ['docker run -e "NEO4J_PASSWORD=two words" neo4j', 'docker run -e "NEO4J_PASSWORD=[REDACTED:NEO4J_PASSWORD]" neo4j'],
    ['run `DB_PASSWORD=abc` first', 'run `DB_PASSWORD=[REDACTED:DB_PASSWORD]` first'],
    ['**Password:** hunter2', '**Password:** [REDACTED:Password]'],
    ['+  password: hunter2', '+  password: [REDACTED:password]'],
    ['    12\t  password: hunter2', '    12\t  password: [REDACTED:password]'],
    ['config.yaml:3:  password: hunter2', 'config.yaml:3:  password: [REDACTED:password]'],
    ['password := "hunter2"', 'password := "[REDACTED:password]"'],
    ['requireAuth: "false"', 'requireAuth: "[REDACTED:requireAuth]"'],
    ["DB_PASSWORD='$ecret'", "DB_PASSWORD='[REDACTED:DB_PASSWORD]'"],
    ['psql --password Sup3r-S3cret -h db', 'psql --password [REDACTED:password] -h db'],
    ["tool --api-key 'two words' --verbose", "tool --api-key '[REDACTED:api-key]' --verbose"],
    ['DB_PASSWORD==starts-with-equals', 'DB_PASSWORD=[REDACTED:DB_PASSWORD]'],
    ["  'password' => 'hunter2',", "  'password' => '[REDACTED:password]',"],
    ['x-api-key: `abc`def', 'x-api-key: [REDACTED:x-api-key]'],
  ]

  for (const [input, expected] of redacted) {
    it(`flags the value in ${input}`, () => {
      expect(markCandidates(input)).toBe(expected)
    })
  }

  const cli: Array<[string, string]> = [
    ['curl -u admin:pa55word https://api.example.com', 'curl -u admin:[REDACTED:cli-password] https://api.example.com'],
    ["curl -s -u 'admin:it'\\''s' https://x.test", "curl -s -u 'admin:[REDACTED:cli-password]' https://x.test"],
    ['curl --user=admin:pa55word https://x.test', 'curl --user=admin:[REDACTED:cli-password] https://x.test'],
    ['mysql -h db -u root -pS3cret engram', 'mysql -h db -u root -p[REDACTED:cli-password] engram'],
    ["mysqldump -u root -p'two words' engram", "mysqldump -u root -p'[REDACTED:cli-password]' engram"],
  ]

  for (const [input, expected] of cli) {
    it(`flags the CLI password in ${input} and leaves the text alone`, async () => {
      expect(markCandidates(input)).toBe(expected)
      expect(findSecretCandidates(input).map((c) => c.kind)).toEqual(['cli-password'])
      expect(await scrubSecrets(input)).toEqual({ text: input, redactions: [] })
    })
  }

  const kept = [
    'NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-public-value',
    'VITE_API_KEY=browser-key',
    'STRIPE_KEY=pk_live_51Habc',
    'PWD=/home/mk/projects/engram',
    "const cacheKey = 'user:1'",
    "const STORAGE_KEY = 'engram.settings'",
    "  queryKey: ['todos'],",
    'PRIMARY_KEY=id',
    'password := os.Getenv("DB_PASSWORD")',
    '  this.apiKey = options.apiKey',
    '  token = await getToken(session)',
    'requireAuth: false',
    '{"token": null, "password": null}',
    '  token?: string',
    '  auth: {',
    'mysql -u root -p engram',
    'mkdir -p build && docker run -p 8080:80 img && git push -u origin main && ssh -p 22 host && sort -u f',
    'curl -u admin https://api.example.com',
    'mysql -p"$MYSQL_PWD" engram',
    'curl -u "$API_USER:$API_PASS" https://api.example.com',
    'DATABASE_URL=postgres://engram:${DB_PASSWORD}@db:5432/engram',
    'TOKEN=`cat ~/.token`',
    'I rotated the password: see the runbook.',
    "if (password == 'hunter2' || token === 'abc') deny()",
    'users.filter(password => password.length > 8)',
  ]

  for (const input of kept) {
    it(`neither flags nor redacts ${input}`, async () => {
      expect(findSecretCandidates(input)).toEqual([])
      expect(await scrubSecrets(input)).toEqual({ text: input, redactions: [] })
    })
  }
})

describe('scrubMessage — values under secret-named object keys', () => {
  it('replaces the whole string whatever characters it holds', async () => {
    const tricky = 'a "quoted"\nmulti-line \\ value'
    const { message, redactions } = await scrubMessage({
      role: 'user',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', apiKey: tricky } }],
      metadata: { password: tricky, nested: { authToken: tricky, note: 'kept' } },
    })
    const serialized = JSON.stringify(message)
    expect(serialized).not.toContain('quoted')
    expect(message.metadata).toEqual({
      password: '[REDACTED:password]',
      nested: { authToken: '[REDACTED:authToken]', note: 'kept' },
    })
    expect(redactions.map((r) => r.name)).toEqual(['apiKey', 'password', 'authToken'])
  })
})

describe('scrubMessage — structured walks', () => {
  it('redacts numbers under secret-named keys and keeps other numbers', async () => {
    const { message } = await scrubMessage({ role: 'user', content: 'x', metadata: { pin_password: 12345678, port: 5432 } })
    expect(message.metadata).toEqual({ pin_password: '[REDACTED:pin_password]', port: 5432 })
  })

  it('replaces whatever lies past the depth limit instead of storing it unscrubbed', async () => {
    let deep: Record<string, unknown> = { password_hint: 'leaf' }
    for (let i = 0; i < 40; i++) deep = { next: deep }
    const { message, redactions } = await scrubMessage({ role: 'user', content: 'x', metadata: deep })
    expect(JSON.stringify(message.metadata)).toContain('[REDACTED:depth-limit]')
    expect(JSON.stringify(message.metadata)).not.toContain('leaf')
    expect(redactions).toEqual([{ kind: 'depth-limit' }])
  })
})
