import type { SearchResult, RetrievalGateResult, TierName } from '../types.js';

export interface GateOptions {
  minScore: number;
  maxResults: number;
}

const DEFAULT_GATE_OPTIONS: GateOptions = {
  minScore: 0.3,
  maxResults: 10,
};

export class RetrievalGate {
  private opts: GateOptions;

  constructor(opts?: Partial<GateOptions>) {
    this.opts = { ...DEFAULT_GATE_OPTIONS, ...opts };
  }

  filter<T>(results: SearchResult<T>[], tier: TierName): RetrievalGateResult<T> {
    const qualifying = results.filter((r) => r.similarity >= this.opts.minScore);
    const sorted = qualifying.sort((a, b) => b.similarity - a.similarity);
    const capped = sorted.slice(0, this.opts.maxResults);
    return {
      results: capped,
      filtered: results.length - capped.length,
      tier,
    };
  }

  getMinScore(): number {
    return this.opts.minScore;
  }

  getMaxResults(): number {
    return this.opts.maxResults;
  }
}
