import { scrubSecrets } from '../ingest/scrub-secrets.js'

const MAX_REASON_CHARS = 200

/**
 * One-line, credential-free summary of an embedder error, safe to show to the
 * model reading the recall and to write to logs. Provider SDK errors can carry
 * request headers or a stack after the first line, so only the first line is
 * kept; it is scrubbed before it is cut so a cut never leaves a partial
 * secret that no longer matches a detector.
 */
export async function embedFailureReason(err: unknown): Promise<string> {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine === '') return err instanceof Error && err.name !== '' ? err.name : 'embedder error'
  let line: string
  try {
    line = (await scrubSecrets(firstLine)).text
  } catch {
    // An unscrubbed provider message must never reach the reader.
    return err instanceof Error && err.name !== '' ? err.name : 'embedder error'
  }
  return line.length <= MAX_REASON_CHARS ? line : `${line.slice(0, MAX_REASON_CHARS - 1)}…`
}
