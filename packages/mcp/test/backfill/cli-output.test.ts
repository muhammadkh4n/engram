/**
 * The built backfill CLI writing to a pipe. Node hands a pipe write to the OS
 * asynchronously once the pipe buffer (64 KiB) is full, and exiting the
 * process drops whatever is still queued, so a summary over 64 KiB piped to
 * `tee` was cut mid-line with its exit code lost. These run the compiled
 * entry, as an operator does, with stdout a pipe.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBackfillCli } from '../../src/backfill/engram-backfill-cli.js'

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'backfill', 'engram-backfill-cli.js')

/** Enough checkouts that the dry-run summary is several times the pipe buffer. */
const CHECKOUTS = 600
const MIN_OUTPUT_BYTES = 200 * 1024

let home: string
let argv: string[]
let env: Record<string, string>

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'engram-backfill-pipe-')))
  const reposDir = join(home, 'src')
  mkdirSync(reposDir)
  // Each child has a .git directory, so it is read as a checkout and listed as
  // a repository the registry does not hold: one summary line per checkout.
  for (let i = 0; i < CHECKOUTS; i++) {
    mkdirSync(join(reposDir, `checkout-${String(i).padStart(4, '0')}-${'x'.repeat(180)}`, '.git'), { recursive: true })
  }
  const registryFile = join(home, 'registry.json')
  writeFileSync(
    registryFile,
    JSON.stringify({
      version: 1,
      workspaces: { acme: { root: reposDir, vault_folder: null, register_prefix: null } },
      projects: { 'acme-web': { workspace: 'acme', vault_folder: null, register_prefix: null } },
    }),
  )
  argv = ['git', '--repos-under', reposDir, '--target', 'http://127.0.0.1:9/mcp', '--registry', registryFile]
  env = { HOME: home, PATH: process.env['PATH'] ?? '' }
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

interface Run {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: Buffer
  stderr: string
}

/** Runs the built CLI with stdout and stderr as pipes; `closeAfterFirstChunk` closes the reader's end early. */
function runBuilt(closeAfterFirstChunk: boolean): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk)
      if (closeAfterFirstChunk) child.stdout.destroy()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: err }))
  })
}

describe('dist/backfill/engram-backfill-cli.js with stdout a pipe', () => {
  it('is built (the checks below run the compiled entry)', () => {
    expect(existsSync(ENTRY)).toBe(true)
  })

  it('delivers every byte of an output over 200 KiB, closing line included, with the command exit code', async () => {
    const expected: string[] = []
    const expectedCode = await runBackfillCli(argv, env, { out: (t) => expected.push(t), err: () => undefined })
    const want = expected.join('')
    expect(Buffer.byteLength(want)).toBeGreaterThan(MIN_OUTPUT_BYTES)
    expect(want.endsWith('  stopped: none\n')).toBe(true)

    const run = await runBuilt(false)

    expect(run.stderr).toBe('')
    expect(run.stdout.length).toBe(Buffer.byteLength(want))
    expect(run.stdout.toString('utf8')).toBe(want)
    expect(run.code).toBe(expectedCode)
  }, 60_000)

  it('exits without hanging or crashing when the reader closes the pipe early', async () => {
    const run = await runBuilt(true)

    expect(run.signal).toBeNull()
    expect(run.code).toBe(0)
    expect(run.stdout.length).toBeLessThan(MIN_OUTPUT_BYTES)
    // A write error nobody listens for would crash the process with its stack.
    expect(run.stderr).not.toMatch(/EPIPE|Error/)
  }, 60_000)
})
