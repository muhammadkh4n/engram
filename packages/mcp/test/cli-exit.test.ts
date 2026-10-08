import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliExit, exitOnError, exitWhenFlushed, whenFlushed } from '../src/cli-exit.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** A stream that holds each write for `delayMs` before handing it off, like a pipe whose reader is slow. */
function slowStream(delayMs: number): { stream: Writable; handedOff: string[] } {
  const handedOff: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      setTimeout(() => {
        handedOff.push(chunk.toString('utf8'))
        done()
      }, delayMs)
    },
  })
  return { stream, handedOff }
}

/** A stream whose reader closed: every non-empty write fails with EPIPE. */
function closedPipe(): Writable {
  return new Writable({
    write(_chunk, _enc, done) {
      const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      setTimeout(() => done(err), 5)
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('whenFlushed', () => {
  it('resolves true only after every earlier write was handed off', async () => {
    const { stream, handedOff } = slowStream(20)
    stream.write('first ')
    stream.write('second')

    const ok = await whenFlushed(stream)

    expect(ok).toBe(true)
    expect(handedOff.join('')).toBe('first second')
  })

  it('resolves false instead of hanging when the reader closed the pipe', async () => {
    const stream = closedPipe()
    stream.write('lost')

    await expect(whenFlushed(stream)).resolves.toBe(false)
  })

  it('resolves at once for a stream that was already destroyed', async () => {
    const { stream } = slowStream(1)
    stream.destroy()

    await expect(whenFlushed(stream)).resolves.toBe(true)
  })
})

describe('exitWhenFlushed', () => {
  it('exits with the code after both streams are flushed', async () => {
    const out = slowStream(15)
    const err = slowStream(5)
    out.stream.write('summary\n')
    err.stream.write('log\n')
    const exit = vi.fn((code: number): never => {
      expect(out.handedOff.join('')).toBe('summary\n')
      expect(err.handedOff.join('')).toBe('log\n')
      throw new CliExit(code)
    })

    await expect(exitWhenFlushed(3, { streams: [out.stream, err.stream], exit })).rejects.toMatchObject({ code: 3 })
    expect(exit).toHaveBeenCalledOnce()
  })

  it('keeps the command exit code when a stream failed', async () => {
    const out = closedPipe()
    out.write('lost')
    const exit = vi.fn((code: number): never => {
      throw new CliExit(code)
    })

    await expect(exitWhenFlushed(0, { streams: [out], exit })).rejects.toMatchObject({ code: 0 })
  })
})

describe('exitOnError', () => {
  it('writes a CliExit message to stderr and exits with its code', async () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
    const onFatal = vi.fn()
    const exit = vi.fn((code: number): never => {
      throw new CliExit(code)
    })

    await expect(exitOnError(new CliExit(2, '[tool] bad flag'), onFatal, { streams: [], exit })).rejects.toMatchObject({ code: 2 })

    expect(written).toEqual(['[tool] bad flag\n'])
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('reports any other error through onFatal and exits 1', async () => {
    const onFatal = vi.fn()
    const exit = vi.fn((code: number): never => {
      throw new CliExit(code)
    })
    const boom = new Error('boom')

    await expect(exitOnError(boom, onFatal, { streams: [], exit })).rejects.toMatchObject({ code: 1 })

    expect(onFatal).toHaveBeenCalledWith(boom)
  })
})

/**
 * Watchdog timers that bound a process's lifetime exit at once: waiting on a
 * stdout/stderr reader would defeat them, and none writes to either first.
 */
const IMMEDIATE_EXITS: Readonly<Record<string, number>> = {
  'capture/worker.ts': 1,
  'hooks/git-commit.ts': 1,
  'hooks/hook-entry.ts': 1,
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name)
    if (d.isDirectory()) return sourceFiles(path)
    return d.name.endsWith('.ts') ? [path] : []
  })
}

describe('process exits in packages/mcp/src', () => {
  it('go through exitWhenFlushed, apart from the watchdog timers', () => {
    const found: Record<string, number> = {}
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/')
      if (rel === 'cli-exit.ts') continue
      const count = readFileSync(file, 'utf8').split('process.exit(').length - 1
      if (count > 0) found[rel] = count
    }

    expect(found).toEqual(IMMEDIATE_EXITS)
  })
})
