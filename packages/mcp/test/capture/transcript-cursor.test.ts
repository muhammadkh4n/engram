import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { constants, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../src/ingest/private-files.js'
import { captureClientInfo, sessionFileName } from '../../src/capture/events.js'
import { eventUuidFromParts } from '../../src/capture/event-uuid.js'
import {
  cursorRoot,
  emptyCursor,
  loadCursor,
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
  rmSync(home, { recursive: true, force: true })
})

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
    expect(existsSync(join(root, `${SESSION}.again`))).toBe(true)

    gate.resolve()
    expect(await holder).toBe(2)
    expect(reads).toBe(2)
    expect(existsSync(join(root, `${SESSION}.again`))).toBe(false)
    expect(existsSync(join(root, `${SESSION}.lock`))).toBe(false)
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

describe('eventUuidFromParts', () => {
  it('is stable, separates its parts and is a version-8 uuid', () => {
    const id = eventUuidFromParts('session', 'commit', 'abc1234')
    expect(eventUuidFromParts('session', 'commit', 'abc1234')).toBe(id)
    expect(eventUuidFromParts('sessionc', 'ommit', 'abc1234')).not.toBe(id)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id[14]).toBe('8')
  })
})

describe('captureClientInfo', () => {
  it('names this client and carries the package version', () => {
    const info = captureClientInfo()
    expect(info.name).toBe('engram-capture')
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
