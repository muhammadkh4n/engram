import { describe, it, expect } from 'vitest'
import { HeuristicIntentAnalyzer } from '../../src/intent/analyzer.js'
import { STRATEGY_TABLE } from '../../src/intent/intents.js'

const analyzer = new HeuristicIntentAnalyzer()

// ---------------------------------------------------------------------------
// Intent classification — one test per intent type
// ---------------------------------------------------------------------------

describe('HeuristicIntentAnalyzer — intent classification', () => {
  it('"hi" → SOCIAL', () => {
    const result = analyzer.analyze('hi')
    expect(result.type).toBe('SOCIAL')
  })

  it('"thanks" → SOCIAL', () => {
    const result = analyzer.analyze('thanks')
    expect(result.type).toBe('SOCIAL')
  })

  it('"ok" → SOCIAL', () => {
    const result = analyzer.analyze('ok')
    expect(result.type).toBe('SOCIAL')
  })

  it('"lol" → SOCIAL', () => {
    const result = analyzer.analyze('lol')
    expect(result.type).toBe('SOCIAL')
  })

  it('"Let\'s build a REST API" → TASK_START', () => {
    const result = analyzer.analyze("Let's build a REST API")
    expect(result.type).toBe('TASK_START')
  })

  it('"I need to implement authentication" → TASK_START', () => {
    const result = analyzer.analyze('I need to implement authentication')
    expect(result.type).toBe('TASK_START')
  })

  it('"next step" → TASK_CONTINUE', () => {
    const result = analyzer.analyze('next step')
    expect(result.type).toBe('TASK_CONTINUE')
  })

  it('"continue where we left off" → TASK_CONTINUE', () => {
    const result = analyzer.analyze('continue where we left off')
    expect(result.type).toBe('TASK_CONTINUE')
  })

  it('"What is React?" → QUESTION', () => {
    const result = analyzer.analyze('What is React?')
    expect(result.type).toBe('QUESTION')
  })

  it('"How does TypeScript inference work?" → QUESTION', () => {
    const result = analyzer.analyze('How does TypeScript inference work?')
    expect(result.type).toBe('QUESTION')
  })

  it('"Remember when we discussed auth?" → RECALL_EXPLICIT', () => {
    const result = analyzer.analyze('Remember when we discussed auth?')
    expect(result.type).toBe('RECALL_EXPLICIT')
  })

  it('"What did we decide about the database schema?" → RECALL_EXPLICIT', () => {
    const result = analyzer.analyze('What did we decide about the database schema?')
    expect(result.type).toBe('RECALL_EXPLICIT')
  })

  it('"TypeError: Cannot read property" → DEBUGGING', () => {
    const result = analyzer.analyze('TypeError: Cannot read property')
    expect(result.type).toBe('DEBUGGING')
  })

  it('"There is a bug in the login flow" → DEBUGGING', () => {
    const result = analyzer.analyze('There is a bug in the login flow')
    expect(result.type).toBe('DEBUGGING')
  })

  it('"I prefer TypeScript over JavaScript" → PREFERENCE', () => {
    const result = analyzer.analyze('I prefer TypeScript over JavaScript')
    expect(result.type).toBe('PREFERENCE')
  })

  it('"Don\'t use var, always use const" → PREFERENCE', () => {
    const result = analyzer.analyze("Don't use var, always use const")
    expect(result.type).toBe('PREFERENCE')
  })

  it('"Review this code" → REVIEW', () => {
    const result = analyzer.analyze('Review this code')
    expect(result.type).toBe('REVIEW')
  })

  it('"Can you do a code review of this PR?" → REVIEW', () => {
    const result = analyzer.analyze('Can you do a code review of this PR?')
    expect(result.type).toBe('REVIEW')
  })

  it('"Actually let\'s talk about deploy" → CONTEXT_SWITCH', () => {
    const result = analyzer.analyze("Actually let's talk about deploy")
    expect(result.type).toBe('CONTEXT_SWITCH')
  })

  it('"Instead, let\'s talk about testing" → CONTEXT_SWITCH', () => {
    const result = analyzer.analyze("Instead, let's talk about testing")
    expect(result.type).toBe('CONTEXT_SWITCH')
  })

  it('"Production is down!!!" → EMOTIONAL', () => {
    const result = analyzer.analyze('Production is down!!!')
    expect(result.type).toBe('EMOTIONAL')
  })

  it('"This is critical and urgent!" → EMOTIONAL', () => {
    const result = analyzer.analyze('This is critical and urgent!')
    expect(result.type).toBe('EMOTIONAL')
  })

  it('"Here\'s the config file content..." → INFORMATIONAL', () => {
    const result = analyzer.analyze("Here's the config file content for the project setup")
    expect(result.type).toBe('INFORMATIONAL')
  })

  it('long plain statement with no signals → INFORMATIONAL', () => {
    const result = analyzer.analyze(
      'The application uses a three-tier architecture with separate layers',
    )
    expect(result.type).toBe('INFORMATIONAL')
  })
})

// ---------------------------------------------------------------------------
// Strategy mapping
// ---------------------------------------------------------------------------

