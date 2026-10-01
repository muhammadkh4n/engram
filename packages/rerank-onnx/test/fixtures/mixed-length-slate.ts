// A deterministic recall slate: one query and 45 synthetic memory documents
// whose lengths run from about 40 to about 2,000 tokens, interleaved so that
// any contiguous batch mixes short and long documents. Every sentence is
// synthetic; nothing here is copied from a real memory store.

export interface SlateDocument {
  id: string
  content: string
}

export const MIXED_LENGTH_QUERY =
  'What connection pool size did we settle on for the recall service, and why?'

const FILLER: readonly string[] = [
  'The session started by rebasing the feature branch onto main and resolving two import conflicts.',
  'Ran the package build and the type check; both finished without errors.',
  'The lint step flagged an unused variable in the ingest module, which was removed.',
  'A user prompt asked to rename the CLI flag so that it matches the configuration key.',
  'The hook wrote a session summary after the tool call returned a large diff.',
  'Reviewed the migration file and confirmed that the column default is applied in a single statement.',
  'The test suite reported one flaky case around timer handling, which was rerun and passed.',
  'Updated the README table so that the environment variables are listed in alphabetical order.',
  'The assistant proposed splitting the formatter into two smaller functions for readability.',
  'A grep across the workspace found three callers of the deprecated helper.',
  'The dashboard query was rewritten to group by day instead of by hour.',
  'Discussed whether the cache key should include the tenant identifier; it should.',
  'The deploy script now prints the commit it ships before it restarts the service.',
  'The embedding job retried twice after a timeout and then completed.',
  'Noted that the staging database holds a bulk load with sparse optional columns.',
  'The pull request description was updated with the measured before and after numbers.',
  'The scheduler moved the nightly consolidation window one hour later.',
  'Checked the journal for warnings after the restart and found none.',
  'A comment in the parser explains why empty lines are preserved.',
  'The benchmark harness now writes one checkpoint row per question.',
  'The tokenizer config was compared against the upstream repository and matched.',
  'Pinned the dependency to an exact version so that builds stay reproducible.',
  'The retry policy uses exponential backoff with jitter capped at thirty seconds.',
  'Session ended with all tasks committed and the working tree clean.',
]

const RELEVANT: readonly string[] = [
  'We settled on a connection pool of twelve for the recall service because the database allows forty connections in total.',
  'The recall service pool size stays at twelve; going higher starved the ingest workers of connections.',
  'Load testing showed recall latency flat between eight and twelve pooled connections, so twelve was chosen for headroom.',
  'The connection pool for recall was briefly raised to twenty, which exhausted the server limit, and was reverted.',
  'Pool sizing note: recall service twelve connections, ingest service six, admin tools two.',
]

const COUNT = 45
const MIN_TOKENS = 40
const MAX_TOKENS = 2000
// English prose tokenizes at roughly 1.3 tokens per word under WordPiece/BPE.
const TOKENS_PER_WORD = 1.3

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

function buildDocument(targetTokens: number, relevant: string | null, rand: () => number): string {
  const targetWords = Math.round(targetTokens / TOKENS_PER_WORD)
  const sentences: string[] = []
  let words = 0
  while (words < targetWords) {
    const sentence = FILLER[Math.floor(rand() * FILLER.length)]!
    sentences.push(sentence)
    words += sentence.split(' ').length
  }
  if (relevant !== null) {
    const at = Math.floor(rand() * Math.min(sentences.length, 4))
    sentences.splice(at, 1, relevant)
  }
  return sentences.join(' ')
}

/** The 45-document slate, identical on every call. */
export function buildMixedLengthSlate(): SlateDocument[] {
  const rand = mulberry32(0x5eed)
  const ratio = MAX_TOKENS / MIN_TOKENS
  const lengths = Array.from({ length: COUNT }, (_, i) =>
    Math.round(MIN_TOKENS * Math.pow(ratio, i / (COUNT - 1))),
  )
  const order = shuffled(lengths, rand)
  return order.map((targetTokens, i) => {
    const relevant = i % 5 === 0 ? RELEVANT[(i / 5) % RELEVANT.length]! : null
    return { id: `doc-${String(i).padStart(2, '0')}`, content: buildDocument(targetTokens, relevant, rand) }
  })
}
