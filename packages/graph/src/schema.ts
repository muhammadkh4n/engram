export const CONSTRAINTS: string[] = [
  'CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE',
  'CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT topic_id IF NOT EXISTS FOR (t:Topic) REQUIRE t.id IS UNIQUE',
  'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE',
  'CREATE CONSTRAINT emotion_id IF NOT EXISTS FOR (e:Emotion) REQUIRE e.id IS UNIQUE',
  'CREATE CONSTRAINT intent_id IF NOT EXISTS FOR (i:Intent) REQUIRE i.id IS UNIQUE',
  'CREATE CONSTRAINT session_id IF NOT EXISTS FOR (s:Session) REQUIRE s.sessionId IS UNIQUE',
  'CREATE CONSTRAINT time_context_id IF NOT EXISTS FOR (t:TimeContext) REQUIRE t.id IS UNIQUE',
  'CREATE CONSTRAINT project_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE',
  // Wave 5: Community node (9th label)
  'CREATE CONSTRAINT community_id IF NOT EXISTS FOR (c:Community) REQUIRE c.id IS UNIQUE',
]

export const INDEXES: string[] = [
  'CREATE INDEX memory_type IF NOT EXISTS FOR (m:Memory) ON (m.memoryType)',
  'CREATE INDEX memory_created IF NOT EXISTS FOR (m:Memory) ON (m.createdAt)',
  'CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.entityType)',
  'CREATE INDEX emotion_label IF NOT EXISTS FOR (e:Emotion) ON (e.label)',
  'CREATE INDEX intent_type IF NOT EXISTS FOR (i:Intent) ON (i.intentType)',
  'CREATE INDEX time_context_composite IF NOT EXISTS FOR (t:TimeContext) ON (t.yearWeek, t.dayOfWeek, t.timeOfDay)',
  'CREATE INDEX person_name IF NOT EXISTS FOR (p:Person) ON (p.name)',
  'CREATE INDEX project_name IF NOT EXISTS FOR (p:Project) ON (p.name)',
]

export const ALL_SCHEMA_STATEMENTS: string[] = [...CONSTRAINTS, ...INDEXES]
