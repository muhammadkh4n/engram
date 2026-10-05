#!/usr/bin/env node
/**
 * Engram Memory MCP Server — Streamable HTTP transport.
 *
 * Shared deployment endpoint so multiple Claude / agent clients can hit one
 * server instance over the network instead of each spawning a local stdio
 * process. Designed to run on a private network (tailnet) with bearer auth.
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY
 *   BEARER_TOKEN          — required for all /mcp and /capture requests
 *
 * Optional env:
 *   PORT                  — default 3849
 *   HOST                  — default 0.0.0.0
 *   ALLOWED_HOSTS         — comma-separated allowlist for Host header (DNS-rebind guard).
 *                           If unset, every host is allowed.
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 *   ENGRAM_SALIENCE_THRESHOLD — capture classifier confidence cut, 0..1, default 0.7
 *   ENGRAM_CAPTURE_TOKEN  — enables POST /capture/events (at least 32 chars, not
 *                           BEARER_TOKEN). When set, ENGRAM_PROJECT_REGISTRY_FILE
 *                           (a valid registry) and ENGRAM_SECRET_SOURCES_FILE are
 *                           required too, or startup fails naming the variable.
 *                           The capture worker then materializes stored events
 *                           and embeds the new items.
 */

import { main } from './http-server.js'

// Runs on import as well as when started as the script, so a launcher that
// imports this module (pm2, a wrapper) starts the server or fails loudly.
main().catch((err) => {
  process.stderr.write(`[engram-mcp-http] Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
