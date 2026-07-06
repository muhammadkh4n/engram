/**
 * @engram-mem/recall-engine
 *
 * RAM-resident quantized recall engine for Engram — the TurboQuant codec.
 *
 * Recall runs in three tiers:
 *   1. Exhaustive 1-bit familiarity scan over every quantized code in RAM.
 *   2. TurboQuant_prod b=4 unbiased rescore over the tier-1 shortlist.
 *   3. Exact float rescore from the database during hydration, so the
 *      score returned to the caller is always true float cosine.
 *
 * This module is a placeholder — later tasks in this branch fill in the
 * codec, tier orchestration, and public API. It exists now so the package
 * is wired into the workspace (build, typecheck, vitest) ahead of the
 * implementation work.
 */

export {}
