import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Summarizer } from '../../src/tiers/summarizer.js';
import type { Episode } from '../../src/types.js';

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{
              message: {
                content: JSON.stringify({
                  summary: 'User asked about TypeScript generics and constraints.',
                  topics: ['TypeScript', 'generics', 'constraints'],
                  entities: ['TypeScript'],
                  decisions: ['Use generic constraints for type safety'],
                }),
              },
            }],
          }),
        },
      };
    },
  };
});

describe('Summarizer', () => {
  const episodes: Episode[] = [
    { id: 'ep1', session_id: 's1', role: 'user', content: 'Tell me about TypeScript generics.' },
    { id: 'ep2', session_id: 's1', role: 'assistant', content: 'TypeScript generics allow you to write reusable type-safe code...' },
    { id: 'ep3', session_id: 's1', role: 'user', content: 'How do constraints work?' },
  ];

  let summarizer: Summarizer;

  beforeEach(() => {
    summarizer = new Summarizer({ apiKey: 'test-key' });
  });

  it('should summarize episodes into structured result', async () => {
    const result = await summarizer.summarize(episodes);
    expect(result.summary).toContain('TypeScript');
    expect(result.topics).toContain('TypeScript');
    expect(result.entities.length).toBeGreaterThan(0);
  });

  it('should return empty result for no episodes', async () => {
    const result = await summarizer.summarize([]);
    expect(result.summary).toBe('');
    expect(result.topics).toEqual([]);
  });

  it('should produce a digest-compatible object', async () => {
    const digest = await summarizer.summarizeToDigest('s1', episodes);
    expect(digest.session_id).toBe('s1');
    expect(digest.summary).toBeDefined();
    expect(digest.key_topics).toBeDefined();
    expect(digest.episode_ids).toEqual(['ep1', 'ep2', 'ep3']);
    expect(digest.metadata?.source).toBe('summarizer');
  });

  it('should handle malformed LLM response gracefully', async () => {
    // Override the mock for this test
    const badSummarizer = new Summarizer({ apiKey: 'test-key' });
    const openaiInstance = (badSummarizer as any).client;
    openaiInstance.chat.completions.create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'Not valid JSON at all!' } }],
    });

    const result = await badSummarizer.summarize(episodes);
    // Should fallback to using raw text as summary
    expect(result.summary).toBeDefined();
    expect(result.topics).toEqual([]);
  });
});
