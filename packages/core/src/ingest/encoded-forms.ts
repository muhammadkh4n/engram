/**
 * The spellings a known secret value takes once it is quoted, escaped or
 * encoded somewhere in text. Masking every spelling, not only the raw value,
 * is what keeps a registered secret out of a JSON payload, a shell command, a
 * URL or a base64 blob (the approach of GitHub Actions' log masker).
 */

const CONTROL_ESCAPES: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

function escapeChars(value: string, map: Readonly<Record<string, string>>): string {
  let out = ''
  for (const ch of value) out += map[ch] ?? ch
  return out
}

/** JSON (and YAML / JS double-quoted) string body. */
function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function percentEncoded(value: string): string[] {
  let component: string
  try {
    component = encodeURIComponent(value)
  } catch {
    // A lone surrogate has no UTF-8 encoding, so no URL can carry it.
    return []
  }
  const strict = component.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const form = new URLSearchParams([['', value]]).toString().slice(1)
  return [component, strict, form]
}

/** Every quoting convention a value may be written in, before any outer JSON escaping. */
function quotedForms(value: string): string[] {
  return [
    value,
    jsonEscaped(value),
    // JS / Python single-quoted literal.
    escapeChars(value, { '\\': '\\\\', "'": "\\'", ...CONTROL_ESCAPES }),
    // Shell double quotes.
    escapeChars(value, { '\\': '\\\\', '"': '\\"', $: '\\$', '`': '\\`' }),
    // Shell single quotes, both idioms for an embedded quote.
    value.replaceAll("'", "'\\''"),
    value.replaceAll("'", `'"'"'`),
    // YAML single-quoted and SQL string literals.
    value.replaceAll("'", "''"),
    escapeChars(value, { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }),
    escapeChars(value, { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }),
    // XML text nodes escape only what would start markup.
    escapeChars(value, { '&': '&amp;', '<': '&lt;', '>': '&gt;' }),
    ...percentEncoded(value),
  ]
}

/**
 * Base64 of the value wherever it sits in the encoded input. A 3-byte group
 * boundary can fall at any of the value's first three bytes, depending on
 * what precedes it (`user:` in a Basic credential); for each alignment only
 * the characters that encode the value's bytes alone are kept, so the form
 * matches however the surrounding bytes change the edges.
 */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8')
  const forms = [bytes.toString('base64')]
  for (let skip = 0; skip < 3 && skip < bytes.length; skip++) {
    const aligned = bytes.subarray(skip)
    const exact = Math.floor((aligned.length * 4) / 3)
    forms.push(aligned.toString('base64').slice(0, exact), aligned.toString('base64url').slice(0, exact))
  }
  return forms
}

/**
 * The raw value and its quoted, JSON-escaped (once and nested once more, for
 * JSON carried inside a JSON string), percent-encoded, XML-escaped and base64
 * spellings, deduplicated, longest first.
 */
export function encodedForms(value: string): string[] {
  const quoted = quotedForms(value)
  const forms = new Set([...quoted, ...quoted.map(jsonEscaped), ...base64Forms(value)])
  return [...forms].sort((a, b) => b.length - a.length)
}
