import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core',
  'packages/sqlite',
  'packages/openai',
  'packages/openclaw',
  'packages/postgrest',
  'packages/supabase',
  'packages/graph',
  'packages/recall-engine',
])
