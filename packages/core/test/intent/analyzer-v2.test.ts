import { describe, it, expect } from 'vitest'
import { classifyMode, RECALL_STRATEGIES } from '../../src/intent/intents.js'
import type { RecallMode, RecallStrategy } from '../../src/types.js'

describe('classifyMode — 3-mode intent classification', () => {
  it('skip: greetings', () => {
    expect(classifyMode('hi')).toBe('skip')
    expect(classifyMode('thanks')).toBe('skip')
    expect(classifyMode('ok')).toBe('skip')
  })

  it('skip: short acks under 10 chars', () => {
    expect(classifyMode('yes')).toBe('skip')
    expect(classifyMode('nope')).toBe('skip')
    expect(classifyMode('lol')).toBe('skip')
  })

  it('deep: contains question mark', () => {
    expect(classifyMode('What is TypeScript strict mode?')).toBe('deep')
    expect(classifyMode('How does the memory engine work?')).toBe('deep')
  })

  it('deep: recall keywords', () => {
    expect(classifyMode('remember when we discussed TypeScript')).toBe('deep')
    expect(classifyMode('recall the project plan from last time')).toBe('deep')
    expect(classifyMode('what did we decide about the API')).toBe('deep')
    expect(classifyMode('did we ever talk about GraphQL')).toBe('deep')
    expect(classifyMode('previously we agreed on REST')).toBe('deep')
    expect(classifyMode('last time you mentioned webhooks')).toBe('deep')
  })

  it('light: everything else', () => {
    expect(classifyMode('I want to build a webhook server on the VPS')).toBe('light')
    expect(classifyMode('Let us implement the scraper shield using Cloudflare Workers')).toBe('light')
    expect(classifyMode('TypeScript strict mode enables noImplicitAny')).toBe('light')
  })

  it('skip: emoji-only messages', () => {
    expect(classifyMode('👍')).toBe('skip')
    expect(classifyMode('🎉🎉')).toBe('skip')
  })
})

describe('RECALL_STRATEGIES — strategy table', () => {
  it('skip strategy: maxResults=0, no expansion, no associations', () => {
    const s = RECALL_STRATEGIES.skip
    expect(s.mode).toBe('skip')
    expect(s.maxResults).toBe(0)
    expect(s.expand).toBe(false)
    expect(s.associations).toBe(false)
  })

  it('light strategy: maxResults=8, no expansion, no associations', () => {
    const s = RECALL_STRATEGIES.light
    expect(s.mode).toBe('light')
    expect(s.maxResults).toBe(8)
    expect(s.expand).toBe(false)
    expect(s.associations).toBe(false)
    expect(s.recencyBias).toBe(0.4)
  })

  it('deep strategy: maxResults=15, expansion=true, associations=true with 2 hops', () => {
    const s = RECALL_STRATEGIES.deep
    expect(s.mode).toBe('deep')
    expect(s.maxResults).toBe(15)
    expect(s.expand).toBe(true)
    expect(s.associations).toBe(true)
    expect(s.associationHops).toBe(2)
    expect(s.recencyBias).toBe(0.2)
  })
})
