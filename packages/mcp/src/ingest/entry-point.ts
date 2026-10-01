import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * True when the module at `moduleUrl` is the script node was started with
 * (bin symlinks resolved), so importing it from a test never runs its CLI.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
