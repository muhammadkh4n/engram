const POSITIVE_KEYWORDS = [
  'happy', 'excited', 'great', 'excellent', 'good', 'success', 'worked', 'solved',
  'fixed', 'done', 'finished', 'completed', 'deployed', 'shipped',
]

const NEGATIVE_KEYWORDS = [
  'frustrated', 'angry', 'broken', 'failed', 'error', 'crash',
  'stuck', 'blocked', 'wrong', 'bad', 'terrible', 'awful', 'annoyed', 'confused',
]

const URGENT_KEYWORDS = [
  'urgent', 'critical', 'asap', 'immediately', 'production', 'down', 'outage',
  'emergency', 'priority',
]

/**
 * Extract emotion keywords from text for use as pattern completion attributes.
 * Returns canonical emotion labels: 'positive', 'negative', 'neutral', 'urgent'
 */
export function extractEmotionKeywords(text: string): string[] {
  const lower = text.toLowerCase()
  const emotions = new Set<string>()

  if (URGENT_KEYWORDS.some(k => lower.includes(k))) emotions.add('urgent')
  if (NEGATIVE_KEYWORDS.some(k => lower.includes(k))) emotions.add('negative')
  if (POSITIVE_KEYWORDS.some(k => lower.includes(k))) emotions.add('positive')

  return [...emotions]
}
