-- Enable Row Level Security on all openclaw-memory tables
ALTER TABLE memory_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_write_buffer ENABLE ROW LEVEL SECURITY;
