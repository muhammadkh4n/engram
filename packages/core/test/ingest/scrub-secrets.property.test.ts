/**
 * Redaction guarantees over random passwords:
 *   - a value registered from the machine's secret files is masked in every
 *     syntax it can be written in, down to the last 4-character piece;
 *   - an unregistered value is guaranteed only where its syntax identifies it
 *     as a credential (JWT, Authorization header, URL userinfo). Anywhere else
 *     an unregistered password is left for the review list: that is the known
 *     gap of redacting only what is certain, and it is not asserted here.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { scrubSecrets } from '../../src/ingest/scrub-secrets.js'
import { scrubMessage } from '../../src/ingest/scrub-message.js'
import { isShellReference } from '../../src/ingest/value-extent.js'
import { useNoRegistry, useTempRegistry } from './registry-fixture.js'

// A seeded generator so any failure reproduces exactly.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PASSWORD_COUNT = 500
const MIN_LENGTH = 6
const MAX_LENGTH = 40
const WINDOW = 4

/**
 * Printable ASCII (space through `~`, quotes and backslash included). The
 * first and last characters are never spaces: HTTP headers and YAML plain
 * scalars cannot carry them. A password that is a whole shell reference
 * (`$Abc12`) is excluded, because that text is a reference by definition.
 */
function randomPasswords(seed: number): string[] {
  const rand = mulberry32(seed)
  const out: string[] = []
  while (out.length < PASSWORD_COUNT) {
    const length = MIN_LENGTH + Math.floor(rand() * (MAX_LENGTH - MIN_LENGTH + 1))
    let pw = ''
    for (let i = 0; i < length; i++) {
      const edge = i === 0 || i === length - 1
      const lo = edge ? 0x21 : 0x20
      pw += String.fromCharCode(lo + Math.floor(rand() * (0x7f - lo)))
    }
    if (!isShellReference(pw)) out.push(pw)
  }
  return out
}

const PASSWORDS = randomPasswords(0x5ec12e7)

