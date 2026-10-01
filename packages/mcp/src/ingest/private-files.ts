/**
 * Owner-only files under ~/.engram, which holds captured conversation text.
 *
 * A mode passed to mkdir or open applies only when the call creates the
 * path, so a directory or file an earlier writer made under the process
 * umask (0755 / 0644) keeps its group and other bits. Every helper here
 * clears them on the existing path as well.
 */

import { appendFileSync, chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, promises as fs, statSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600
const GROUP_OTHER_BITS = 0o077

function tightened(mode: number): number | null {
  const perms = mode & 0o777
  return perms & GROUP_OTHER_BITS ? perms & ~GROUP_OTHER_BITS : null
}

/** Creates `dir` (and missing parents) and leaves `dir` itself owner-only. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  const mode = tightened(statSync(dir).mode)
  if (mode !== null) chmodSync(dir, mode)
}

/** Opens `path` with mode 0600, tightening an existing file; the caller closes the descriptor. */
export function openPrivateFile(path: string, flags: string): number {
  const fd = openSync(path, flags, PRIVATE_FILE_MODE)
  try {
    const mode = tightened(fstatSync(fd).mode)
    if (mode !== null) fchmodSync(fd, mode)
  } catch (err) {
    closeSync(fd)
    throw err
  }
  return fd
}

/** Appends `data` to `path` as an owner-only file. */
export function appendPrivateFile(path: string, data: string): void {
  const fd = openPrivateFile(path, 'a')
  try {
    appendFileSync(fd, data)
  } finally {
    closeSync(fd)
  }
}

/** `openPrivateFile` for the promise API; the caller closes the handle. */
export async function openPrivateHandle(path: string, flags: string): Promise<FileHandle> {
  const handle = await fs.open(path, flags, PRIVATE_FILE_MODE)
  try {
    const mode = tightened((await handle.stat()).mode)
    if (mode !== null) await handle.chmod(mode)
  } catch (err) {
    await handle.close()
    throw err
  }
  return handle
}
