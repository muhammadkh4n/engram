import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../src/ingest/private-files.js'
import { captureClientInfo, sessionFileName } from '../../src/capture/events.js'
import { eventUuidFromParts } from '../../src/capture/event-uuid.js'
import {
  acquireFileLease,
  cursorRoot,
  emptyCursor,
  loadCursor,
  READER_LOCK_STALE_MS,
  saveCursor,
  type TranscriptCursor,
  withReaderLock,
} from '../../src/capture/transcript-cursor.js'

const PERMISSION_BITS = constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO
const SESSION = '00000000-0000-4000-8000-000000009000'

let home: string
let root: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'engram-cursor-'))
  root = cursorRoot({ HOME: home })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
})

/** The session's request directory: one complete file per request a waiting reader left. */
function againDir(): string {
  return join(root, `${SESSION}.again`)
}

function againRequests(): string[] {
  return existsSync(againDir()) ? readdirSync(againDir()).filter((n) => !n.startsWith('.')) : []
}

// Only the renewal interval and the clock are faked: lock files are real, so
// their I/O completes on real time and `until` polls it with a real setTimeout.
function fakeRenewalClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition not met')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('cursor files', () => {
  it('lives under the env HOME', () => {
    expect(root).toBe(join(home, '.engram', 'cursors'))
  })

  it('round-trips through an owner-only file written by rename', async () => {
    const cursor: TranscriptCursor = {
      ...emptyCursor('/tmp/session.jsonl'),
      offset: 120,
      line: 3,
      last_uuid: '00000000-0000-4000-8000-000000000003',
      last_line_start: 80,
      open_turn_emitted: ['00000000-0000-4000-8000-000000000004'],
      plan_dirs: ['Active/tst-plan'],
      pending_calls: [
        { id: 'toolu_ask', name: 'AskUserQuestion', questions: [{ question: 'Go?', header: '', options: [], multiSelect: false }] },
        { id: 'toolu_commit', name: 'Bash', ref_kinds: ['commit'] },
      ],
    }
    await saveCursor(root, SESSION, cursor)
    expect(await loadCursor(root, SESSION)).toEqual(cursor)
    expect(statSync(root).mode & PERMISSION_BITS).toBe(PRIVATE_DIR_MODE)
    expect(statSync(join(root, `${SESSION}.json`)).mode & PERMISSION_BITS).toBe(PRIVATE_FILE_MODE)
    expect(readdirSync(root)).toEqual([`${SESSION}.json`])
  })

  it('loads no cursor when the file is missing or does not hold one', async () => {
    expect(await loadCursor(root, SESSION)).toBeNull()
    await saveCursor(root, SESSION, emptyCursor('/tmp/session.jsonl'))
    writeFileSync(join(root, `${SESSION}.json`), '{"v":1,"offset":"twelve"}')
    expect(await loadCursor(root, SESSION)).toBeNull()
    writeFileSync(join(root, `${SESSION}.json`), '{"v":1')
    expect(await loadCursor(root, SESSION)).toBeNull()
    const { pending_calls: _none, ...withoutCalls } = emptyCursor('/tmp/session.jsonl')
    writeFileSync(join(root, `${SESSION}.json`), JSON.stringify(withoutCalls))
    expect(await loadCursor(root, SESSION)).toEqual(emptyCursor('/tmp/session.jsonl'))
    const saved = { ...emptyCursor('/tmp/session.jsonl'), pending_calls: [{ id: 'toolu_x' }] }
    writeFileSync(join(root, `${SESSION}.json`), JSON.stringify(saved))
    expect(await loadCursor(root, SESSION)).toBeNull()
  })

  it('names a session file so it never starts with a dot', () => {
    expect(sessionFileName('.hidden')).toBe('%2Ehidden')
    expect(sessionFileName('a/b c')).toBe('a%2Fb%20c')
    expect(sessionFileName(SESSION)).toBe(SESSION)
    expect(() => sessionFileName('')).toThrow()
  })
})

