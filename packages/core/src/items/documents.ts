import type { CaptureSecretHit } from './capture-store.js'
import { ITEM_KINDS, type ItemKindOf } from './types.js'

/** The kinds a vault section is stored under, from the note's kind hint. */
export const DOCUMENT_SECTION_KINDS = ITEM_KINDS.document_section
export type DocumentSectionKind = ItemKindOf<'document_section'>

/** Sections one note may carry; the database refuses more. */
export const DOCUMENT_SECTIONS_MAX = 2000

/** The retire reason of a section that left its note; the same text back unretires it. */
export const DOCUMENT_REMOVED_REASON = 'removed from note'

/**
 * One heading section of a note, already scrubbed. Its key is (note path,
 * `headingPath`, `ordinal`): `ordinal` counts the earlier sections of the
 * note with the same heading path, so a section added above does not change
 * it. A `text` that is blank after trim is skipped and counts as absent.
 */
export interface DocumentSectionWrite {
  /** Headings above the section, outermost first; empty for the text before the first heading. */
  headingPath: readonly string[]
  ordinal: number
  /** Position in the note; sections are applied in this order. */
  index: number
  text: string
  kind: DocumentSectionKind
  searchText: string
  /** One `memory_secret_hits` row each, written only when the section becomes a new item. */
  hits: readonly CaptureSecretHit[]
}

/**
 * One vault note as the documents sync maps it. `seenAt` is the producer's
 * clock when it saw this version and is the only order between a path's
 * versions; `mtime` dates the version and orders nothing. A deleted note has
 * no sections and a null frontmatter.
 */
export interface DocumentNoteWrite {
  path: string
  noteVersion: string
  seenAt: Date
  mtime: Date
  deleted: boolean
  frontmatter: Record<string, unknown> | null
  projectId: string | null
  workspaceId: string | null
  planSlug: string | null
  sections: readonly DocumentSectionWrite[]
}

/** `unchanged` and `stale` wrote nothing. */
export const DOCUMENT_NOTE_STATUSES = ['applied', 'unchanged', 'stale'] as const
export type DocumentNoteStatus = (typeof DOCUMENT_NOTE_STATUSES)[number]

/** What an applied note did to its sections. */
export interface DocumentSectionCounts {
  created: number
  superseded: number
  unchanged: number
  retired: number
  restored: number
  keptForgotten: number
  keptRetired: number
  skippedEmpty: number
}

export interface DocumentNoteSyncResult {
  status: DocumentNoteStatus
  /** Null unless the note was applied. */
  sections: DocumentSectionCounts | null
  /** The items this call created, in section order. */
  itemIds: string[]
}
