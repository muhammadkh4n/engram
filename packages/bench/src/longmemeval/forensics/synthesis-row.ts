/**
 * Pure row-shaping for the sweep's `--synthesize` output.
 *
 * Split out from recall-sweep.ts because that file runs `main()`
 * unconditionally at module load (no `import.meta.url` entry guard) —
 * importing anything from it in a test would execute the full sweep
 * (env validation, dataset load, live recall calls). This function has
 * no side effects, so its shape can be pinned directly.
 */

export interface SynthesisBlock {
  intent: string
  method: string
  text: string
}

/**
 * Shapes the optional `synthesis` field of a PerQRow.
 * - `synthesize` false: returns `{}` — the row carries no `synthesis` key at all.
 * - `synthesize` true, `synthesisRow` null/undefined (recall produced no block):
 *   returns `{ synthesis: null }` — the key is present with an explicit null,
 *   distinguishing "not requested" from "requested but empty".
 * - `synthesize` true, `synthesisRow` set: returns `{ synthesis: synthesisRow }`.
 */
export function buildSynthesisField(
  synthesize: boolean,
  synthesisRow: SynthesisBlock | null | undefined,
): { synthesis?: SynthesisBlock | null } {
  return synthesize ? { synthesis: synthesisRow ?? null } : {}
}
