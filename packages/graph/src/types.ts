import type { MemoryType, IntentType } from '@engram-mem/core'

// ============================================================================
// Neo4j Node Labels
// ============================================================================

export type NodeLabel =
  | 'Memory'
  | 'Person'
  | 'Topic'
  | 'Entity'
  | 'Emotion'
  | 'Intent'
  | 'Session'
  | 'TimeContext'

// ============================================================================
// Base Properties (shared by all nodes)
// ============================================================================

export interface BaseNodeProperties {
  id: string
  createdAt: string
  lastAccessed: string
  activationCount: number
}

// ============================================================================
// Memory Node
// ============================================================================

export interface MemoryNodeProperties extends BaseNodeProperties {
  memoryType: MemoryType
  label: string
  projectId?: string
}

export interface MemoryNodeInput {
  id: string
  memoryType: MemoryType
  label: string
  projectId?: string
}

// ============================================================================
// Person Node (ENGRAM CELL -- global singleton)
// ============================================================================

export interface PersonNodeProperties extends BaseNodeProperties {
  name: string
  aliases: string
  firstSeen: string
  lastSeen: string
}

export interface PersonNodeInput {
  name: string
  aliases?: string[]
}

// ============================================================================
// Topic Node (ENGRAM CELL -- global singleton)
// ============================================================================

export interface TopicNodeProperties extends BaseNodeProperties {
  name: string
  description?: string
}

export interface TopicNodeInput {
  name: string
  description?: string
}

// ============================================================================
// Entity Node (ENGRAM CELL -- global singleton)
// ============================================================================

export interface EntityNodeProperties extends BaseNodeProperties {
  name: string
  entityType: 'tech' | 'concept' | 'tool' | 'project'
}

export interface EntityNodeInput {
  name: string
  entityType: 'tech' | 'concept' | 'tool' | 'project'
}

// ============================================================================
// Emotion Node (SESSION-SCOPED -- not a global singleton)
// ============================================================================

export interface EmotionNodeProperties extends BaseNodeProperties {
  label: EmotionLabel
  intensity: number
  sessionScoped: boolean
  sessionId?: string
}

export type EmotionLabel =
  | 'excited'
  | 'frustrated'
  | 'neutral'
  | 'urgent'
  | 'curious'
  | 'determined'
  | 'confused'
  | 'satisfied'

export interface EmotionNodeInput {
  label: EmotionLabel
  intensity: number
  sessionId: string
  sessionScoped?: boolean
}

// ============================================================================
// Intent Node (SESSION-SCOPED)
// ============================================================================

export interface IntentNodeProperties extends BaseNodeProperties {
  intentType: IntentType
  sessionScoped: boolean
  sessionId?: string
}

export interface IntentNodeInput {
  intentType: IntentType
  sessionId: string
  sessionScoped?: boolean
}

// ============================================================================
// Session Node
// ============================================================================

export interface SessionNodeProperties extends BaseNodeProperties {
  sessionId: string
  startTime: string
  endTime?: string
}

export interface SessionNodeInput {
  sessionId: string
  startTime: string
  endTime?: string
}

// ============================================================================
// TimeContext Node
// ============================================================================

export interface TimeContextNodeProperties extends BaseNodeProperties {
  yearWeek: string
  dayOfWeek: string
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night'
}

export interface TimeContextNodeInput {
  timestamp: Date
}

// ============================================================================
// Union Types
// ============================================================================

export type GraphNodeProperties =
  | MemoryNodeProperties
  | PersonNodeProperties
  | TopicNodeProperties
  | EntityNodeProperties
  | EmotionNodeProperties
  | IntentNodeProperties
  | SessionNodeProperties
  | TimeContextNodeProperties

// ============================================================================
// Relationship Types
// ============================================================================

export type RelationType =
  | 'TEMPORAL'
  | 'CAUSAL'
  | 'TOPICAL'
  | 'SUPPORTS'
  | 'CONTRADICTS'
  | 'ELABORATES'
  | 'DERIVES_FROM'
  | 'CO_RECALLED'
  | 'SPOKE'
  | 'CONTEXTUAL'
  | 'EMOTIONAL'
  | 'INTENTIONAL'
  | 'OCCURRED_IN'
  | 'OCCURRED_AT'

export interface RelationshipProperties {
  weight: number
  createdAt: string
  lastTraversed: string
  traversalCount: number
}

// ============================================================================
// Spreading Activation Types
// ============================================================================

export interface ActivationParams {
  maxHops?: number
  decayPerHop?: number
  minActivation?: number
  maxNodes?: number
  minWeight?: number
  edgeTypeFilter?: RelationType[]
}

export interface ActivationResult {
  nodeId: string
  nodeType: NodeLabel
  properties: Record<string, unknown>
  activation: number
  hops: number
}

// ============================================================================
// Episode Decomposition Input
// ============================================================================

export interface EpisodeDecomposition {
  episodeId: string
  memoryType: MemoryType
  label: string
  sessionId: string
  timestamp: Date
  persons: string[]
  entities: Array<{ name: string; entityType: 'tech' | 'concept' | 'tool' | 'project' }>
  emotion: { label: EmotionLabel; intensity: number } | null
  intent: IntentType | null
  projectId?: string
}
