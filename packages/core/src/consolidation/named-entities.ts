/** An entity a text may name: its graph id and its display name. */
export interface EntityCandidate {
  readonly id: string
  readonly name: string
}

export interface NamedEntitiesResult {
  /** Ids of the candidates the text names, in candidate order, each once. */
  readonly ids: string[]
  /**
   * Candidates never matched because their name normalises to fewer than
   * two characters ("C++" becomes "c"), including names that normalise to
   * nothing. Such names occur inside unrelated words and tokens far too
   * often to be evidence that a text is about them.
   */
  readonly skipped: number
}

const MIN_NAME_LENGTH = 2
const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu

/**
 * NFKC, lowercase, every run of non-letter non-digit characters becomes one
 * space, trimmed. Applied identically to text and names, so "ACA-2613",
 * "aca 2613" and "ACA_2613" all compare equal.
 */
function normalise(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(NON_WORD_RUN, ' ').trim()
}

/**
 * The candidates a text names by its own words.
 *
 * A name matches when its normalised form occurs in the normalised text as
 * a whole-token sequence: both sides are padded with a space, so "Kam's"
 * names "Kam" while "PRs" does not name "PR" and "node-stressful" does not
 * name "node-stress".
 */
export function namedEntities(
  text: string,
  candidates: ReadonlyArray<EntityCandidate>,
): NamedEntitiesResult {
  const paddedText = ` ${normalise(text)} `
  const ids: string[] = []
  const seen = new Set<string>()
  let skipped = 0

  for (const { id, name } of candidates) {
    const normalisedName = normalise(name)
    if ([...normalisedName].length < MIN_NAME_LENGTH) {
      skipped += 1
      continue
    }
    if (seen.has(id)) continue
    if (paddedText.includes(` ${normalisedName} `)) {
      seen.add(id)
      ids.push(id)
    }
  }

  return { ids, skipped }
}
