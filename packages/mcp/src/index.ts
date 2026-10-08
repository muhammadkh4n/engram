#!/usr/bin/env node
/**
 * Engram Memory MCP Server — stdio transport.
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY
 * Optional env: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 *
 * For the shared HTTP deployment see index-http.ts.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { consolidationAtStartup, createEngramServer, recallOutputPolicyAtStartup } from './server-core.js'

async function main(): Promise<void> {
  // Logs to stderr, so the JSON-RPC stream on stdout stays clean.
  recallOutputPolicyAtStartup()
  consolidationAtStartup()
  const server = createEngramServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Intentionally silent — stdio transport; any stdout output corrupts the JSON-RPC stream.
}

main().catch((err) => {
  process.stderr.write(`[engram-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
