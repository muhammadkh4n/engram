/**
 * Real-Postgres test harness on locally built images.
 *
 * Opt-in, like the Neo4j integration tests: a suite runs only when
 * ENGRAM_TEST_PG_IMAGE (and, for PostgREST, ENGRAM_TEST_POSTGREST_IMAGE)
 * names an image that already exists on this machine. Nothing is pulled:
 * a missing image is an error naming the build command, and every container
 * starts with `--pull never`.
 *
 * Postgres alone runs with `--network none`; every statement goes through
 * `docker exec` and the server's local socket. When PostgREST is wanted, both
 * containers join a bridge network created for this run, and PostgREST
 * publishes its port on 127.0.0.1 only.
 *
 * Passwords, the JWT secret and tokens are passed to docker through the
 * environment of the docker CLI process (never argv) and never printed.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const realPgImage = process.env.ENGRAM_TEST_PG_IMAGE || undefined
export const postgrestImage = process.env.ENGRAM_TEST_POSTGREST_IMAGE || undefined

const SCHEMA_SQL = fileURLToPath(new URL('../../schema.sql', import.meta.url))
const BM25_SQL = fileURLToPath(new URL('../../bm25.sql', import.meta.url))

const DATABASE = 'engram'
const INIT_COMPLETE_LINE = 'PostgreSQL init process complete; ready for start up.'
const PG_READY_TIMEOUT_MS = 60_000
const POSTGREST_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 250
const ROLE_NAME = /^[a-z_][a-z0-9_]*$/

export interface ApplyResult {
  stdout: string
  stderr: string
}

export interface PsqlSession {
  /** Runs SQL in this session's connection and resolves with its output. */
  run(sql: string): Promise<string>
  close(): Promise<void>
}

export interface PostgrestEndpoint {
  url: string
  serviceJwt: string
}

export interface RealPgOptions {
  /**
   * Put Postgres on a bridge network so startPostgrest() can reach it.
   * Without it the container has no network at all.
   */
  withPostgrest?: boolean
}

export interface RealPg {
  /** Runs SQL as postgres; resolves with unaligned, tuples-only output. */
  psql(sql: string): Promise<string>
  /** Runs SQL as postgres after SET ROLE <role>. */
  psqlAs(role: string, sql: string): Promise<string>
  /** Applies a SQL file in one transaction with ON_ERROR_STOP. */
  apply(path: string): Promise<ApplyResult>
  /** Applies schema.sql, then bm25.sql. */
  applySchema(): Promise<void>
  /** pg_dump --schema-only without the per-dump \restrict / \unrestrict lines. */
  dumpSchema(): Promise<string>
  /** An open psql connection whose state (transactions, locks) persists across run() calls. */
  session(): Promise<PsqlSession>
  /** Starts PostgREST against this database; call it after the schema is applied. */
  startPostgrest(): Promise<PostgrestEndpoint>
  stop(): Promise<void>
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Containers and networks still alive, removed by stop() or at process exit. */
const liveContainers = new Set<string>()
const liveNetworks = new Set<string>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const name of liveContainers) {
      spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' })
    }
    for (const name of liveNetworks) {
      spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' })
    }
  })
}

function runProcess(
  command: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(options.input ?? '')
  })
}

