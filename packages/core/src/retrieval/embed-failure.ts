import { scrubSecrets } from '../ingest/scrub-secrets.js'

const MAX_REASON_CHARS = 200

/**
 * One-line, credential-free summary of a failed retrieval call, safe to show
 * to the model reading the recall and to write to logs. Provider SDK and
 * database driver errors can carry request headers, connection strings or a
 * stack after the first line, so only the first line is kept; it is scrubbed
 * before it is cut so a cut never leaves a partial secret that no longer
 * matches a detector. `fallback` names the failure when the error carries no
 * usable message.
 */
export async function failureReason(err: unknown, fallback: string): Promise<string> {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine === '') return err instanceof Error && err.name !== '' ? err.name : fallback
  let line: string
  try {
    line = (await scrubSecrets(firstLine)).text
  } catch {
    // An unscrubbed provider message must never reach the reader.
    return err instanceof Error && err.name !== '' ? err.name : fallback
  }
  return line.length <= MAX_REASON_CHARS ? line : `${line.slice(0, MAX_REASON_CHARS - 1)}…`
}

/** `failureReason` for a query embedding that could not be computed. */
export async function embedFailureReason(err: unknown): Promise<string> {
  return failureReason(err, 'embedder error')
}
