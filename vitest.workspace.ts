import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core',
  'packages/sqlite',
  'packages/openai',
  'packages/openclaw',
  'packages/supabase',
  'packages/graph',
])