// Encoders write each password the way the syntax requires, as a tool or a
// person producing valid input would.
const SHELL_SAFE_RE = /^[A-Za-z0-9_.,:@%+=/-]+$/
const shellQuote = (s: string): string => (SHELL_SAFE_RE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
const shellDoubleInner = (s: string): string => s.replace(/[\\"$`]/g, (c) => `\\${c}`)
const dotenvValue = (s: string): string => (SHELL_SAFE_RE.test(s) ? s : `"${shellDoubleInner(s)}"`)
const jsSingleInner = (s: string): string => s.replace(/[\\']/g, (c) => `\\${c}`)
const jsDoubleInner = (s: string): string => s.replace(/[\\"]/g, (c) => `\\${c}`)
const YAML_PLAIN_RE = /^[A-Za-z0-9][A-Za-z0-9 _./+=-]*[A-Za-z0-9]$/
const yamlValue = (s: string): string => (YAML_PLAIN_RE.test(s) ? s : JSON.stringify(s))
const flagValue = (flag: string, s: string): string => (s.startsWith('-') ? `${flag}=${shellQuote(s)}` : `${flag} ${shellQuote(s)}`)
const xmlText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

interface Syntax {
  name: string
  render: (pw: string) => string
  keys: string[]
}

const SYNTAXES: Syntax[] = [
  { name: 'env file', render: (pw) => `NODE_ENV=production\nDB_PASSWORD=${dotenvValue(pw)}\nPORT=3000`, keys: ['NODE_ENV=production', 'DB_PASSWORD=', 'PORT=3000'] },
  { name: 'export', render: (pw) => `export DB_PASSWORD=${shellQuote(pw)}`, keys: ['export DB_PASSWORD='] },
  { name: 'YAML', render: (pw) => `database:\n  host: db.internal\n  password: ${yamlValue(pw)}\n  port: 5432`, keys: ['host: db.internal', 'password: ', 'port: 5432'] },
  { name: 'JSON with escapes', render: (pw) => `{"user": "engram", "password": ${JSON.stringify(pw)}, "port": 5432}`, keys: ['"user": "engram"', '"password": ', '"port": 5432'] },
  { name: 'JS object, single quotes', render: (pw) => `const config = { user: 'engram', password: '${jsSingleInner(pw)}', port: 5432 }`, keys: ["user: 'engram'", 'password: ', 'port: 5432 }'] },
  { name: 'JS object, double quotes', render: (pw) => `const config = { apiKey: "${jsDoubleInner(pw)}", timeout: 30 }`, keys: ['apiKey: ', 'timeout: 30 }'] },
  {
    name: 'pm2 ecosystem block',
    render: (pw) =>
      [
        'module.exports = {',
        "  apps: [{ name: 'engram-mcp-http', env: {",
        `      NEO4J_PASSWORD: '${jsSingleInner(pw)}',`,
        `      ENGRAM_AUTH_TOKEN: "${jsDoubleInner(pw)}",`,
        '      PORT: 3100,',
        '  } }],',
        '}',
      ].join('\n'),
    keys: ["name: 'engram-mcp-http'", 'NEO4J_PASSWORD: ', 'ENGRAM_AUTH_TOKEN: ', 'PORT: 3100,'],
  },
  { name: 'docker -e', render: (pw) => `docker run -d -e NEO4J_PASSWORD=${shellQuote(pw)} -p 7687:7687 neo4j:5`, keys: ['-e NEO4J_PASSWORD=', ' -p 7687:7687 neo4j:5'] },
  { name: 'curl Authorization: Bearer', render: (pw) => `curl -s -H "Authorization: Bearer ${shellDoubleInner(pw)}" https://api.example.com/v1/models`, keys: ['"Authorization: Bearer ', ' https://api.example.com/v1/models'] },
  { name: 'raw Authorization header', render: (pw) => `GET /v1/models HTTP/1.1\nHost: api.example.com\nAuthorization: Bearer ${pw}\nAccept: */*`, keys: ['Host: api.example.com', 'Authorization: Bearer ', 'Accept: */*'] },
  { name: 'curl x-api-key', render: (pw) => `curl -H 'x-api-key: ${pw.replace(/'/g, `'\\''`)}' https://api.example.com`, keys: ["'x-api-key: ", ' https://api.example.com'] },
  { name: 'raw x-api-key header', render: (pw) => `POST /v1/messages HTTP/1.1\nx-api-key: ${pw}\ncontent-type: application/json`, keys: ['x-api-key: ', 'content-type: application/json'] },
  { name: 'curl -u', render: (pw) => `curl -u ${shellQuote(`engram:${pw}`)} https://api.example.com/v1`, keys: ['curl -u ', 'engram:', ' https://api.example.com/v1'] },
  { name: 'mysql -p', render: (pw) => `mysql -h db -u root -p${shellQuote(pw)} engram`, keys: ['mysql -h db -u root -p', ' engram'] },
  { name: 'URL userinfo', render: (pw) => `psql postgresql://engram:${encodeURIComponent(pw)}@db.internal:5432/engram -c "select 1"`, keys: ['postgresql://engram:', '@db.internal:5432/engram'] },
  { name: 'PGPASSWORD prefix', render: (pw) => `PGPASSWORD=${shellQuote(pw)} psql -h db -U engram`, keys: ['PGPASSWORD=', ' psql -h db -U engram'] },
  { name: '--password flag', render: (pw) => `psql ${flagValue('--password', pw)} -h db`, keys: ['--password', ' -h db'] },
  { name: 'prose', render: (pw) => `I set the staging password to ${pw} and restarted the service.`, keys: ['I set the staging password to ', ' and restarted the service.'] },
  {
    name: 'JSON-in-JSON',
    render: (pw) => JSON.stringify({ tool: 'Bash', output: JSON.stringify({ user: 'engram', password: pw }) }),
    keys: ['{"tool":"Bash","output":', '\\"user\\":\\"engram\\"', '\\"password\\":'],
  },
  { name: 'query string', render: (pw) => `GET /callback?code=abc&token=${encodeURIComponent(pw)}&state=xyz HTTP/1.1`, keys: ['GET /callback?code=abc&token=', '&state=xyz HTTP/1.1'] },
  { name: 'TS typed declaration', render: (pw) => `const dbPassword: string = '${jsSingleInner(pw)}'\nconnect(dbPassword)`, keys: ['const dbPassword: string = ', 'connect(dbPassword)'] },
  { name: 'subscript assignment', render: (pw) => `process.env['DB_PASSWORD'] = "${jsDoubleInner(pw)}"\nstart()`, keys: ["process.env['DB_PASSWORD'] = ", 'start()'] },
  { name: 'XML', render: (pw) => `<datasource>\n  <user>engram</user>\n  <password>${xmlText(pw)}</password>\n</datasource>`, keys: ['<user>engram</user>', '<password>', '</password>'] },
]

/** Syntaxes that identify a credential by themselves: the value must redact even when nobody registered it. */
const SELF_IDENTIFYING: Syntax[] = [
  ...SYNTAXES.filter((s) => ['curl Authorization: Bearer', 'raw Authorization header', 'URL userinfo'].includes(s.name)),
  {
    name: 'JWT',
    render: (pw) => `session cookie: ${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub: pw }))}.${b64url(pw + pw)} expires soon`,
    keys: ['session cookie: ', ' expires soon'],
  },
]

/** The JWT syntax writes the password only in base64url; its pieces are what must not survive. */
const encodingsOf = (syntax: Syntax, pw: string): string[] =>
  syntax.name === 'JWT'
    ? [b64url(JSON.stringify({ sub: pw })), b64url(pw + pw)]
    : [encodeURIComponent(pw), JSON.stringify(pw), JSON.stringify(JSON.stringify(pw)), xmlText(pw)]

function windows(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i + WINDOW <= s.length; i++) out.push(s.slice(i, i + WINDOW))
  return out
}

/**
 * Four-character pieces of the password (raw, and as the syntax encoded it)
 * still present in the output. A piece that also occurs in the surrounding
 * syntax or a placeholder proves nothing and is ignored.
 */
function survivors(pw: string, encodings: string[], output: string, scaffold: string): string[] {
  const context = scaffold + (output.match(/\[REDACTED:[^\]]*\]/g) ?? []).join(' ')
  const pieces = new Set([pw, ...encodings].flatMap(windows))
  return [...pieces].filter((w) => output.includes(w) && !context.includes(w))
}

const registered = Object.fromEntries(PASSWORDS.map((pw, i) => [`PW_${String(i).padStart(3, '0')}_PASSWORD`, pw]))

async function assertMasked(syntax: Syntax, pw: string): Promise<void> {
  const scaffold = syntax.render('')
  const input = syntax.render(pw)
  const { text } = await scrubSecrets(input)
  const leaked = survivors(pw, encodingsOf(syntax, pw), text, scaffold)
  expect(leaked, `${syntax.name}\ninput:  ${input}\noutput: ${text}`).toEqual([])
  for (const key of syntax.keys) expect(text, `${syntax.name}: ${input}`).toContain(key)
}

describe('scrubSecrets — registered random passwords in every syntax', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useTempRegistry(registered)
  })
  afterAll(() => restore())

  for (const syntax of SYNTAXES) {
    it(`${syntax.name}: ${PASSWORD_COUNT} passwords leave no ${WINDOW}-character piece and keep the keys`, async () => {
      for (const pw of PASSWORDS) await assertMasked(syntax, pw)
    }, 60_000)
  }
})

describe('scrubSecrets — unregistered random passwords in self-identifying syntax', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useNoRegistry()
  })
  afterAll(() => restore())

  for (const syntax of SELF_IDENTIFYING) {
    it(`${syntax.name}: ${PASSWORD_COUNT} passwords leave no ${WINDOW}-character piece and keep the keys`, async () => {
      for (const pw of PASSWORDS) await assertMasked(syntax, pw)
    }, 60_000)
  }

  it(`metadata object: ${PASSWORD_COUNT} passwords under secret-named keys are replaced whole`, async () => {
    for (const pw of PASSWORDS) {
      const { message } = await scrubMessage({
        role: 'user',
        content: [{ type: 'tool_use', id: 't', name: 'deploy', input: { target: 'prod', apiKey: pw } }],
        metadata: { password: pw, nested: { authToken: pw, region: 'eu-west-1' } },
      })
      const serialized = JSON.stringify(message)
      expect(survivors(pw, [JSON.stringify(pw)], serialized, 'target prod region eu-west-1'), pw).toEqual([])
      expect(message.metadata).toEqual({
        password: '[REDACTED:password]',
        nested: { authToken: '[REDACTED:authToken]', region: 'eu-west-1' },
      })
    }
  }, 60_000)
})

