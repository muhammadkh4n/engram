/**
 * ~/.engram holds captured conversation text, so the directory is owner-only
 * and every file in it is 0600, including ones an earlier version created
 * with the process umask.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appendPrivateFile, ensurePrivateDir, openPrivateFile } from '../src/ingest/private-files.js'
import { appendHookLog } from '../src/ingest/transcript-capture.js'

const PKG_DIR = resolve(import.meta.dirname, '..')

const homes: string[] = []

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'engram-private-files-'))
  homes.push(home)
  return home
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

/** Runs a hook entry point under `home` and resolves with its exit code. */
async function runHook(file: string, home: string): Promise<number | null> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  delete env['ENGRAM_SALIENCE_DISABLED']
  delete env['ENGRAM_SERVER_URL']
  const child = spawn(process.execPath, ['--import', 'tsx', join(PKG_DIR, 'src', 'hooks', file)], {
    cwd: PKG_DIR,
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  child.stdin.end(JSON.stringify({ session_id: 's-1', transcript_path: join(home, 'missing.jsonl'), cwd: home }))
  return new Promise((done) => child.on('exit', done))
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('hooks create private capture files', () => {
  it.each(['stop.ts', 'user-prompt-submit.ts'])(
    'a fresh HOME whose first writer is %s ends with ~/.engram 0700 and hook.log 0600',
    async (file) => {
      const home = freshHome()

      expect(await runHook(file, home)).toBe(0)

      expect(modeOf(join(home, '.engram'))).toBe(0o700)
      expect(modeOf(join(home, '.engram', 'hook.log'))).toBe(0o600)
    },
    20_000,
  )

  it('the Stop hook tightens an existing world-readable directory and hook.log', async () => {
    const home = freshHome()
    const dir = join(home, '.engram')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'hook.log'), 'earlier line\n')
    chmodSync(join(dir, 'hook.log'), 0o644)

    expect(await runHook('stop.ts', home)).toBe(0)

    expect(modeOf(dir)).toBe(0o700)
    expect(modeOf(join(dir, 'hook.log'))).toBe(0o600)
    expect(readFileSync(join(dir, 'hook.log'), 'utf8')).toContain('earlier line')
  }, 20_000)
})

describe('private file helpers', () => {
  it('creates the directory 0700 and tightens one that has group or other bits', () => {
    const home = freshHome()
    const dir = join(home, '.engram')
    ensurePrivateDir(dir)
    expect(modeOf(dir)).toBe(0o700)

    chmodSync(dir, 0o775)
    ensurePrivateDir(dir)
    expect(modeOf(dir)).toBe(0o700)
  })

  it('creates a file 0600 and tightens an existing 0644 file without truncating it', () => {
    const home = freshHome()
    const path = join(home, 'f.jsonl')
    appendPrivateFile(path, 'a\n')
    expect(modeOf(path)).toBe(0o600)

    chmodSync(path, 0o644)
    const fd = openPrivateFile(path, 'a')
    closeSync(fd)
    expect(modeOf(path)).toBe(0o600)
    appendPrivateFile(path, 'b\n')
    expect(readFileSync(path, 'utf8')).toBe('a\nb\n')
  })

  it('appendHookLog tightens an existing 0644 hook.log in a 0755 directory', () => {
    const home = freshHome()
    const dir = join(home, '.engram')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'hook.log'), '')
    chmodSync(join(dir, 'hook.log'), 0o644)

    appendHookLog({ HOME: home }, '[test] line')

    expect(modeOf(dir)).toBe(0o700)
    expect(modeOf(join(dir, 'hook.log'))).toBe(0o600)
    expect(readFileSync(join(dir, 'hook.log'), 'utf8')).toBe('[test] line\n')
  })
})
