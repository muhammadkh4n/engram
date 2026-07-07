/**
 * Majority non-null projectId across a set of source memories.
 *
 * Consolidation derives new memories (digests, semantic, procedural) from
 * existing ones; the derived memory inherits the project of its sources so
 * scoped recall keeps working across consolidation cycles. Untagged sources
 * don't vote — a memory derived only from untagged sources stays null
 * (shared). Ties resolve to the first project encountered, keeping the
 * result deterministic for a given source order.
 */
export function majorityProjectId(
  projectIds: ReadonlyArray<string | null | undefined>
): string | null {
  const counts = new Map<string, number>()
  let best: string | null = null
  let bestCount = 0
  for (const projectId of projectIds) {
    if (!projectId) continue
    const count = (counts.get(projectId) ?? 0) + 1
    counts.set(projectId, count)
    if (count > bestCount) {
      best = projectId
      bestCount = count
    }
  }
  return best
}