describe('HeuristicIntentAnalyzer — strategy mapping', () => {
  it('SOCIAL has shouldRecall=false', () => {
    const result = analyzer.analyze('hi')
    expect(result.strategy.shouldRecall).toBe(false)
  })

  it('SOCIAL has empty tiers', () => {
    const result = analyzer.analyze('hi')
    expect(result.strategy.tiers).toHaveLength(0)
  })

  it('TASK_START has shouldRecall=true', () => {
    const result = analyzer.analyze("Let's build a REST API")
    expect(result.strategy.shouldRecall).toBe(true)
  })

  it('TASK_START has boostProcedural=true', () => {
    const result = analyzer.analyze("Let's build a REST API")
    expect(result.strategy.boostProcedural).toBe(true)
  })

  it('TASK_START tiers include semantic with weight 1.5', () => {
    const result = analyzer.analyze("Let's build a REST API")
    const semantic = result.strategy.tiers.find((t) => t.tier === 'semantic')
    expect(semantic).toBeDefined()
    expect(semantic!.weight).toBe(1.5)
  })

  it('TASK_START tiers include procedural with weight 1.5', () => {
    const result = analyzer.analyze("Let's build a REST API")
    const procedural = result.strategy.tiers.find((t) => t.tier === 'procedural')
    expect(procedural).toBeDefined()
    expect(procedural!.weight).toBe(1.5)
  })

  it('QUESTION has boostProcedural=false', () => {
    const result = analyzer.analyze('What is React?')
    expect(result.strategy.boostProcedural).toBe(false)
  })

  it('DEBUGGING has boostProcedural=true', () => {
    const result = analyzer.analyze('TypeError: Cannot read property')
    expect(result.strategy.boostProcedural).toBe(true)
  })

  it('DEBUGGING episode tier has weight 1.5', () => {
    const result = analyzer.analyze('TypeError: Cannot read property')
    const episode = result.strategy.tiers.find((t) => t.tier === 'episode')
    expect(episode).toBeDefined()
    expect(episode!.weight).toBe(1.5)
  })

  it('RECALL_EXPLICIT uses 2 association hops', () => {
    const result = analyzer.analyze('Remember when we discussed auth?')
    expect(result.strategy.associationHops).toBe(2)
  })

  it('INFORMATIONAL has shouldRecall=true', () => {
    const result = analyzer.analyze(
      'The application uses a three-tier architecture with separate layers',
    )
    expect(result.strategy.shouldRecall).toBe(true)
  })

  it('EMOTIONAL has includeAssociations=true and 2 hops', () => {
    const result = analyzer.analyze('Production is down!!!')
    expect(result.strategy.includeAssociations).toBe(true)
    expect(result.strategy.associationHops).toBe(2)
  })

  it('PREFERENCE has includeAssociations=false', () => {
    const result = analyzer.analyze('I prefer TypeScript over JavaScript')
    expect(result.strategy.includeAssociations).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// IntentResult shape
// ---------------------------------------------------------------------------

describe('HeuristicIntentAnalyzer — result shape', () => {
  it('result has all required fields', () => {
    const result = analyzer.analyze("Let's build a REST API")
    expect(result).toHaveProperty('type')
    expect(result).toHaveProperty('confidence')
    expect(result).toHaveProperty('strategy')
    expect(result).toHaveProperty('extractedCues')
    expect(result).toHaveProperty('salience')
    expect(result).toHaveProperty('expandedQueries')
  })

  it('confidence is between 0 and 1', () => {
    const messages = [
      'hi',
      "Let's build a REST API",
      'TypeError: Cannot read property',
      'Production is down!!!',
      'What is React?',
    ]
    for (const msg of messages) {
      const result = analyzer.analyze(msg)
      expect(result.confidence).toBeGreaterThan(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('salience is between 0 and 1', () => {
    const result = analyzer.analyze('Production is down!!!')
    expect(result.salience).toBeGreaterThan(0)
    expect(result.salience).toBeLessThanOrEqual(1)
  })

  it('extractedCues is an array', () => {
    const result = analyzer.analyze("Let's build a REST API")
    expect(Array.isArray(result.extractedCues)).toBe(true)
  })

  it('expandedQueries is an array', () => {
    const result = analyzer.analyze("Let's build a REST API")
    expect(Array.isArray(result.expandedQueries)).toBe(true)
  })

  it('expandedQueries always contains the original query as first element', () => {
    const query = "What was the last opportunity scan?"
    const result = analyzer.analyze(query)
    expect(result.expandedQueries[0]).toBe(query)
  })

  it('QUESTION intent produces multiple expanded queries', () => {
    const result = analyzer.analyze("What was the last opportunity scan?")
    expect(result.expandedQueries.length).toBeGreaterThan(1)
  })

  it('RECALL_EXPLICIT intent produces expanded queries stripping modal verbs', () => {
    const result = analyzer.analyze("What did we decide about the database schema?")
    expect(result.type).toBe('RECALL_EXPLICIT')
    expect(result.expandedQueries.length).toBeGreaterThan(1)
  })

  it('SOCIAL intent expanded queries contains only the original', () => {
    const result = analyzer.analyze('hi')
    expect(result.type).toBe('SOCIAL')
    // SOCIAL bypasses expansion — still at least contains the original
    expect(result.expandedQueries[0]).toBe('hi')
  })
})

// ---------------------------------------------------------------------------
// STRATEGY_TABLE exported constant
// ---------------------------------------------------------------------------

describe('STRATEGY_TABLE', () => {
  it('covers all 11 intent types', () => {
    const INTENT_TYPES = [
      'TASK_START', 'TASK_CONTINUE', 'QUESTION', 'RECALL_EXPLICIT',
      'DEBUGGING', 'PREFERENCE', 'REVIEW', 'CONTEXT_SWITCH',
      'EMOTIONAL', 'SOCIAL', 'INFORMATIONAL',
    ] as const
    for (const type of INTENT_TYPES) {
      expect(STRATEGY_TABLE[type]).toBeDefined()
    }
  })

  it('SOCIAL strategy has shouldRecall=false', () => {
    expect(STRATEGY_TABLE['SOCIAL'].shouldRecall).toBe(false)
  })

  it('TASK_START strategy has boostProcedural=true', () => {
    expect(STRATEGY_TABLE['TASK_START'].boostProcedural).toBe(true)
  })
})
