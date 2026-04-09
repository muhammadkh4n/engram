-- Enable RLS on tables that were missing it
ALTER TABLE episode_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_associations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_procedural ENABLE ROW LEVEL SECURITY;

-- Explicit service_role full access on all engram tables
-- (service_role bypasses RLS, but policies make the intent explicit
-- and block anon/authenticated from accessing memory data)
CREATE POLICY service_role_all ON memory_episodes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON memory_digests FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON memory_semantic FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON memory_procedural FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON memory_write_buffer FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON memory_associations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all ON episode_parts FOR ALL TO service_role USING (true) WITH CHECK (true);
