import type { IntentType, RetrievalStrategy } from '../types.js'

// ---------------------------------------------------------------------------
// Intent Patterns
// ---------------------------------------------------------------------------

/**
 * Regex patterns used to classify an incoming message into an IntentType.
 * SOCIAL and INFORMATIONAL have special handling in the classification logic;
 * all others are scored by match count.
 */
export const INTENT_PATTERNS: Record<IntentType, RegExp[]> = {
  TASK_START: [
    /\b(let'?s|i need to|i want to|we should|build|create|implement|add|make)\b/i,
    /\b(start|begin|set up|initialize)\b.*\b(project|feature|module|component)\b/i,
  ],
  TASK_CONTINUE: [
    /\b(next|continue|proceed|go on|where were we|what'?s next)\b/i,
    /\b(step \d|move on|keep going)\b/i,
  ],
  QUESTION: [
    /\?$/,
    /\b(what|who|where|when|why|how|which|explain|describe|tell me)\b/i,
  ],
  RECALL_EXPLICIT: [
    /\b(remember|recall|we (discussed|talked|decided|agreed)|last time|previously)\b/i,
    /\b(what did (we|i|you)|did we ever|have we)\b/i,
  ],
  DEBUGGING: [
    /\b(error|bug|broken|fail|crash|exception|not working|issue|wrong)\b/i,
    /\b(debug|fix|troubleshoot|investigate)\b/i,
    /^(Error|TypeError|ReferenceError|SyntaxError):/,
  ],
  PREFERENCE: [
    /\b(i (prefer|like|want|hate|dislike|never|always))\b/i,
    /\b(don'?t (use|do|make|add)|please (always|never))\b/i,
  ],
  REVIEW: [
    /\b(review|check|look at|audit|inspect|lgtm)\b/i,
    /\b(code review|pr review|pull request)\b/i,
  ],
  CONTEXT_SWITCH: [
    /\b(actually|instead|switch|change topic|different thing|forget that)\b/i,
    /\b(let'?s talk about|moving on to|pivoting to)\b/i,
  ],
  EMOTIONAL: [
    /\b(critical|urgent|asap|important|priority|production( is)? down)\b/i,
    /\b(frustrated|confused|stuck|blocked|desperate)\b/i,
    /!{2,}/, // multiple exclamation marks
  ],
  SOCIAL: [
    /^(hi|hey|hello|thanks|thank you|ok|okay|sure|yes|no|yep|nope|lol|haha)\s*[.!]?$/i,
    /^[\p{Emoji}\s]+$/u,
  ],
  INFORMATIONAL: [], // default fallback — no patterns needed
}

// ---------------------------------------------------------------------------
// Strategy Table
// ---------------------------------------------------------------------------

/**
 * Full retrieval strategy for each IntentType as specified in Section 5.1.
 */
export const STRATEGY_TABLE: Record<IntentType, RetrievalStrategy> = {
  TASK_START: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.5, recencyBias: 0.3 },
      { tier: 'procedural', weight: 1.5, recencyBias: 0.2 },
      { tier: 'episode', weight: 0.8, recencyBias: 0.6 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 2,
    boostProcedural: true,
  },

  TASK_CONTINUE: {
    shouldRecall: true,
    tiers: [
      { tier: 'episode', weight: 1.5, recencyBias: 0.8 },
      { tier: 'digest', weight: 1.0, recencyBias: 0.5 },
    ],
    queryTransform: null,
    maxResults: 8,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 1,
    boostProcedural: true,
  },

  QUESTION: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.5, recencyBias: 0.2 },
      { tier: 'episode', weight: 1.0, recencyBias: 0.5 },
      { tier: 'digest', weight: 0.8, recencyBias: 0.4 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 1,
    boostProcedural: false,
  },

  RECALL_EXPLICIT: {
    shouldRecall: true,
    tiers: [
      { tier: 'episode', weight: 1.0, recencyBias: 0.5 },
      { tier: 'digest', weight: 1.0, recencyBias: 0.5 },
      { tier: 'semantic', weight: 1.0, recencyBias: 0.3 },
      { tier: 'procedural', weight: 1.0, recencyBias: 0.3 },
    ],
    queryTransform: null,
    maxResults: 15,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 2,
    boostProcedural: false,
  },

  DEBUGGING: {
    shouldRecall: true,
    tiers: [
      { tier: 'episode', weight: 1.5, recencyBias: 0.7 },
      { tier: 'semantic', weight: 1.2, recencyBias: 0.3 },
      { tier: 'procedural', weight: 0.8, recencyBias: 0.4 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 1,
    boostProcedural: true,
  },

  PREFERENCE: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.5, recencyBias: 0.2 },
    ],
    queryTransform: null,
    maxResults: 8,
    minRelevance: 0.15,
    includeAssociations: false,
    associationHops: 0,
    boostProcedural: false,
  },

  REVIEW: {
    shouldRecall: true,
    tiers: [
      { tier: 'procedural', weight: 1.5, recencyBias: 0.3 },
      { tier: 'semantic', weight: 1.0, recencyBias: 0.2 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: false,
    associationHops: 0,
    boostProcedural: true,
  },

  CONTEXT_SWITCH: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.2, recencyBias: 0.3 },
      { tier: 'episode', weight: 1.0, recencyBias: 0.5 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 1,
    boostProcedural: true,
  },

  EMOTIONAL: {
    shouldRecall: true,
    tiers: [
      { tier: 'episode', weight: 1.2, recencyBias: 0.6 },
      { tier: 'digest', weight: 1.2, recencyBias: 0.5 },
      { tier: 'semantic', weight: 1.2, recencyBias: 0.3 },
      { tier: 'procedural', weight: 1.2, recencyBias: 0.3 },
    ],
    queryTransform: null,
    maxResults: 12,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 2,
    boostProcedural: true,
  },

  SOCIAL: {
    shouldRecall: false,
    tiers: [],
    queryTransform: null,
    maxResults: 0,
    minRelevance: 1.0,
    includeAssociations: false,
    associationHops: 0,
    boostProcedural: false,
  },

  INFORMATIONAL: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.0, recencyBias: 0.3 },
      { tier: 'episode', weight: 0.8, recencyBias: 0.5 },
    ],
    queryTransform: null,
    maxResults: 3,
    minRelevance: 0.15,
    includeAssociations: false,
    associationHops: 0,
    boostProcedural: false,
  },
}
