/**
 * Isolated from engine.test.ts because it needs a module-level mock of
 * `writeSnapshot` (to get deterministic control over exactly when doWarm()'s
 * final best-effort snapshot write "completes") — mocking that here would
 * break the real snapshot round-trip test in engine.test.ts, which needs the
 * real file I/O to actually happen.
 */
import { describe, it, expect, vi } from 'vitest'
import { RecallEngine } from '../src/engine.js'
import * as snapshotModule from '../src/snapshot.js'
import { FakeStorageAdapter, buildCorpus, cloneRows } from './fake-adapter.js'

// Deferred gate the mocked `writeSnapshot` awaits before resolving, so the
// test controls exactly when the write "completes" instead of racing against
// real filesystem I/O timing (which would make the test flaky).
let releaseWrite: () => void
let writeGate: Promise<void>

vi.mock('../src/snapshot.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/snapshot.js')>()
  return {
    ...actual,
    writeSnapshot: vi.fn(async () => {
      await writeGate
    }),
  }
})

describe("RecallEngine: dispose() racing warm()'s final snapshot write", () => {
  it('does not resurrect state to ready when dispose() lands while the post-fullRebuild snapshot write is still pending', async () => {
    writeGate = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    const writeSnapshotMock = vi.mocked(snapshotModule.writeSnapshot)

    const corpus = buildCorpus(50, 5n)
    const fake = new FakeStorageAdapter(cloneRows(corpus.rows))
    const engine = new RecallEngine(fake, {
      snapshotDir: '/tmp/engram-dispose-race-test',
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const warmPromise = engine.warm()
    // Let doWarm() run fullRebuild to completion and enter the snapshot
    // write, which is now blocked on writeGate — mirrors the real bug
    // scenario, where dispose() can land during that write (or in the
    // microtask gap right after it resolves).
    await vi.waitFor(() => expect(writeSnapshotMock).toHaveBeenCalledTimes(1))
    expect(engine.stats().state).toBe('warming')

    // dispose() races in while the write is still pending. State is still
    // 'warming' (not 'ready'), so dispose()'s own `wasReady` branch is
    // false — it just marks the engine disabled without writing its own
    // snapshot, and resolves near-immediately (no reconcileFlight to await
    // during a full-rebuild warm).
    await engine.dispose()
    expect(engine.stats().state).toBe('disabled')

    // Now let doWarm()'s still-pending write resolve.
    releaseWrite!()
    await warmPromise

    // The fix under test: doWarm() must re-check isDisabled() after the
    // write resolves instead of unconditionally promoting to 'ready' —
    // otherwise this assertion would observe 'ready', resurrecting a
    // disposed engine.
    expect(engine.stats().state).toBe('disabled')
  })
})
