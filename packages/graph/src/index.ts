// === Core classes ===
export { NeuralGraph } from './neural-graph.js'
export { SpreadingActivation } from './spreading-activation.js'

// === Configuration ===
export { parseGraphConfig, validateGraphConfig } from './config.js'
export type { GraphConfig } from './config.js'

// === Context extractors ===
export { extractPersons, classifyEmotion, classifyContentIntent } from './context-extractors.js'
export type { PersonExtraction, EmotionClassification } from './context-extractors.js'

// === Schema ===
export { ALL_SCHEMA_STATEMENTS, CONSTRAINTS, INDEXES } from './schema.js'

// === Types ===
export type {
  NodeLabel,
  BaseNodeProperties,
  MemoryNodeProperties,
  MemoryNodeInput,
  PersonNodeProperties,
  PersonNodeInput,
  TopicNodeProperties,
  TopicNodeInput,
  EntityNodeProperties,
  EntityNodeInput,
  EmotionNodeProperties,
  EmotionNodeInput,
  EmotionLabel,
  IntentNodeProperties,
  IntentNodeInput,
  SessionNodeProperties,
  SessionNodeInput,
  TimeContextNodeProperties,
  TimeContextNodeInput,
  GraphNodeProperties,
  RelationType,
  RelationshipProperties,
  ActivationParams,
  ActivationResult,
  EpisodeDecomposition,
} from './types.js'
