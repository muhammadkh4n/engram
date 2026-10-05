/**
 * An embedding request refused because of the input itself (the provider
 * answered HTTP 400 or 422, or the text was blank). Sending the same text
 * again fails the same way, so a caller counts it against that input instead
 * of backing off or retrying; every other embedding failure (network,
 * timeout, 408, 409, 429, 5xx) says nothing about the input.
 *
 * Recognised by a property rather than `instanceof`, so an error thrown by a
 * second copy of this package in one process still reads as input-specific.
 */
export class EmbeddingInputError extends Error {
  readonly inputSpecific = true as const

  /** The provider's HTTP status, or null when the input was refused locally. */
  readonly status: number | null

  constructor(status: number | null, message: string) {
    super(message)
    this.name = 'EmbeddingInputError'
    this.status = status
  }
}

export function isEmbeddingInputError(err: unknown): err is EmbeddingInputError {
  return err instanceof Error && (err as { inputSpecific?: unknown }).inputSpecific === true
}