// Hook-shaped text with credential-adjacent words and no credential values.
const NEGATIVE_CORPUS: string[] = [
  'TOKEN_LIMIT=4096\nMAX_TOKENS=8192\nAUTH_ENABLED=true\nPASSWORD_MIN_LENGTH=12',
  'ACCESS_KEY_ID_ENV=AWS_ACCESS_KEY_ID\nCLIENT_ID=engram-web\nDEFAULT_API_KEY_ENV=OPENAI_API_KEY',
  "export const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'",
  'const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })',
  'const apiKey = opts.apiKey ?? process.env.ENGRAM_API_KEY',
  '  apiKey: config.openai.apiKey,\n  token: await getToken(session),\n  password: args.password,',
  'interface Opts {\n  apiKey: string\n  token?: string\n  password: string | null\n}',
  'function login(user: string, password: string): Promise<Session>',
  'if (!token) throw new Error("missing token")',
  'const { data, error } = await supabase.auth.getSession()',
  '{"usage": {"prompt_tokens": 812, "completion_tokens": 64, "total_tokens": 876}, "token": null}',
  'OPENAI_API_KEY=$OPENAI_API_KEY\nNEO4J_PASSWORD=${NEO4J_PASSWORD}\nTOKEN=$(cat ~/.token)',
  'docker run -d -e NEO4J_PASSWORD="$NEO4J_PASSWORD" -p 7687:7687 neo4j:5',
  'curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user',
  'mkdir -p dist && cp -pr src/assets dist/ && sort -u list.txt && git push -u origin fix/r',
  'ssh -p 2222 deploy@rexvps && mysql -u root -p engram',
  'Author: Muhammad Khan <mk@example.com>\nDate:   Tue Sep 30 10:00:00 2026',
  'commit 8e64f8700acc19327d5815c13c6a03dab002c7c7\nMerge: dccfd86 52d0e2b',
  'episode 3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b stored in 12ms',
  'see https://github.com/muhammadkh4n/engram/blob/main/packages/core/src/memory.ts#L500',
  'The token expired, so I rotated the password yesterday and restarted the service.',
  'I rotated the password: see the runbook.',
  '<input type="password" name="password" autocomplete="current-password" />',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY=public-anon-value\nVITE_API_BASE=https://api.example.com',
  'PWD=/home/mk/projects/engram\nOLDPWD=/home/mk',
  "const CACHE_KEY = 'recall:v2'\nconst STORAGE_KEY = 'engram.settings'",
  "useQuery({ queryKey: ['recall', id], queryFn: fetchRecall })",
  '{items.map((item) => <Row key={item.id} item={item} />)}',
  'requireAuth: false\nauth: {\n  provider: github\n}',
  'password := os.Getenv("DB_PASSWORD")',
  'this.apiKey = options.apiKey\nconst token = await getToken()',
  'max_tokens: ANSWER_MAX_TOKENS,\napprox_tokens=chars/4\ntokenizer: cl100k_base',
  'tokensIn: resp.usage?.prompt_tokens ?? 0,\nsecret: opts.secret!,',
  'consol: ~2x passes x ~99K tokens  = ~$0.05',
  'DB_URI=postgresql://engram:<pwd>@db:5432/engram',
  'DATABASE_URL=postgres://engram:${DB_PASSWORD}@db:5432/engram',
  'NEO4J_URI=bolt://localhost:7687\nREDIS_URL=redis://cache:6379/0',
  'npm run build && npx vitest run test/ingest --maxWorkers=2',
  "fetch('/api/session', { method: 'POST', credentials: 'include' })",
  'const reqHasAuth = Boolean(req.headers.authorization)\nif (!reqHasAuth) return res.status(401).end()',
  'grep -rn "password=" src/ && sed -i \'s/password=.*/password=CHANGEME/\' .env.example',
  'Usage: engram-ingest [options]\n  --token <token>     API token for the HTTP server\n  --password <pw>     database password',
  'const SESSION_LAUNCHED_KEY = "engram:session-launched"',
  'db_password: ENC[AES256_GCM,data:q2W9xLkV0pA=,iv:Zm9vYmFyYmF6cXV4,tag:YmFzZTY0dGFn,type:str]',
  '{"db_password": "ENC[AES256_GCM,data:q2W9xLkV0pA=,iv:Zm9vYmFyYmF6cXV4,tag:YmFzZTY0dGFn,type:str]"}',
  'NEO4J_PASSWORD=ENC[AES256_GCM,data:q2W9xLkV0pA=,iv:Zm9vYmFyYmF6cXV4,tag:YmFzZTY0dGFn,type:str]',
  'git checkout -b feature/ACA-2447-software-inventory && git push -u origin fix/PROG-230-review-renewals',
  'password: hunter2\nDB_PASSWORD: "SUPER_SECRET_PW",',
  'curl -u admin:pa55word https://api.example.com && mysql -u root -pS3cret engram',
  'The issue_key ACA-2331 and the stepKey deploy-3 stay searchable.',
]

describe('scrubSecrets — a fixed negative corpus stays byte-identical', () => {
  let restore: () => void = () => {}
  beforeAll(() => {
    restore = useNoRegistry()
  })
  afterAll(() => restore())

  for (const input of NEGATIVE_CORPUS) {
    it(`keeps ${input.split('\n')[0]!.slice(0, 60)}`, async () => {
      expect(await scrubSecrets(input)).toEqual({ text: input, redactions: [] })
    })
  }
})
