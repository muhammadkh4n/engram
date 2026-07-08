/**
 * Deterministic aggregation over LLM-labeled evidence. Division of labor
 * (binding): the LLM labels which lines describe the same real-world
 * instance (semantic coreference — what regex cannot do); THIS code counts
 * distinct labels and merges the enumeration (what the anatomy says the
 * consumer fails at: 18 aggregation-miscounts, 12 partial-enumerations).
 */

export interface LabeledEvidence {
  memoryId: string
  sessionId: string | null
  date: Date | null
  snippet: string
  instance: string
}

export interface InstanceGroup {
  label: string
  members: LabeledEvidence[]
  earliest: Date | null
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function groupInstances(items: readonly LabeledEvidence[]): InstanceGroup[] {
  const byLabel = new Map<string, LabeledEvidence[]>()
  for (const item of items) {
    const key = normalizeLabel(item.instance)
    const list = byLabel.get(key) ?? []
    list.push(item)
    byLabel.set(key, list)
  }
  return [...byLabel.entries()]
    .map(([label, members]) => {
      const times = members.filter((m) => m.date !== null).map((m) => m.date!.getTime())
      return {
        label,
        members: [...members],
        earliest: times.length > 0 ? new Date(Math.min(...times)) : null,
      }
    })
    .sort((a, b) => {
      if (a.earliest === null && b.earliest === null) return 0
      if (a.earliest === null) return 1
      if (b.earliest === null) return -1
      return a.earliest.getTime() - b.earliest.getTime()
    })
}