describe('withReaderLock', () => {
  it('a reader that gives up leaves .again, and the holder reads once more', async () => {
    const gate = deferred()
    let reads = 0
    const holder = withReaderLock(root, SESSION, async () => {
      reads += 1
      if (reads === 1) await gate.promise
      return reads
    })
    await new Promise((r) => setTimeout(r, 20))
    let ranSecond = false
    const second = await withReaderLock(
      root,
      SESSION,
      async () => {
        ranSecond = true
      },
      { waitMs: 50 },
    )
    expect(second).toBeUndefined()
    expect(ranSecond).toBe(false)
    expect(againRequests()).toHaveLength(1)

    gate.resolve()
    expect(await holder).toBe(2)
    expect(reads).toBe(2)
    expect(againRequests()).toEqual([])
    expect(existsSync(join(root, `${SESSION}.lock`))).toBe(false)
  })

  it('carries the strongest waiting request through .again: a close beats a read', async () => {
    const gate = deferred()
    const requests: boolean[] = []
    const holder = withReaderLock(root, SESSION, async (_lease, read) => {
      requests.push(read.forceClose)
      if (requests.length === 1) await gate.promise
    })
    await new Promise((r) => setTimeout(r, 20))
    const never = async () => {
      throw new Error('a reader that gave up must not read')
    }
    expect(await withReaderLock(root, SESSION, never, { waitMs: 30, forceClose: true })).toBeUndefined()
    expect(await withReaderLock(root, SESSION, never, { waitMs: 30 })).toBeUndefined()
    // Each waiter publishes its own request; none appends to another's.
    expect(againRequests()).toHaveLength(2)

    gate.resolve()
    await holder
    expect(requests).toEqual([false, true])
    expect(againRequests()).toEqual([])
  })

  it('applies a close request a waiter left after the last holder finished to the next first read', async () => {
    mkdirSync(againDir(), { recursive: true })
    writeFileSync(join(againDir(), 'leftover'), 'close\n')
    const requests: boolean[] = []
    await withReaderLock(root, SESSION, async (_lease, read) => {
      requests.push(read.forceClose)
    })
    expect(requests).toEqual([true])
  })

  it('takes only whole requests: one still being written under its temp name is left alone', async () => {
    mkdirSync(againDir(), { recursive: true })
    const partial = join(againDir(), '.4242-0a1b2c3d.4242.5e6f7a8b.tmp')
    writeFileSync(partial, 'clo')
    const requests: boolean[] = []
    await withReaderLock(root, SESSION, async (_lease, read) => {
      requests.push(read.forceClose)
    })
    expect(requests).toEqual([false])
    expect(readFileSync(partial, 'utf8')).toBe('clo')
  })

  it('keeps the lock through a read longer than its stale age; a second reader touches .again and returns', async () => {
    fakeRenewalClock()
    const lock = join(root, `${SESSION}.lock`)
    const gate = deferred()
    let reads = 0
    const holder = withReaderLock(root, SESSION, async () => {
      reads += 1
      if (reads === 1) await gate.promise
      return reads
    })
    // The read starts once the lease, and so its renewal timer, exists.
    await until(() => reads === 1)

    const step = READER_LOCK_STALE_MS / 3
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(step)
      await until(() => statSync(lock).mtimeMs >= Date.now() - 1)
    }
    let ranSecond = false
    const second = await withReaderLock(
      root,
      SESSION,
      async () => {
        ranSecond = true
      },
      { waitMs: 0 },
    )

    expect(second).toBeUndefined()
    expect(ranSecond).toBe(false)
    expect(againRequests()).toHaveLength(1)
    gate.resolve()
    expect(await holder).toBe(2)
    expect(existsSync(lock)).toBe(false)
  })

  it('reads no more for .again once its lease is lost', async () => {
    const lock = join(root, `${SESSION}.lock`)
    let reads = 0
    const result = await withReaderLock(root, SESSION, async (lease) => {
      reads += 1
      writeFileSync(lock, 'another-holder\n')
      mkdirSync(againDir(), { recursive: true })
      writeFileSync(join(againDir(), 'waiting'), 'read\n')
      expect(await lease.renew()).toBe(false)
      return reads
    })

    expect(result).toBe(1)
    expect(reads).toBe(1)
    expect(againRequests()).toEqual(['waiting'])
    expect(readFileSync(lock, 'utf8')).toBe('another-holder\n')
  })

  it('takes over a lock left by a holder that died', async () => {
    mkdirSync(root, { recursive: true })
    const lock = join(root, `${SESSION}.lock`)
    writeFileSync(lock, 'gone\n')
    const old = (Date.now() - 2 * 60_000) / 1000
    utimesSync(lock, old, old)
    expect(await withReaderLock(root, SESSION, async () => 'read', { waitMs: 0 })).toBe('read')
    expect(existsSync(lock)).toBe(false)
  })

  it('waits for a fresh lock and gives up without running', async () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, `${SESSION}.lock`), 'held\n')
    expect(await withReaderLock(root, SESSION, async () => 'read', { waitMs: 30 })).toBeUndefined()
  })
})

describe('acquireFileLease', () => {
  it('renews the lock every third of its stale age while held, and release removes it', async () => {
    fakeRenewalClock()
    mkdirSync(root, { recursive: true })
    const path = join(root, 'held.lock')
    const lease = await acquireFileLease(path, { staleMs: 3_000, waitMs: 0 })
    expect(lease).toBeDefined()
    const start = Date.now()

    for (let step = 1; step <= 4; step++) {
      await vi.advanceTimersByTimeAsync(1_000)
      await until(() => statSync(path).mtimeMs >= start + step * 1_000 - 1)
    }

    expect(lease!.lost).toBe(false)
    expect(await acquireFileLease(path, { staleMs: 3_000, waitMs: 0 })).toBeUndefined()
    await lease!.release()
    expect(existsSync(path)).toBe(false)
  })

  it('tells its holder once a renewal finds the lock taken over, and leaves the new holder alone', async () => {
    fakeRenewalClock()
    mkdirSync(root, { recursive: true })
    const path = join(root, 'held.lock')
    const lease = await acquireFileLease(path, { staleMs: 3_000, waitMs: 0 })
    writeFileSync(path, 'another-holder\n')

    await vi.advanceTimersByTimeAsync(1_000)
    await until(() => lease!.lost)

    expect(await lease!.renew()).toBe(false)
    await lease!.release()
    expect(readFileSync(path, 'utf8')).toBe('another-holder\n')
  })
})

describe('eventUuidFromParts', () => {
  it('is stable, separates its parts and is a version-8 uuid', () => {
    const id = eventUuidFromParts('session', 'commit', 'abc1234')
    expect(eventUuidFromParts('session', 'commit', 'abc1234')).toBe(id)
    expect(eventUuidFromParts('sessionc', 'ommit', 'abc1234')).not.toBe(id)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(id[14]).toBe('8')
    // RFC 9562 variant: the two top bits of byte 8 are 10.
    expect(parseInt(id[19], 16) >> 2).toBe(2)
  })
})

describe('captureClientInfo', () => {
  it('names this client and carries the package version', () => {
    const info = captureClientInfo()
    expect(info.name).toBe('engram-capture')
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
