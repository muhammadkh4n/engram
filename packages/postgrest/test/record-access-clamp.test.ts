/**
 * engram_record_access is the one writer of confidence on access. A boost of
 * any sign must keep confidence inside the [0, 1] CHECK on both tiers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function functionBody(name: string): string {
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
  )
  const m = schema.match(re)
  if (!m) throw new Error(`function ${name} not found in schema.sql`)
  return m[1]!
}

describe('schema.sql engram_record_access', () => {
  it('clamps confidence to [0, 1] on the semantic and procedural tiers', () => {
    const body = functionBody('engram_record_access')
    const clamp = 'confidence = GREATEST(0.0, LEAST(1.0, confidence + p_conf_boost))'
    expect(body.split(clamp).length - 1).toBe(2)
    expect(body).not.toMatch(/confidence = LEAST\(1\.0/)
  })

  it('leaves episodes without a confidence write', () => {
    const body = functionBody('engram_record_access')
    const episodeBranch = body.slice(body.indexOf("'episode'"), body.indexOf("'semantic'"))
    expect(episodeBranch).toContain('access_count = access_count + 1')
    expect(episodeBranch).not.toContain('confidence')
  })
})
