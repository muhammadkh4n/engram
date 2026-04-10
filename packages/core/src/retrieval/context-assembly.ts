/**
 * Wave 2: Context Assembly
 *
 * After spreading activation, the result set includes both Memory nodes
 * (the actual recalled content) and context nodes (Person, Topic, Emotion,
 * Session, TimeContext, Intent). This module extracts the context nodes
 * and builds the structured environmental context for the MCP response.
 */

import type { GraphActivatedNode } from '../adapters/graph.js'
import type { RetrievedMemory } from '../types.js'
import type { CompositeMemory } from './spreading-activation.js'

/**
 * Assemble CompositeMemory from activated graph nodes.
 *
 * - `temporalContext` is an array: a recall may span multiple sessions.
 * - `dominantIntent` (not `intent`) avoids collision with RecallResult.intent.
 */
export function assembleContext(
  coreMemories: RetrievedMemory[],
  _associations: RetrievedMemory[],
  faintAssociations: RetrievedMemory[],
  activatedNodes: GraphActivatedNode[],
): CompositeMemory {
  const speakers: Array<{ name: string; role: string }> = []
  const emotionalContext: Array<{ label: string; intensity: number }> = []
  const temporalContext: Array<{ session: string; timeOfDay: string; date: string }> = []
  const relatedTopics: string[] = []
  const intentCounts = new Map<string, number>()

  for (const node of activatedNodes) {
    switch (node.nodeType) {
      case 'Person': {
        const name = node.properties['name'] as string | undefined
        if (name) {
          speakers.push({
            name,
            role: (node.properties['role'] as string | undefined) ?? 'unknown',
          })
        }
        break
      }
      case 'Emotion': {
        const label = node.properties['label'] as string | undefined
        const intensity = node.properties['intensity'] as number | undefined
        if (label) {
          emotionalContext.push({ label, intensity: intensity ?? 0.5 })
        }
        break
      }
      case 'Session': {
        const sessionId = node.properties['sessionId'] as string | undefined
        if (sessionId) {
          temporalContext.push({
            session: sessionId,
            timeOfDay: 'unknown',
            date: 'unknown',
          })
        }
        break
      }
      case 'TimeContext': {
        const dayOfWeek = node.properties['dayOfWeek'] as string | undefined
        const timeOfDay = node.properties['timeOfDay'] as string | undefined
        const timestamp = node.properties['timestamp'] as string | undefined

        if (temporalContext.length > 0 && (timeOfDay || timestamp || dayOfWeek)) {
          // Update the most recent temporalContext entry
          const last = temporalContext[temporalContext.length - 1]
          if (!last) break
          if (timeOfDay) last.timeOfDay = timeOfDay
          if (timestamp) {
            try {
              const d = new Date(timestamp)
              if (!Number.isNaN(d.getTime())) {
                last.date = d.toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric',
                })
              }
            } catch {
              last.date = timestamp.slice(0, 10)
            }
          }
          if (dayOfWeek && last.timeOfDay === 'unknown') {
            last.timeOfDay = dayOfWeek
          }
        } else if (timeOfDay || timestamp) {
          // TimeContext arrived before Session node — create standalone
          temporalContext.push({
            session: 'unknown',
            timeOfDay: timeOfDay ?? 'unknown',
            date: timestamp ? timestamp.slice(0, 10) : 'unknown',
          })
        }
        break
      }
      case 'Topic':
      case 'Entity': {
        const label = (node.properties['label'] ?? node.properties['name']) as
          | string
          | undefined
        if (label && !relatedTopics.includes(label)) {
          relatedTopics.push(label)
        }
        break
      }
      case 'Intent': {
        const intentType = node.properties['intentType'] as string | undefined
        if (intentType) {
          intentCounts.set(intentType, (intentCounts.get(intentType) ?? 0) + 1)
        }
        break
      }
    }
  }

  // Determine dominant intent
  let dominantIntent = 'INFORMATIONAL'
  let maxCount = 0
  for (const [intentType, count] of intentCounts) {
    if (count > maxCount) {
      maxCount = count
      dominantIntent = intentType
    }
  }

  // Deduplicate speakers by name
  const uniqueSpeakers = Array.from(
    new Map(speakers.map((s) => [s.name.toLowerCase(), s])).values(),
  )

  // Cap related topics at 10
  const sortedTopics = relatedTopics.slice(0, 10)

  return {
    coreMemories,
    speakers: uniqueSpeakers,
    emotionalContext,
    dominantIntent,
    temporalContext,
    relatedTopics: sortedTopics,
    faintAssociations,
  }
}
