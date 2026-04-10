import { describe, it, expect } from 'vitest'
import { parseGraphConfig, validateGraphConfig } from '../src/config.js'

describe('parseGraphConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = parseGraphConfig({})
    expect(config.neo4jUri).toBe('bolt://localhost:7687')
    expect(config.neo4jUser).toBe('neo4j')
    expect(config.neo4jPassword).toBe('engram-dev')
    expect(config.enabled).toBe(true)
  })

  it('reads from environment variables', () => {
    const config = parseGraphConfig({
      NEO4J_URI: 'bolt://production:7687',
      NEO4J_USER: 'admin',
      NEO4J_PASSWORD: 'secret',
      ENGRAM_GRAPH_ENABLED: 'false',
    })
    expect(config.neo4jUri).toBe('bolt://production:7687')
    expect(config.neo4jUser).toBe('admin')
    expect(config.neo4jPassword).toBe('secret')
    expect(config.enabled).toBe(false)
  })

  it('treats any value except "false" as enabled', () => {
    expect(parseGraphConfig({ ENGRAM_GRAPH_ENABLED: 'true' }).enabled).toBe(true)
    expect(parseGraphConfig({ ENGRAM_GRAPH_ENABLED: 'yes' }).enabled).toBe(true)
    expect(parseGraphConfig({ ENGRAM_GRAPH_ENABLED: '1' }).enabled).toBe(true)
    expect(parseGraphConfig({ ENGRAM_GRAPH_ENABLED: 'false' }).enabled).toBe(false)
  })
})

describe('validateGraphConfig', () => {
  it('passes for valid config', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'bolt://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'test',
      enabled: true,
    })).not.toThrow()
  })

  it('accepts neo4j:// protocol', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'neo4j://cluster:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'test',
      enabled: true,
    })).not.toThrow()
  })

  it('rejects invalid protocol', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'http://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'test',
      enabled: true,
    })).toThrow(/must start with bolt:\/\/ or neo4j:\/\//)
  })

  it('rejects empty user', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'bolt://localhost:7687',
      neo4jUser: '',
      neo4jPassword: 'test',
      enabled: true,
    })).toThrow(/neo4jUser is required/)
  })

  it('rejects empty password', () => {
    expect(() => validateGraphConfig({
      neo4jUri: 'bolt://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: '',
      enabled: true,
    })).toThrow(/neo4jPassword is required/)
  })
})
