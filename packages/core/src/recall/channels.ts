import { ITEM_KINDS } from '../items/types.js'
import type { ItemClass, ItemKind } from '../items/types.js'
import type { RecallRequest } from './types.js'

/**
 * The classes a recall searches when the request names none. `legacy` (rows
 * copied from the old tables, never rewritten) comes only when named, and
 * `session_index` only with history.
 */
export const DEFAULT_RECALL_CLASSES: readonly ItemClass[] = [
  'utterance',
  'mk_statement',
  'observation',
  'artifact',
  'document_section',
]

/**
 * Kinds that record what happened rather than what holds: shown only with
 * `includeHistory`. The candidate statement refuses them otherwise, with the
 * same list.
 */
export const HISTORY_KINDS: readonly ItemKind[] = ['assistant_turn', 'commit', 'pr', 'plan_ledger_log', 'session']
export const HISTORY_CLASSES: readonly ItemClass[] = ['session_index']

/**
 * Whether the `prompt` channel (the briefing injected into every prompt)
 * shows observations, and up to which trust: null shows none, 2 shows the
 * observations whose every evidence pointer was verified (trust 2) and never
 * the unverified ones (trust 3). Every other channel shows observations of
 * any trust. Set to 2 by the owner's decision that verified observations may
 * enter the briefing.
 */
export const PROMPT_OBSERVATION_MAX_TRUST: 2 | null = 2

export interface EffectiveFilters {
  classes: ItemClass[]
  kinds: ItemKind[]
  /** Unset: observations of any trust. */
  maxObservationTrust?: number
}

export type EffectiveFiltersResult = EffectiveFilters | { error: string }

const HISTORY_KIND_SET: ReadonlySet<string> = new Set(HISTORY_KINDS)
const HISTORY_CLASS_SET: ReadonlySet<string> = new Set(HISTORY_CLASSES)

function kindsOf(cls: ItemClass): readonly ItemKind[] {
  return ITEM_KINDS[cls]
}

/**
 * The classes, kinds and observation trust cap a request searches, or why it
 * cannot be answered. The candidate statement always gets explicit classes
 * and kinds, so its own defaults never decide what a recall returns. A kind
 * filter is one flat list: an effective class with none of the named kinds
 * returns nothing, and a named kind that no effective class has is an error.
 * `promptObservationMaxTrust` exists for tests; callers keep the default.
 */
export function effectiveFilters(
  request: Pick<RecallRequest, 'channel' | 'classes' | 'kinds' | 'includeHistory'>,
  promptObservationMaxTrust: number | null = PROMPT_OBSERVATION_MAX_TRUST,
): EffectiveFiltersResult {
  const history = request.includeHistory === true
  const named = request.classes
  if (named !== undefined) {
    if (named.length === 0) return { error: 'classes must name at least one class' }
    if (new Set(named).size !== named.length) return { error: 'classes names a class twice' }
    for (const cls of named) {
      if (!(cls in ITEM_KINDS)) return { error: `classes holds an unknown class: ${String(cls)}` }
      if (!history && HISTORY_CLASS_SET.has(cls)) return { error: `class ${cls} is history: set include_history` }
    }
  }

  let classes: ItemClass[] = named !== undefined ? [...named] : [...DEFAULT_RECALL_CLASSES, ...(history ? HISTORY_CLASSES : [])]
  let maxObservationTrust: number | undefined
  if (request.channel === 'prompt' && classes.includes('observation')) {
    if (promptObservationMaxTrust === null) {
      if (named !== undefined && classes.length === 1) {
        return { error: 'the prompt channel shows no observations' }
      }
      classes = classes.filter((cls) => cls !== 'observation')
    } else {
      maxObservationTrust = promptObservationMaxTrust
    }
  }
  if (classes.length === 0) return { error: 'the request leaves no class to search' }

  const available = new Set<string>(classes.flatMap((cls) => kindsOf(cls)))
  let kinds: ItemKind[]
  if (request.kinds !== undefined) {
    if (request.kinds.length === 0) return { error: 'kinds must name at least one kind' }
    if (new Set(request.kinds).size !== request.kinds.length) return { error: 'kinds names a kind twice' }
    for (const kind of request.kinds) {
      if (!history && HISTORY_KIND_SET.has(kind)) return { error: `kind ${kind} is history: set include_history` }
      if (!available.has(kind)) return { error: `kind ${String(kind)} belongs to none of the classes searched` }
    }
    kinds = [...request.kinds]
  } else {
    kinds = [...available].filter((kind) => history || !HISTORY_KIND_SET.has(kind)) as ItemKind[]
  }
  if (kinds.length === 0) return { error: 'the request leaves no kind to search' }

  return maxObservationTrust === undefined ? { classes, kinds } : { classes, kinds, maxObservationTrust }
}
