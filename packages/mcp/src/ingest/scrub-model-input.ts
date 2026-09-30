import { scrubSecrets, describeRedactions } from '@engram-mem/core'

/**
 * Redacts credential values from text a CLI is about to send to a model
 * (classifier, summariser) or write to a local log. The redaction count and
 * kinds go to stderr, which the hooks append to the hook log; values never do.
 */
export async function scrubModelInput(
  text: string,
  logPrefix: string,
  write: (line: string) => void = (line) => { process.stderr.write(line) },
): Promise<string> {
  const { text: scrubbed, redactions } = await scrubSecrets(text)
  if (redactions.length > 0) write(`${logPrefix} ${describeRedactions(redactions)}\n`)
  return scrubbed
}
