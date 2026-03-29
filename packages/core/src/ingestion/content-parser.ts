/**
 * Content parser — the architectural separation between searchable text and
 * structured parts.
 *
 * At ingest time every message goes through here:
 *   episodes.content  ← cleanText only  (searchable, embeddable, noise-free)
 *   metadata.parts    ← all ParsedPart[] (full fidelity: tool calls, reasoning, etc.)
 *
 * This replaces the content-cleaner.ts hack (extractSearchableContent stored in
 * metadata while the raw noisy string lived in episodes.content). Now
 * episodes.content IS the clean text by construction.
 */

export interface ParsedContent {
  /** Clean human-readable text for episodes.content and embedding. */
  cleanText: string
  /** Structured parts for full-fidelity storage (episode_parts table or metadata.parts). */
  parts: ParsedPart[]
}

export interface ParsedPart {
  ordinal: number
  partType: 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'image' | 'other'
  textContent: string | null
  toolName: string | null
  toolInput: unknown | null
  toolOutput: unknown | null
  raw: unknown
}

/**
 * Parse message content into clean searchable text + structured parts.
 *
 * String input → single text part, cleanText is the stripped string.
 * ContentPart[] → text parts join into cleanText, tool/reasoning parts go to
 * parts[] only (not searchable).
 */
export function parseContent(content: string | unknown[]): ParsedContent {
  if (typeof content === 'string') {
    const cleaned = stripMetadataNoise(content)
    return {
      cleanText: cleaned,
      parts: [
        {
          ordinal: 0,
          partType: 'text',
          textContent: content,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          raw: content,
        },
      ],
    }
  }

  if (!Array.isArray(content)) {
    const str = String(content)
    return {
      cleanText: str,
      parts: [
        {
          ordinal: 0,
          partType: 'other',
          textContent: str,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          raw: content,
        },
      ],
    }
  }

  if (content.length === 0) {
    return { cleanText: '', parts: [] }
  }

  const textParts: string[] = []
  const parts: ParsedPart[] = []

  for (let i = 0; i < content.length; i++) {
    const block = content[i] as Record<string, unknown>
    const type = (block?.type as string) ?? 'unknown'

    if (type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
      parts.push({
        ordinal: i,
        partType: 'text',
        textContent: block.text,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        raw: block,
      })
    } else if (
      type === 'tool_use' ||
      type === 'toolCall' ||
      type === 'function_call'
    ) {
      const name = ((block.name ?? block.toolName ?? 'unknown') as string)
      parts.push({
        ordinal: i,
        partType: 'tool_call',
        textContent: null,
        toolName: name,
        toolInput: (block.input ?? block.arguments ?? null),
        toolOutput: null,
        raw: block,
      })
      // Tool calls are NOT added to textParts — they are not searchable.
    } else if (type === 'tool_result' || type === 'toolResult') {
      const resultContent = block.content
      let resultText: string | null = null

      if (typeof resultContent === 'string') {
        resultText = resultContent
      } else if (Array.isArray(resultContent)) {
        const texts = (resultContent as Array<Record<string, unknown>>)
          .filter((rc) => rc?.type === 'text' && typeof rc.text === 'string')
          .map((rc) => rc.text as string)
        resultText = texts.join('\n') || null
      }

      // Add a capped excerpt of tool result text to searchable content so that
      // results like file reads or search outputs can be recalled later.
      if (resultText && resultText.length > 50) {
        textParts.push(resultText.slice(0, 500))
      }

      parts.push({
        ordinal: i,
        partType: 'tool_result',
        textContent: resultText,
        // Store the tool_use_id / toolCallId as toolName for correlation.
        toolName: ((block.tool_use_id ?? block.toolCallId ?? null) as string | null),
        toolInput: null,
        toolOutput: resultContent,
        raw: block,
      })
    } else if (type === 'thinking' || type === 'reasoning') {
      parts.push({
        ordinal: i,
        partType: 'reasoning',
        textContent: ((block.text ?? block.thinking ?? null) as string | null),
        toolName: null,
        toolInput: null,
        toolOutput: null,
        raw: block,
      })
      // Reasoning/thinking is NOT added to searchable text.
    } else if (type === 'image') {
      parts.push({
        ordinal: i,
        partType: 'image',
        textContent: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        raw: block,
      })
      // Images are not searchable.
    } else {
      parts.push({
        ordinal: i,
        partType: 'other',
        textContent: JSON.stringify(block).slice(0, 200),
        toolName: null,
        toolInput: null,
        toolOutput: null,
        raw: block,
      })
    }
  }

  return {
    cleanText: stripMetadataNoise(textParts.join('\n')),
    parts,
  }
}

/**
 * Strip timestamps and system-injected metadata from a text string.
 * Applied to the assembled cleanText, NOT to individual tool results.
 *
 * Also strips legacy [Tool call: name] markers that were produced by the old
 * extractContent() serialization path in openclaw-plugin.ts. These appear in
 * historical string-form episodes stored before the dual-storage architecture.
 */
function stripMetadataNoise(text: string): string {
  return (
    text
      // Remove timestamps: [Sat 2026-03-28 05:56 GMT+5]
      .replace(
        /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}[^\]]*\]/g,
        '',
      )
      // Remove legacy [Tool call: name] markers (old plugin serialization artifact)
      .replace(/\[Tool call: [^\]]+\]\s*/g, '')
      // Remove "Conversation info (untrusted metadata):" blocks (fenced format)
      .replace(/^Conversation info \(untrusted metadata\):.*?\n```[\s\S]*?\n```\s*/m, '')
      // Remove "Conversation info" plain-text header lines
      .replace(/^Conversation info[^\n]*\n(?:```[\s\S]*?```\s*\n?)?/m, '')
      // Remove "Sender (untrusted metadata):" blocks (fenced format)
      .replace(/^Sender \(untrusted[^)]*\):.*?\n```[\s\S]*?\n```\s*/m, '')
      // Remove "Sender (untrusted) · Name" plain-text header lines
      .replace(/^Sender \(untrusted[^)]*\)[^\n]*\n/gm, '')
      // Remove "Node: Device (IP) · app version · mode remote" header lines
      .replace(/^Node:\s+\S+[^\n]*·\s*mode\s+\w+\s*\n/gm, '')
      // Remove System: [timestamp] lines
      .replace(/^System:\s*\[[^\]]*\]\s*/gm, '')
      // Collapse excess blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
