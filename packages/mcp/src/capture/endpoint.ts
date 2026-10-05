/**
 * Where capture events are posted and the token they are posted with.
 *
 * `ENGRAM_SERVER_URL` is the server's MCP endpoint (`…/mcp`), shared with the
 * MCP client config; the events route is its sibling path. The token is read
 * from a file and never from the environment, because the settings env
 * reaches every Bash tool call a session runs.
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Env = Record<string, string | undefined>

export const CAPTURE_TOKEN_FILE_ENV = 'ENGRAM_CAPTURE_TOKEN_FILE'

/** Drops a trailing `/mcp`, `/capture` or `/capture/events`, the query and the hash; appends `/capture/events`. */
export function captureEventsEndpoint(serverUrl: string): string {
  const url = new URL(serverUrl)
  const base = url.pathname.replace(/\/+$/, '').replace(/\/(?:mcp|capture\/events|capture)$/, '')
  url.pathname = `${base}/capture/events`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function expandHome(path: string, env: Env): string {
  return path.startsWith('~/') ? join(env.HOME || homedir(), path.slice(2)) : path
}

/**
 * The capture token from `tokenFile`, else from the file
 * `ENGRAM_CAPTURE_TOKEN_FILE` names; trimmed, with `~/` expanded. Throws when
 * neither is set, the file cannot be read or it holds only whitespace. Error
 * messages name the file, never its content.
 */
export async function readCaptureToken(env: Env, tokenFile?: string): Promise<string> {
  const file = tokenFile || env[CAPTURE_TOKEN_FILE_ENV]
  if (!file) throw new Error(`${CAPTURE_TOKEN_FILE_ENV} is not set`)
  let content: string
  try {
    content = await fs.readFile(expandHome(file, env), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'error'
    throw new Error(`capture token file ${file} cannot be read (${code})`)
  }
  const token = content.trim()
  if (!token) throw new Error(`capture token file ${file} is empty`)
  return token
}
