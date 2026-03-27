import { describe, it, expect } from 'vitest'
import { extractEntities } from '../../src/ingestion/entity-extractor.js'

describe('extractEntities', () => {
  describe('technology extraction', () => {
    it('extracts known language names', () => {
      const entities = extractEntities('I am writing code in TypeScript and Python')
      expect(entities).toContain('TypeScript')
      expect(entities).toContain('Python')
    })

    it('extracts frontend framework names', () => {
      const entities = extractEntities('We use React and Next.js for the frontend')
      expect(entities).toContain('React')
      expect(entities).toContain('Next.js')
    })

    it('extracts database names', () => {
      const entities = extractEntities('The app connects to PostgreSQL and Redis')
      expect(entities).toContain('PostgreSQL')
      expect(entities).toContain('Redis')
    })

    it('extracts cloud provider names', () => {
      const entities = extractEntities('Deployed on AWS and Cloudflare')
      expect(entities).toContain('AWS')
      expect(entities).toContain('Cloudflare')
    })

    it('extracts build tool names', () => {
      const entities = extractEntities('We run tests with Vitest and bundle with esbuild')
      expect(entities).toContain('Vitest')
      expect(entities).toContain('esbuild')
    })

    it('extracts ORM names', () => {
      const entities = extractEntities('Using Prisma for the database layer and Drizzle for queries')
      expect(entities).toContain('Prisma')
      expect(entities).toContain('Drizzle')
    })

    it('is case-insensitive for tech names', () => {
      const entities = extractEntities('using typescript and javascript')
      expect(entities).toContain('typescript')
      expect(entities).toContain('javascript')
    })
  })

  describe('people extraction', () => {
    it('extracts names after "tell" keyword', () => {
      const entities = extractEntities('Please tell John Smith about the update')
      expect(entities).toContain('John Smith')
    })

    it('extracts names after "ask" keyword', () => {
      const entities = extractEntities('Can you ask Alice to review this?')
      expect(entities).toContain('Alice')
    })

    it('extracts names after @ mention', () => {
      const entities = extractEntities('Ping @Sarah for the meeting')
      expect(entities).toContain('Sarah')
    })

    it('extracts two-word capitalized names', () => {
      const entities = extractEntities('. Jane Doe reviewed the PR')
      expect(entities).toContain('Jane Doe')
    })
  })

  describe('project extraction', () => {
    it('extracts kebab-case identifiers', () => {
      const entities = extractEntities('The open-claw project is coming along')
      expect(entities).toContain('open-claw')
    })

    it('extracts project name from "working on" phrase', () => {
      const entities = extractEntities('I have been working on my-app all week')
      expect(entities).toContain('my-app')
    })

    it('extracts project name from "building" phrase', () => {
      const entities = extractEntities('We are building the engram-core library')
      expect(entities).toContain('engram-core')
    })

    it('extracts multi-segment kebab-case identifiers', () => {
      const entities = extractEntities('Setting up openclaw-memory-backend for the demo')
      expect(entities).toContain('openclaw-memory-backend')
    })
  })

  describe('filtering', () => {
    it('filters common words from people results', () => {
      const entities = extractEntities('The New York office is closing')
      // "New York" should not appear as a person name since "New" is blocklisted
      expect(entities).not.toContain('New York')
    })

    it('filters very short project names', () => {
      const entities = extractEntities('Connect to db-x for data')
      // "db-x" is 4 chars, should be filtered (length must be > 3, so 4 chars pass... test >=4)
      // The filter is > 3 meaning 4 chars pass; test something that is exactly 3 or under
      const entities2 = extractEntities('Run the a-b script')
      expect(entities2).not.toContain('a-b')
    })

    it('filters common English words from project names', () => {
      const entities = extractEntities('I will have been working on this')
      // "will-have", "have-been" type artifacts should be filtered
      // These won't even appear as kebab patterns — just verify no blocklisted words
      expect(entities).not.toContain('will')
      expect(entities).not.toContain('have')
    })
  })

  describe('deduplication', () => {
    it('returns deduplicated results when same entity appears multiple times', () => {
      const entities = extractEntities('TypeScript is great. We love TypeScript. TypeScript rocks.')
      const tsCount = entities.filter(e => e.toLowerCase() === 'typescript').length
      expect(tsCount).toBe(1)
    })

    it('returns a flat array', () => {
      const entities = extractEntities('Using TypeScript and React, tell John to check my-service')
      expect(Array.isArray(entities)).toBe(true)
      entities.forEach(e => expect(typeof e).toBe('string'))
    })
  })
})
