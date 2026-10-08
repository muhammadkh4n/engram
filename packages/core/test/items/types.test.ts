import { describe, it, expect, expectTypeOf } from 'vitest'
import * as core from '../../src/index.js'
import {
  ITEM_CLASSES,
  ITEM_KINDS,
  SPEAKERS,
  SOURCE_TYPES,
  REGISTER_STATUSES,
  ENTITY_TYPES,
  CAPTURE_EVENT_TYPES,
  ITEM_INVARIANTS,
  type InvariantCounts,
  type ItemKindOf,
  type NewItem,
} from '../../src/items/types.js'
import { ItemConstraintError, isItemConstraintError, type ItemStore } from '../../src/items/item-store.js'

describe('item vocabularies', () => {
  it('lists the seven classes', () => {
    expect(ITEM_CLASSES).toEqual([
      'utterance',
      'mk_statement',
      'observation',
      'artifact',
      'document_section',
      'session_index',
      'legacy',
    ])
  })

  it('gives each class its kinds in the class-rules order', () => {
    expect(ITEM_KINDS).toEqual({
      utterance: ['user_prompt', 'user_answer', 'assistant_turn'],
      mk_statement: ['ruling', 'fact', 'correction'],
      observation: ['fact', 'procedure', 'finding'],
      artifact: ['commit', 'pr', 'ledger_decision', 'ledger_ruling', 'ruling_entry'],
      document_section: [
        'note',
        'plan_readme',
        'plan_phase',
        'plan_ledger',
        'plan_ledger_log',
        'finding',
        'audit',
        'research',
      ],
      session_index: ['session'],
      legacy: ['legacy_episode', 'legacy_digest', 'legacy_fact'],
    })
    expect(Object.keys(ITEM_KINDS)).toEqual([...ITEM_CLASSES])
  })

  it('lists speakers, source types, register statuses and entity types', () => {
    expect(SPEAKERS).toEqual(['mk', 'assistant', 'system', 'artifact'])
    expect(SOURCE_TYPES).toEqual([
      'transcript',
      'history',
      'git',
      'ledger',
      'register',
      'vault',
      'legacy',
      'ingest_tool',
      'extraction',
    ])
    expect(REGISTER_STATUSES).toEqual(['candidate', 'recorded', 'dismissed'])
    expect(ENTITY_TYPES).toEqual(['ticket', 'repo', 'path', 'sha', 'url', 'package'])
  })

  it('lists the twelve capture event types without duplicates', () => {
    expect(CAPTURE_EVENT_TYPES).toHaveLength(12)
    expect(new Set(CAPTURE_EVENT_TYPES).size).toBe(12)
  })

  it('lists the six invariant counts in the order the database returns them', () => {
    expect(ITEM_INVARIANTS).toEqual([
      'assistant_authored_mk_claims',
      'quote_not_in_lineage',
      'lineage_to_forgotten',
      'utterance_time_mismatch',
      'unregistered_project',
      'salvage_quote_not_in_lineage',
    ])
  })

  it('derives kind and count types from the arrays', () => {
    expectTypeOf<ItemKindOf<'mk_statement'>>().toEqualTypeOf<'ruling' | 'fact' | 'correction'>()
    expectTypeOf<keyof InvariantCounts>().toEqualTypeOf<(typeof ITEM_INVARIANTS)[number]>()
    expectTypeOf<NewItem>().not.toHaveProperty('forgottenAt')
    expectTypeOf<NewItem>().not.toHaveProperty('contentHash')
  })
})

describe('ItemConstraintError', () => {
  it('carries the refusing constraint', () => {
    const err = new ItemConstraintError('memory_items_trust_check', 'trust does not match the class')
    expect(err.constraint).toBe('memory_items_trust_check')
    expect(err.message).toBe('trust does not match the class')
    expect(err.name).toBe('ItemConstraintError')
    expect(isItemConstraintError(err)).toBe(true)
  })

  it('matches a copy loaded from another package instance by name', () => {
    class ItemConstraintErrorCopy extends Error {
      readonly constraint = 'memory_items_kind_check'
      constructor() {
        super('refused')
        this.name = 'ItemConstraintError'
      }
    }
    const copy = new ItemConstraintErrorCopy()
    expect(copy instanceof ItemConstraintError).toBe(false)
    expect(isItemConstraintError(copy)).toBe(true)
  })

  it('does not match other errors or non-errors', () => {
    expect(isItemConstraintError(new Error('memory_items_trust_check'))).toBe(false)
    expect(isItemConstraintError({ name: 'ItemConstraintError' })).toBe(false)
    expect(isItemConstraintError(null)).toBe(false)
  })
})

describe('package exports', () => {
  it('exports the item vocabularies, the error and the quote rule', () => {
    expect(core.ITEM_CLASSES).toBe(ITEM_CLASSES)
    expect(core.ITEM_KINDS).toBe(ITEM_KINDS)
    expect(core.SPEAKERS).toBe(SPEAKERS)
    expect(core.SOURCE_TYPES).toBe(SOURCE_TYPES)
    expect(core.REGISTER_STATUSES).toBe(REGISTER_STATUSES)
    expect(core.ENTITY_TYPES).toBe(ENTITY_TYPES)
    expect(core.CAPTURE_EVENT_TYPES).toBe(CAPTURE_EVENT_TYPES)
    expect(core.ITEM_INVARIANTS).toBe(ITEM_INVARIANTS)
    expect(core.ItemConstraintError).toBe(ItemConstraintError)
    expect(core.isItemConstraintError).toBe(isItemConstraintError)
    expect(typeof core.normalizeQuote).toBe('function')
    expect(typeof core.quoteOccursIn).toBe('function')
    expectTypeOf<core.ItemStore>().toEqualTypeOf<ItemStore>()
  })
})
