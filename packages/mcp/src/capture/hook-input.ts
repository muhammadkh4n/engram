/**
 * The hand-off from a capture hook to its worker: the kinds, the two
 * environment names, and the hook input keys passed on. Kept apart from the
 * worker so a hook loads nothing it does not run.
 */

/** The worker kinds a hook can start. */
export type WorkerKind = 'stop' | 'pre-compact' | 'session-end' | 'session-start' | 'drain'

export const HOOK_INPUT_ENV = 'ENGRAM_HOOK_INPUT'
export const HOOK_AT_ENV = 'ENGRAM_HOOK_AT'

/**
 * The hook input keys the worker reads. `prompt` and `last_assistant_message`
 * are never passed on: one environment string is capped at 128 KiB, and the
 * worker reads the turn's text from the transcript anyway.
 */
const FORWARDED_KEYS = ['session_id', 'transcript_path', 'cwd', 'agent_id', 'source', 'trigger', 'reason'] as const

export type ForwardedInput = Partial<Record<(typeof FORWARDED_KEYS)[number], string>>

/** The string-valued keys of the hook input the worker reads; null when stdin is not a JSON object. */
export function forwardedInput(raw: string): { input: ForwardedInput; stopHookActive: boolean } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const input: ForwardedInput = {}
  for (const key of FORWARDED_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) input[key] = value
  }
  return { input, stopHookActive: record.stop_hook_active === true }
}
