/**
 * The plan folders a session works in: `<bucket>/<slug>` of every
 * `Plans/<bucket>/<slug>` path the session's own tool calls touched, most
 * recent first.
 *
 * Only the assistant's tool_use inputs count, and only the fields that name
 * what a call touched. User text, tool results, injected briefings and text
 * bodies (an edit's new_string, a Write's content, an agent prompt, a heredoc
 * fed to a command) may cite any plan without the session working in it.
 */

export const MAX_PLAN_DIRS = 3

/** The lower-case `plans/` form is a repo-side symlink to a project's Plans folder. */
const REF_RE = /(?:Plans|plans)\/(Active|Delivered|Design Records)\/([a-z0-9][a-z0-9-]*)/g

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'paths'] as const

/**
 * A heredoc opens with `<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD` or
 * `<<-WORD`, and is one only when a later line is exactly WORD (leading tabs
 * dropped for `<<-`): `1 << n` in a script is a shift. `<<<` is a here-string.
 */
const HEREDOC_RE = /(?<!<)<<(-?)[ \t]*(?:\\(?=[A-Za-z_])|(['"]?))([A-Za-z_]\w*)\2(?![\w'"])/g

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The first index in a sorted list greater than i, or i when there is none. */
function firstAfter(sorted: number[] | undefined, i: number): number {
  if (!sorted) return i
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] > i) hi = mid
    else lo = mid + 1
  }
  return lo < sorted.length ? sorted[lo] : i
}

function lineIndex(lines: string[], stripTabs: boolean): Map<string, number[]> {
  const index = new Map<string, number[]>()
  lines.forEach((line, i) => {
    const key = stripTabs ? line.replace(/^\t+/, '') : line
    const at = index.get(key)
    if (at) at.push(i)
    else index.set(key, [i])
  })
  return index
}

/**
 * The command without its heredoc bodies. The opening line stays whole (a
 * redirect target on it is a path). One pass over the lines; each closing
 * line is looked up in an index, so a line full of shift operators stays linear.
 */
export function dropHeredocs(command: string): string {
  const lines = command.split('\n')
  const exact = lineIndex(lines, false)
  const tabbed = command.includes('<<-') ? lineIndex(lines, true) : new Map<string, number[]>()
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i])
    let end = i
    if (lines[i].includes('<<')) {
      for (const m of lines[i].matchAll(HEREDOC_RE)) {
        end = firstAfter((m[1] ? tabbed : exact).get(m[3]), end)
      }
    }
    i = end
  }
  return kept.join('\n')
}

/** Every `<bucket>/<slug>` named in text, in order of first appearance, unique. */
export function planRefs(text: string): string[] {
  return [...new Set([...text.matchAll(REF_RE)].map((m) => `${m[1]}/${m[2]}`))]
}

function pathStrings(block: Json, input: Json): string[] {
  const values: unknown[] = PATH_KEYS.flatMap((key) => {
    const value = input[key]
    return Array.isArray(value) ? value : [value]
  })
  if (block.name === 'Bash' && typeof input.command === 'string') values.push(dropHeredocs(input.command))
  return values.filter((v): v is string => typeof v === 'string')
}

/** One string per tool call of an assistant entry: its path-bearing inputs, joined. */
function toolCallPaths(entry: unknown): string[] {
  if (!isObject(entry) || entry.type !== 'assistant' || !isObject(entry.message)) return []
  const content = entry.message.content
  if (!Array.isArray(content)) return []
  return content
    .filter((b): b is Json => isObject(b) && b.type === 'tool_use' && isObject(b.input))
    .map((b) => pathStrings(b, b.input as Json).join('\n'))
}

/**
 * The session's plan folders after `entry`: each plan a tool call of the
 * entry names moves to the front, later mentions ahead of earlier ones, and
 * the list keeps the MAX_PLAN_DIRS most recent. An entry that names no plan
 * returns the list unchanged.
 */
export function planDirsAfter(entry: unknown, planDirs: readonly string[]): string[] {
  let dirs = [...planDirs]
  for (const paths of toolCallPaths(entry)) {
    for (const ref of planRefs(paths)) {
      dirs = [ref, ...dirs.filter((d) => d !== ref)]
    }
  }
  return dirs.slice(0, MAX_PLAN_DIRS)
}
