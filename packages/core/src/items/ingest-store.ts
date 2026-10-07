import type { ExtractionCommitResult, ExtractionItem, ExtractionNewSubject } from './capture-store.js'

/**
 * One item written outside extraction: the item in the extraction commit's
 * form, whose `source.type` is `ingest_tool` and which names no run, and the
 * new subjects it names by `subjectKey`.
 */
export interface IngestItemWrite {
  subjects: readonly ExtractionNewSubject[]
  item: ExtractionItem
}

/**
 * Writes one item through the same transaction an extraction commit uses, so
 * identity, restatement, links, entities and the session-index reset follow
 * one set of rules. There is no extraction run: the item's own scope (an
 * mk_statement's utterance, else the item) is the scope a repeat is judged
 * in, and a link the store cannot apply (its target stopped being current
 * after it was validated) refuses the whole write as `ItemConstraintError`
 * instead of being recorded.
 */
export interface ItemIngestStore {
  /**
   * `itemIds` holds one id: the stored item's, the already stored item's when
   * its `source.event_key` was stored (`duplicates` 1), or the restated item's
   * when the same words are current on the subject (`restatements` 1).
   */
  ingestItem(write: IngestItemWrite): Promise<ExtractionCommitResult>
}
