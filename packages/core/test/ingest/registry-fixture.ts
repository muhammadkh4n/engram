import { vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECRET_SOURCES_ENV, resetDefaultSecretRegistry } from '../../src/ingest/secret-registry.js'

/**
 * Points the process-wide registry at a temp `json-keys` source holding the
 * given name → value pairs (JSON carries any character a value may hold).
 * Returns the cleanup that removes the files and restores the unset registry.
 */
export function useTempRegistry(values: Record<string, string>): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'engram-scrub-registry-'))
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify(values))
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
  vi.stubEnv(SECRET_SOURCES_ENV, join(dir, 'sources.json'))
  resetDefaultSecretRegistry()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return () => {
    warn.mockRestore()
    vi.unstubAllEnvs()
    resetDefaultSecretRegistry()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Keeps the unset-registry notice out of test output. */
export function useNoRegistry(): () => void {
  vi.stubEnv(SECRET_SOURCES_ENV, '')
  resetDefaultSecretRegistry()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return () => {
    warn.mockRestore()
    vi.unstubAllEnvs()
    resetDefaultSecretRegistry()
  }
}
