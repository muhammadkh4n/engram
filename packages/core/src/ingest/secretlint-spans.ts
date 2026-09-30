/**
 * Known credential formats (provider tokens, private keys, connection
 * strings) detected by secretlint's recommend rule set. Each reported range is
 * returned as a span labelled with the rule id; the caller merges these spans
 * with its own rules and does the replacing.
 */

import { lintSource } from '@secretlint/core'
import { rules as recommendRules } from '@secretlint/secretlint-rule-preset-recommend'

export interface DetectedSpan {
  start: number
  end: number
  kind: string
  /** Key name for a keyed value; the placeholder then carries the name. */
  name?: string
  /** Tie-break between equally wide overlapping spans: lower wins. */
  rank: number
}

export const SECRETLINT_RANK = 2

type SecretlintConfig = Parameters<typeof lintSource>[0]['options']['config']
type SecretlintMessage = Awaited<ReturnType<typeof lintSource>>['messages'][number]

const RULE_ID_PREFIX = '@secretlint/secretlint-rule-'
// Registered rule by rule rather than through the preset: core ignores a
// preset child's `disabled` flag, and this rule lets a `secretlint-disable`
// comment inside the scanned text switch detection off for that text.
const FILTER_COMMENTS_RULE_ID = '@secretlint/secretlint-rule-filter-comments'
// Access key IDs name one half of a credential pair and are redacted. The
// account-ID scan that comes with them reports the key name as part of its
// range, and an account ID grants nothing on its own, so it is suppressed.
const AWS_RULE_ID = '@secretlint/secretlint-rule-aws'

const CONFIG: SecretlintConfig = {
  rules: recommendRules
    .filter((rule) => rule.meta.id !== FILTER_COMMENTS_RULE_ID)
    .map((rule) =>
      rule.meta.id === AWS_RULE_ID
        ? { id: rule.meta.id, rule, options: { enableIDScanRule: true }, allowMessageIds: ['AWSAccountID'] }
        : { id: rule.meta.id, rule },
    ),
}

function kindOf(ruleId: string): string {
  return ruleId.startsWith(RULE_ID_PREFIX) ? ruleId.slice(RULE_ID_PREFIX.length) : ruleId
}

function reportedValues(message: SecretlintMessage): string[] {
  const data = (message.data ?? {}) as Record<string, unknown>
  return Object.values(data).filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/**
 * A rule can report the start of its whole match together with the length of
 * the captured value (the AWS secret-access-key rule does), which would cover
 * the key name and leave the value's tail. When the reported text is none of
 * the values the rule reported, the span moves to where that value occurs.
 */
function alignedRange(text: string, message: SecretlintMessage): [number, number] {
  const [start, end] = message.range
  const values = reportedValues(message)
  const reported = text.slice(start, end)
  if (values.length === 0 || values.includes(reported)) return [start, end]
  for (const value of values) {
    const at = text.indexOf(value, start)
    if (at !== -1 && at <= end) return [at, at + value.length]
  }
  return [start, end]
}

export async function secretlintSpans(text: string): Promise<DetectedSpan[]> {
  const result = await lintSource({
    source: { content: text, filePath: '', ext: '.txt', contentType: 'text' },
    options: { config: CONFIG, noPhysicFilePath: true },
  })
  return result.messages.map((message) => {
    const [start, end] = alignedRange(text, message)
    return { start, end, kind: kindOf(message.ruleId), rank: SECRETLINT_RANK }
  })
}
