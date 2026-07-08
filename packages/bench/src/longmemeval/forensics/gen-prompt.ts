/**
 * The gen user-prompt template, extracted verbatim from judge.ts so the
 * byte-identity regression test can pin it. `synthesisText` is the ONE
 * optional content slot of the measurement instrument (design-verdict.md):
 * when absent the rendered prompt is byte-identical to the historical
 * template; when present, exactly one delimited section is inserted between
 * the sessions and the question. The section header travels WITH the
 * treatment — the baseline cell never sees an empty header.
 */
export function buildGenUserPrompt(
  questionDate: string,
  sessionContext: string,
  question: string,
  synthesisText?: string,
): string {
  return (
    `Today's date is ${questionDate}.\n\n` +
    `## Relevant past sessions\n${sessionContext}\n\n` +
    (synthesisText
      ? `## Derived notes from memory\n(computed deterministically from the sessions above — verify against them)\n${synthesisText}\n\n`
      : '') +
    `## Question\n${question}\n\n## Answer`
  )
}
