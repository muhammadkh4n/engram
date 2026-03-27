# Contributing to Engram

Thank you for your interest in contributing to Engram! This guide explains how to set up your environment, understand the codebase structure, and submit contributions.

## Development Setup

### Prerequisites
- Node.js 18+
- npm 9+
- Git

### Quick Start

```bash
# Clone the repository
git clone https://github.com/muhammadkh4n/openclaw-memory.git
cd openclaw-memory

# Install dependencies
npm install

# Run all tests
npm test

# Build all packages
npm build

# Type check
npm typecheck

# Clean build artifacts
npm clean
```

## Monorepo Structure

Engram is a Turborepo-based monorepo. Each package is independent but shares type definitions and adapters.

```
openclaw-memory/
├── packages/
│   ├── core/              # @engram/core — Memory engine
│   │   ├── src/
│   │   │   ├── memory.ts  # Memory class and createMemory() factory
│   │   │   ├── systems/   # 5 memory systems (sensory, episodic, semantic, procedural, associations)
│   │   │   ├── intent/    # Intent analyzer and salience detector
│   │   │   ├── retrieval/ # 4-stage recall engine
│   │   │   ├── consolidation/  # Sleep cycles (light, deep, dream, decay)
│   │   │   ├── adapters/  # Storage and Intelligence adapter interfaces
│   │   │   └── types.ts   # Type definitions
│   │   ├── test/          # Vitest test files
│   │   └── package.json
│   │
│   ├── sqlite/            # @engram/sqlite — Local storage
│   │   ├── src/
│   │   │   ├── adapter.ts       # StorageAdapter implementation
│   │   │   ├── migrations.ts    # SQLite schema
│   │   │   └── search.ts        # BM25 via FTS5
│   │   └── test/
│   │
│   ├── openai/            # @engram/openai — Embeddings + summarization
│   │   ├── src/
│   │   │   ├── embeddings.ts    # OpenAI embedding service
│   │   │   ├── summarizer.ts    # LLM-based summarization
│   │   │   └── index.ts         # Intelligence adapter factory
│   │   └── test/
│   │
│   ├── supabase/          # @engram/supabase — Cloud storage
│   │   ├── src/
│   │   │   ├── adapter.ts
│   │   │   └── migrations/
│   │   └── test/
│   │
│   └── openclaw/          # @engram/openclaw — OpenClaw plugin
│       ├── src/
│       │   └── openclaw-plugin.ts
│       └── package.json
│
├── docs/
│   └── engram-design.md   # Full design specification
├── examples/
│   └── demo.mjs           # Standalone demo script
├── README.md
├── CHANGELOG.md
└── package.json (root)
```

## Making Changes

### Adding a Feature

1. **Write tests first** — Engram uses test-driven development
   ```bash
   # Create a test file in packages/*/test/
   # Run only that test
   npm test -- packages/core/test/my-feature.test.ts
   ```

2. **Implement the feature** — Update code in `packages/*/src/`

3. **Ensure tests pass** — Run full suite
   ```bash
   npm test
   ```

4. **Type check** — Engram is fully typed
   ```bash
   npm typecheck
   ```

5. **Build** — Verify compilation
   ```bash
   npm build
   ```

### Adding a New Storage Adapter

Storage adapters implement the `StorageAdapter` interface from `@engram/core`.

**Steps**:

1. Create `packages/my-storage/src/adapter.ts` implementing:
   ```typescript
   interface StorageAdapter {
     initialize(): Promise<void>
     dispose(): Promise<void>

     episodes: EpisodeStorage
     digests: DigestStorage
     semantic: SemanticStorage
     procedural: ProceduralStorage
     associations: AssociationStorage

     saveSensorySnapshot(sessionId: string, snapshot: SensorySnapshot): Promise<void>
     getSensorySnapshot(sessionId: string): Promise<SensorySnapshot | null>

     getById(id: string, type: MemoryType): Promise<TypedMemory | null>
   }
   ```

2. Implement each storage interface:
   - `EpisodeStorage` — Raw conversation turns
   - `DigestStorage` — Session summaries
   - `SemanticStorage` — Extracted facts (searchable, decayable)
   - `ProceduralStorage` — Learned workflows
   - `AssociationStorage` — Memory graph edges

3. Add full test coverage in `packages/my-storage/test/adapter.test.ts`

