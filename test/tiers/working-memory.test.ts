import { describe, it, expect, vi } from 'vitest';
import { WorkingMemory } from '../../src/tiers/working-memory.js';
import type { WorkingMemoryItem, Episode } from '../../src/types.js';

function mockSupabase(data?: unknown, error?: { message: string; code?: string }) {
  const chainable = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: data ?? null, error: error ?? null }),
    insert: vi.fn().mockResolvedValue({ data: null, error: error ?? null }),
  };
  return {
    from: vi.fn().mockReturnValue(chainable),
  } as unknown as ReturnType<typeof import('@supabase/supabase-js').createClient>;
}

describe('WorkingMemory', () => {
  const item = (key: string, importance = 0.5): WorkingMemoryItem => ({
    key,
    value: `value-${key}`,
    category: 'topic',
    importance,
    timestamp: new Date().toISOString(),
  });

  it('should set and get items', () => {
    const wm = new WorkingMemory('s1', mockSupabase());
    wm.set(item('key1', 0.8));
    expect(wm.get('key1')?.value).toBe('value-key1');
    expect(wm.size()).toBe(1);
  });

  it('should evict least important item when maxItems exceeded', () => {
    const wm = new WorkingMemory('s1', mockSupabase(), undefined, 3);
    wm.set(item('a', 0.5));
    wm.set(item('b', 0.9));
    wm.set(item('c', 0.7));
    wm.set(item('d', 0.8));
    expect(wm.size()).toBe(3);
    expect(wm.get('a')).toBeUndefined();
    expect(wm.get('b')).toBeDefined();
  });

  it('should return items sorted by importance', () => {
    const wm = new WorkingMemory('s1', mockSupabase());
    wm.set(item('low', 0.1));
    wm.set(item('high', 0.9));
    wm.set(item('mid', 0.5));
    const all = wm.getAll();
    expect(all[0].key).toBe('high');
    expect(all[2].key).toBe('low');
  });

  it('should filter by category', () => {
    const wm = new WorkingMemory('s1', mockSupabase());
    wm.set({ key: 'topic1', value: 'v', category: 'topic', importance: 0.5, timestamp: '' });
    wm.set({ key: 'pref1', value: 'v', category: 'preference', importance: 0.5, timestamp: '' });
    expect(wm.getByCategory('topic')).toHaveLength(1);
    expect(wm.getByCategory('preference')).toHaveLength(1);
  });

  it('should remove items', () => {
    const wm = new WorkingMemory('s1', mockSupabase());
    wm.set(item('key1'));
    expect(wm.remove('key1')).toBe(true);
    expect(wm.size()).toBe(0);
  });

  it('should clear all items', () => {
    const wm = new WorkingMemory('s1', mockSupabase());
    wm.set(item('a'));
    wm.set(item('b'));
    wm.clear();
    expect(wm.size()).toBe(0);
  });

  describe('extractFromEpisode', () => {
    it('should extract preferences', () => {
      const wm = new WorkingMemory('s1', mockSupabase());
      const episode: Episode = {
        session_id: 's1',
        role: 'user',
        content: 'I prefer TypeScript over JavaScript.',
      };
      wm.extractFromEpisode(episode);
      const prefs = wm.getByCategory('preference');
      expect(prefs.length).toBeGreaterThan(0);
    });

    it('should extract decisions', () => {
      const wm = new WorkingMemory('s1', mockSupabase());
      const episode: Episode = {
        session_id: 's1',
        role: 'user',
        content: "Let's use Supabase for the database.",
      };
      wm.extractFromEpisode(episode);
      const decisions = wm.getByCategory('decision');
      expect(decisions.length).toBeGreaterThan(0);
    });
  });

  describe('persist', () => {
    it('should persist to Supabase', async () => {
      const supabase = mockSupabase();
      const wm = new WorkingMemory('s1', supabase);
      wm.set(item('key1'));
      await wm.persist();
      expect(supabase.from).toHaveBeenCalledWith('memory_digests');
    });

    it('should skip persist if empty', async () => {
      const supabase = mockSupabase();
      const wm = new WorkingMemory('s1', supabase);
      await wm.persist();
      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  describe('load', () => {
    it('should load snapshot from Supabase', async () => {
      const snapshot = {
        session_id: 's1',
        items: [item('loaded-key', 0.7)],
        created_at: new Date().toISOString(),
      };
      const supabase = mockSupabase({ metadata: { source: 'working_memory', snapshot } });
      const wm = new WorkingMemory('s1', supabase);
      await wm.load();
      expect(wm.get('loaded-key')).toBeDefined();
    });

    it('should handle no snapshot gracefully', async () => {
      const supabase = mockSupabase(null, { message: 'not found', code: 'PGRST116' });
      const wm = new WorkingMemory('s1', supabase);
      await wm.load();
      expect(wm.size()).toBe(0);
    });
  });
});
