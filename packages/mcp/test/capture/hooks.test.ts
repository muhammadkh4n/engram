/**
 * The Claude Code capture hooks: each one hands its input to a detached
 * worker and exits 0 without printing, whatever arrives on stdin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOOK_AT_ENV, HOOK_INPUT_ENV } from '../../src/capture/hook-input.js'
import { startWorker } from '../../src/hooks/hook-entry.js'

const PKG_DIR = resolve(import.meta.dirname, '..', '..')
const HOOKS = ['user-prompt-submit', 'stop', 'pre-compact', 'session-end', 'session-start'] as const
const SESSION = '00000000-0000-4000-8000-000000004410'
const AT = '2026-10-05T10:00:00.000Z'

const homes: string[] = []

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'engram-capture-hooks-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** The env a hook process runs with: a throwaway HOME and no server, so nothing leaves the machine. */
function hookEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const name of ['ENGRAM_SERVER_URL', 'ENGRAM_CAPTURE_TOKEN_FILE', 'ENGRAM_PROJECT_REGISTRY_FILE', 'ENGRAM_SECRET_SOURCES_FILE']) {
    delete env[name]
  }
  env.XDG_CACHE_HOME = join(home, 'cache')
  return env
}

interface HookRun {
  code: number | null
  stdout: string
  stderr: string
}

function runNode(args: string[], home: string, stdin: string | null): Promise<HookRun> {
  const child = spawn(process.execPath, args, { cwd: PKG_DIR, env: hookEnv(home), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
  if (stdin !== null) child.stdin.end(stdin)
  return new Promise((done) => child.on('close', (code) => done({ code, stdout, stderr })))
}

function runHook(name: string, home: string, stdin: string | null): Promise<HookRun> {
  return runNode(['--import', 'tsx', join(PKG_DIR, 'src', 'hooks', `${name}.ts`)], home, stdin)
}

function captureLog(home: string): string {
  try {
    return readFileSync(join(home, '.engram', 'capture.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Waits for the detached worker's run line in the capture log. */
async function workerLine(home: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    const line = captureLog(home)
      .split('\n')
      .find((l) => l.includes(' worker '))
    if (line) return line
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the capture worker wrote no run line')
}

function validInput(home: string): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: join(home, 'absent', `${SESSION}.jsonl`),
    cwd: home,
    permission_mode: 'default',
    source: 'startup',
    trigger: 'manual',
    reason: 'other',
  })
}

describe('hook entry files', () => {
  it.each(HOOKS)('%s prints nothing, exits 0 and starts the worker for valid input', async (name) => {
    const home = freshHome()
    const run = await runHook(name, home, validInput(home))
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' })
    const kind = name === 'user-prompt-submit' ? 'drain' : name
    expect(await workerLine(home)).toContain(` worker ${kind} session=00000000 `)
  }, 20_000)

  it.each(HOOKS)('%s prints nothing, exits 0 and starts nothing for invalid and empty stdin', async (name) => {
    const home = freshHome()
    for (const stdin of ['{not json', '', '[1,2]', 'null']) {
      expect(await runHook(name, home, stdin)).toEqual({ code: 0, stdout: '', stderr: '' })
    }
    expect(existsSync(join(home, '.engram'))).toBe(false)
  }, 30_000)

  it('exits 0 within its own deadline when stdin never closes', async () => {
    const home = freshHome()
    const child = spawn(process.execPath, ['--import', 'tsx', join(PKG_DIR, 'src', 'hooks', 'stop.ts')], {
      cwd: PKG_DIR,
      env: hookEnv(home),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    const code = await new Promise<number | null>((done) => child.on('exit', done))
    child.stdin.destroy()
    expect(code).toBe(0)
    expect(stdout).toBe('')
  }, 20_000)

  it.each(HOOKS)('importing %s with stdin closed runs nothing', async (name) => {
    const home = freshHome()
    const url = pathToFileURL(join(PKG_DIR, 'src', 'hooks', `${name}.ts`)).href
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
      cwd: PKG_DIR,
      env: hookEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (out += c.toString()))
    const code = await new Promise<number | null>((done) => child.on('close', done))
    expect(code).toBe(0)
    expect(out).toBe('')
    expect(existsSync(join(home, '.engram'))).toBe(false)
  }, 20_000)

  it('a 200,000-character prompt starts the worker without the prompt in its input', async () => {
    const home = freshHome()
    const prompt = 'p'.repeat(200_000)
    const run = await runHook('user-prompt-submit', home, JSON.stringify({ session_id: SESSION, cwd: home, prompt }))
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(await workerLine(home)).toContain(' worker drain ')
  }, 20_000)
})

describe('startWorker', () => {
  function fakeSpawn() {
    const child = { on: vi.fn(), unref: vi.fn() }
    const spawnFn = vi.fn(() => child)
    return { spawnFn, child }
  }

  it('passes the forwarded keys and the start time, never the prompt or the final message', () => {
    const home = freshHome()
    const { spawnFn, child } = fakeSpawn()
    const raw = JSON.stringify({
      session_id: SESSION,
      transcript_path: '/t/x.jsonl',
      cwd: '/w',
      agent_id: 'a-1',
      prompt: 'p'.repeat(200_000),
      last_assistant_message: 'final words',
      permission_mode: 'default',
      stop_hook_active: false,
    })

    expect(startWorker('drain', raw, { env: { HOME: home }, at: AT, spawn: spawnFn as never })).toBe(true)

    expect(spawnFn).toHaveBeenCalledOnce()
    const [command, args, options] = spawnFn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; detached: boolean }]
    expect(command).toBe(process.execPath)
    expect(args.slice(-3)).toEqual([expect.stringMatching(/capture[/\\]worker\.(js|ts)$/), '--hook', 'drain'])
    expect(options.detached).toBe(true)
    expect(JSON.parse(options.env[HOOK_INPUT_ENV]!)).toEqual({ session_id: SESSION, transcript_path: '/t/x.jsonl', cwd: '/w', agent_id: 'a-1' })
    expect(options.env[HOOK_INPUT_ENV]).not.toContain('final words')
    expect(options.env[HOOK_AT_ENV]).toBe(AT)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('starts no worker for a Stop fired while a Stop hook is active', () => {
    const { spawnFn } = fakeSpawn()
    const raw = JSON.stringify({ session_id: SESSION, stop_hook_active: true })
    expect(startWorker('stop', raw, { env: { HOME: freshHome() }, at: AT, spawn: spawnFn as never })).toBe(false)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('returns false instead of throwing when the spawn throws', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn EAGAIN')
    })
    expect(startWorker('stop', JSON.stringify({ session_id: SESSION }), { env: { HOME: freshHome() }, at: AT, spawn: spawnFn as never })).toBe(false)
  })
})