4. Export a factory function:
   ```typescript
   export function myStorageAdapter(opts?): StorageAdapter {
     return new MyStorageAdapter(opts)
   }
   ```

5. Document in `packages/my-storage/README.md`

### Adding a New Intelligence Adapter

Intelligence adapters implement the `IntelligenceAdapter` interface.

**Steps**:

1. Create `packages/my-intelligence/src/index.ts` implementing:
   ```typescript
   interface IntelligenceAdapter {
     embed?(text: string): Promise<number[]>
     embedBatch?(texts: string[]): Promise<number[][]>
     dimensions?(): number

     summarize?(content: string, opts?: SummarizeOptions): Promise<string>
     extractKnowledge?(content: string): Promise<KnowledgeExtraction>
   }
   ```

2. Add tests in `packages/my-intelligence/test/`

3. Export a factory function that returns the adapter:
   ```typescript
   export function myIntelligence(opts?): IntelligenceAdapter {
     return {
       embed: (text) => { /* ... */ },
       summarize: (content) => { /* ... */ },
     }
   }
   ```

## Testing Conventions

### Test Organization

- Tests live in `packages/*/test/*.test.ts`
- Use Vitest (npm test runs Vitest)
- One test file per major module or feature

### Example Test

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Memory } from '../src/memory'
import { InMemoryStorageAdapter } from '../test/fixtures/in-memory-adapter'

describe('Memory.recall', () => {
  let memory: Memory

  beforeEach(async () => {
    const storage = new InMemoryStorageAdapter()
    memory = new Memory({ storage })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('should recall ingested messages by keyword', async () => {
    await memory.ingest({
      sessionId: 'test',
      role: 'user',
      content: 'I prefer TypeScript'
    })

    const result = await memory.recall('What languages do you prefer?')
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].content).toContain('TypeScript')
  })
})
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests for one package
npm test -- packages/core

# Run specific test file
npm test -- packages/core/test/memory.test.ts

# Run with coverage
npm test -- --coverage
```

## Code Style

- TypeScript with strict mode enabled
- Use async/await (not .then())
- Prefer immutability where sensible
- Document public APIs with JSDoc comments
- No external dependencies unless critical (prefer stdlib)

### Linting

Currently, there's no automated linting, but follow these practices:
- 2-space indentation
- Named exports for classes and functions
- Use `readonly` for immutable properties
- Use type-only imports: `import type { X } from '...'`

## Documentation

### README Updates

Each package should have a README covering:
- What the package does
- Installation instructions
- Basic usage example
- Configuration options
- Known limitations

### Code Comments

- Comment complex logic, not obvious code
- Link to relevant papers or design docs when appropriate
- Use `// TODO:` for future work

### Design Specification

If you're making architectural changes, update `docs/engram-design.md`.

## Commit Guidelines

- Use clear, imperative commit messages: "Add support for X", not "Added X" or "Adding X"
- Prefix with feature type: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`
- Examples:
  - `feat: add dream cycle to association learning`
  - `fix: prevent duplicate temporal edges in ingest`
  - `docs: update API reference for recall()`
  - `test: add edge case for procedural decay`

## Pull Request Process

1. **Create a feature branch** — `git checkout -b feat/your-feature`
2. **Make your changes** — Commit regularly with clear messages
3. **Write/update tests** — All new code must have tests
4. **Update docs** — READMEs, inline comments, CHANGELOG (in PR description)
5. **Ensure tests pass** — `npm test && npm typecheck && npm build`
6. **Push and open PR** — Link any related issues
7. **Address feedback** — Maintainers may request changes

### PR Template

```markdown
## Description
Brief description of what this PR does.

## Related Issues
Fixes #123

## Changes
- Added feature X
- Updated docs for feature Y
- Added N tests for...

## Testing
- [ ] All tests pass
- [ ] New tests added
- [ ] Manual testing done (describe)

## Checklist
- [ ] Code follows style guide
- [ ] Documentation updated
- [ ] No breaking changes (or documented in CHANGELOG)
```

## Reporting Issues

- Use GitHub Issues
- Include: reproduction steps, expected behavior, actual behavior
- For bugs: minimal code example that reproduces the issue
- For features: explain the use case and expected benefits

## Getting Help

- Check existing GitHub Issues and Discussions
- Read the design spec: `docs/engram-design.md`
- Review demo script: `examples/demo.mjs`
- Examine test files for usage examples

## License

By contributing to Engram, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing!
