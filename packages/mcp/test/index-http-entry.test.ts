/**
 * The server entry runs main() whatever loaded it. A launcher that imports
 * the module (pm2, a wrapper, `node -e "import(...)"`) instead of running it
 * as the script must still start the server or fail loudly, never exit 0
 * with no listener. Runs the built entry, as the service unit does.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index-http.js')

describe('dist/index-http.js', () => {
  it('is built (the entry checks below run the compiled module)', () => {
    expect(existsSync(ENTRY)).toBe(true)
  })

  it('imported from another script with an empty env, exits non-zero naming a missing variable', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(ENTRY).href)})`], {
      env: {},
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/BEARER_TOKEN/)
  })
})