async function docker(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const result = await runProcess('docker', args, options)
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} failed (exit ${result.code}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

async function requireImage(image: string): Promise<void> {
  const result = await runProcess('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
  if (result.code !== 0) {
    throw new Error(
      `Docker image ${image} is not present locally and is never pulled. ` +
        `Build it with: docker build -t ${image} packages/postgrest/docker`,
    )
  }
}

function randomSecret(): string {
  return randomBytes(32).toString('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

function quoteRole(role: string): string {
  if (!ROLE_NAME.test(role)) throw new Error(`Not a plain role name: ${role}`)
  return `"${role}"`
}

function stripRestrictLines(dump: string): string {
  return dump
    .split('\n')
    .filter((line) => !line.startsWith('\\restrict') && !line.startsWith('\\unrestrict'))
    .join('\n')
}

async function waitFor(what: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
}

const PSQL_FLAGS = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']

const LOCK_WAIT_TIMEOUT_MS = 10_000

/** Resolves once the backend `pid` is waiting on a lock held by another transaction. */
export async function waitUntilLockWait(pg: RealPg, pid: string): Promise<void> {
  if (!/^\d+$/.test(pid)) throw new Error(`not a backend pid: ${pid}`)
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const waiting = await pg.psql(`SELECT coalesce(wait_event_type, '') FROM pg_stat_activity WHERE pid = ${pid}`)
    if (waiting === 'Lock') return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`backend ${pid} never waited on a lock`)
}

export async function startRealPg(options: RealPgOptions = {}): Promise<RealPg> {
  if (!realPgImage) throw new Error('ENGRAM_TEST_PG_IMAGE is not set')
  await requireImage(realPgImage)
  if (options.withPostgrest) {
    if (!postgrestImage) throw new Error('ENGRAM_TEST_POSTGREST_IMAGE is not set')
    await requireImage(postgrestImage)
  }
  installExitHook()

  const runId = `engram-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const pgContainer = `${runId}-pg`
  const postgrestContainer = `${runId}-postgrest`
  const network = options.withPostgrest ? runId : null
  const authenticatorPassword = randomSecret()

  if (network) {
    await docker(['network', 'create', '--driver', 'bridge', network])
    liveNetworks.add(network)
  }

  liveContainers.add(pgContainer)
  await docker(
    [
      'run', '--pull', 'never', '--rm', '-d',
      '--name', pgContainer,
      '--network', network ?? 'none',
      '-e', 'POSTGRES_PASSWORD',
      '-e', `POSTGRES_DB=${DATABASE}`,
      // A throwaway cluster needs no durable initdb; its fsync pass alone takes ~20 s.
      '-e', 'POSTGRES_INITDB_ARGS=--no-sync',
      realPgImage,
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: randomSecret() } },
  )

  const execPsql = (flags: string[], input: string) =>
    runProcess('docker', ['exec', '-i', pgContainer, 'psql', ...flags, '-U', 'postgres', '-d', DATABASE], { input })

  const psql = async (sql: string): Promise<string> => {
    const result = await execPsql(PSQL_FLAGS, sql)
    if (result.code !== 0) {
      // An error on the role statement would quote it; never let the password through.
      const stderr = result.stderr.split(authenticatorPassword).join('<redacted>').trim()
      throw new Error(`psql failed (exit ${result.code}): ${stderr}`)
    }
    return result.stdout.replace(/\n$/, '')
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const name of [postgrestContainer, pgContainer]) {
      if (!liveContainers.has(name)) continue
      await runProcess('docker', ['rm', '-f', '-v', name])
      liveContainers.delete(name)
    }
    if (network) {
      await runProcess('docker', ['network', 'rm', network])
      liveNetworks.delete(network)
    }
  }

  try {
    await waitFor('the Postgres init process', PG_READY_TIMEOUT_MS, async () => {
      const logs = await runProcess('docker', ['logs', pgContainer])
      if (logs.code !== 0) throw new Error(`Postgres container exited: ${logs.stderr.trim()}`)
      return `${logs.stdout}${logs.stderr}`.includes(INIT_COMPLETE_LINE)
    })
    await waitFor('pg_isready', PG_READY_TIMEOUT_MS, async () => {
      const ready = await runProcess('docker', ['exec', pgContainer, 'pg_isready', '-q', '-U', 'postgres', '-d', DATABASE])
      return ready.code === 0
    })
    // The roles a production database carries. No default privileges are
    // granted, so a new table is reachable only through its own grants.
    await psql(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE ROLE engram_authenticator LOGIN NOINHERIT PASSWORD '${authenticatorPassword}';
      GRANT anon, authenticated, service_role TO engram_authenticator;
    `)
  } catch (error) {
    await stop()
    throw error
  }

  const apply = async (path: string): Promise<ApplyResult> => {
    const sql = await readFile(path, 'utf8')
    const result = await execPsql(['-X', '-1', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql)
    if (result.code !== 0) {
      throw new Error(`Applying ${path} failed (exit ${result.code}): ${result.stderr.trim()}`)
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }

  const startPostgrest = async (): Promise<PostgrestEndpoint> => {
    if (!network || !postgrestImage) {
      throw new Error('startPostgrest() needs startRealPg({ withPostgrest: true })')
    }
    if (liveContainers.has(postgrestContainer)) throw new Error('PostgREST is already running')
    const jwtSecret = randomSecret()
    liveContainers.add(postgrestContainer)
    await docker(
      [
        'run', '--pull', 'never', '--rm', '-d',
        '--name', postgrestContainer,
        '--network', network,
        '-p', '127.0.0.1::3000',
        '-e', 'PGRST_DB_URI',
        '-e', 'PGRST_DB_SCHEMAS=public',
        '-e', 'PGRST_DB_ANON_ROLE=anon',
        '-e', 'PGRST_JWT_SECRET',
        postgrestImage,
      ],
      {
        env: {
          ...process.env,
          PGRST_DB_URI: `postgres://engram_authenticator:${authenticatorPassword}@${pgContainer}:5432/${DATABASE}`,
          PGRST_JWT_SECRET: jwtSecret,
        },
      },
    )
    const mapping = (await docker(['port', postgrestContainer, '3000/tcp'])).trim().split('\n')[0]
    const port = mapping.slice(mapping.lastIndexOf(':') + 1)
    if (!mapping.startsWith('127.0.0.1:') || !/^\d+$/.test(port)) {
      throw new Error(`Unexpected PostgREST port mapping: ${mapping}`)
    }
    const url = `http://127.0.0.1:${port}`
    await waitFor('PostgREST to answer GET / with 200', POSTGREST_READY_TIMEOUT_MS, async () => {
      try {
        const response = await fetch(`${url}/`)
        await response.body?.cancel()
        return response.status === 200
      } catch {
        return false
      }
    })
    return { url, serviceJwt: signHs256Jwt({ role: 'service_role' }, jwtSecret) }
  }

  return {
    psql,
    psqlAs: async (role, sql) => psql(`SET ROLE ${quoteRole(role)};\n${sql}`),
    apply,
    applySchema: async () => {
      await apply(SCHEMA_SQL)
      await apply(BM25_SQL)
    },
    dumpSchema: async () => {
      const result = await runProcess('docker', ['exec', pgContainer, 'pg_dump', '--schema-only', '-U', 'postgres', '-d', DATABASE])
      if (result.code !== 0) throw new Error(`pg_dump failed (exit ${result.code}): ${result.stderr.trim()}`)
      return stripRestrictLines(result.stdout)
    },
    session: () => openSession(pgContainer),
    startPostgrest,
    stop,
  }
}

interface PendingRun {
  sentinel: string
  stdout: string | null
  stderr: string | null
  resolve: (output: string) => void
  reject: (error: Error) => void
}

/**
 * One long-lived psql process. Each run() writes the SQL followed by a unique
 * sentinel echoed to both stdout and stderr; the run completes when both
 * streams reach it, so an error printed on stderr is attributed to the run
 * that caused it. ON_ERROR_STOP is off: an error rejects that run and the
 * connection stays open, as an application connection would.
 */
async function openSession(container: string): Promise<PsqlSession> {
  const child: ChildProcessWithoutNullStreams = spawn(
    'docker',
    ['exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-U', 'postgres', '-d', DATABASE],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const pending: PendingRun[] = []
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let exited = false
  let counter = 0
  const sentinelPrefix = `__engram_session_${randomBytes(6).toString('hex')}_`

  const settle = (): void => {
    while (pending.length > 0 && pending[0].stdout !== null && pending[0].stderr !== null) {
      const run = pending.shift() as PendingRun
      const stderr = run.stderr as string
      if (/\bERROR:/.test(stderr)) run.reject(new Error(stderr.trim()))
      else run.resolve((run.stdout as string).replace(/\n$/, ''))
    }
  }

  const drain = (stream: 'stdout' | 'stderr'): void => {
    for (const run of pending) {
      if (run[stream] !== null) continue
      const buffer = stream === 'stdout' ? stdoutBuffer : stderrBuffer
      const marker = `${run.sentinel}\n`
      const index = buffer.indexOf(marker)
      if (index === -1) return
      run[stream] = buffer.slice(0, index)
      const rest = buffer.slice(index + marker.length)
      if (stream === 'stdout') stdoutBuffer = rest
      else stderrBuffer = rest
    }
  }

  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdoutBuffer += chunk
    drain('stdout')
    settle()
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderrBuffer += chunk
    drain('stderr')
    settle()
  })
  const exitedPromise = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      exited = true
      for (const run of pending.splice(0)) {
        run.reject(new Error(`psql session exited (code ${code}): ${stderrBuffer.trim()}`))
      }
      resolve()
    })
  })
  child.on('error', () => undefined)

  return {
    run: (sql: string) =>
      new Promise<string>((resolve, reject) => {
        if (exited) {
          reject(new Error('psql session is closed'))
          return
        }
        const sentinel = `${sentinelPrefix}${counter++}`
        pending.push({ sentinel, stdout: null, stderr: null, resolve, reject })
        child.stdin.write(`${sql}\n\\echo ${sentinel}\n\\warn ${sentinel}\n`)
      }),
    close: async () => {
      if (!exited) child.stdin.end('\\q\n')
      await exitedPromise
    },
  }
}
