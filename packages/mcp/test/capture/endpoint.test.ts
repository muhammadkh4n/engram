import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEventsEndpoint, readCaptureToken } from '../../src/capture/endpoint.js'
import { appendCaptureLog, CAPTURE_LOG_MAX_BYTES, captureLogPath } from '../../src/capture/log.js'
import { PRIVATE_FILE_MODE } from '../../src/ingest/private-files.js'

const PERMISSION_BITS = constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'engram-endpoint-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('captureEventsEndpoint', () => {
  it('replaces the MCP path with the events route', () => {
    expect(captureEventsEndpoint('http://rexvps:3850/mcp')).toBe('http://rexvps:3850/capture/events')
  })

  it('drops a trailing capture path, the query and the hash', () => {
    expect(captureEventsEndpoint('http://host:9/base/mcp/?x=1#frag')).toBe('http://host:9/base/capture/events')
    expect(captureEventsEndpoint('https://host/capture')).toBe('https://host/capture/events')
    expect(captureEventsEndpoint('https://host/capture/events/')).toBe('https://host/capture/events')
    expect(captureEventsEndpoint('https://host')).toBe('https://host/capture/events')
  })
  it('throws on a URL that is not http or https, without the URL in the message', () => {
    for (const bad of ['rexvps:3850', 'tst-user:tst-pass@rexvps:3850/mcp', 'not a url', 'ftp://rexvps/mcp']) {
      expect(() => captureEventsEndpoint(bad)).toThrow(/^server URL is not an http\(s\) URL$/)
    }
  })
})

describe('readCaptureToken', () => {
  it('reads and trims the file ENGRAM_CAPTURE_TOKEN_FILE names, expanding ~/', async () => {
    mkdirSync(join(home, 'secrets'))
    writeFileSync(join(home, 'secrets', 'capture-token'), '  token-from-env-file\n')
    const env = { HOME: home, ENGRAM_CAPTURE_TOKEN_FILE: '~/secrets/capture-token' }
    await expect(readCaptureToken(env)).resolves.toBe('token-from-env-file')
  })

  it('prefers an explicit token file', async () => {
    writeFileSync(join(home, 'a'), 'token-a')
    writeFileSync(join(home, 'b'), 'token-b')
    const env = { HOME: home, ENGRAM_CAPTURE_TOKEN_FILE: join(home, 'a') }
    await expect(readCaptureToken(env, join(home, 'b'))).resolves.toBe('token-b')
  })

  it('throws when no file is named, the file is missing or it is blank', async () => {
    await expect(readCaptureToken({ HOME: home })).rejects.toThrow(/ENGRAM_CAPTURE_TOKEN_FILE is not set/)
    await expect(readCaptureToken({ HOME: home }, join(home, 'missing'))).rejects.toThrow(/cannot be read/)
    writeFileSync(join(home, 'blank'), ' \n')
    await expect(readCaptureToken({ HOME: home }, join(home, 'blank'))).rejects.toThrow(/is empty/)
  })

  it('ignores a token value placed in the environment', async () => {
    await expect(readCaptureToken({ HOME: home, ENGRAM_CAPTURE_TOKEN: 'inline' })).rejects.toThrow()
  })
})

describe('appendCaptureLog', () => {
  it('appends one owner-only line per call', () => {
    const env = { HOME: home }
    appendCaptureLog(env, 'first outcome')
    appendCaptureLog(env, 'second\noutcome')
    const lines = readFileSync(captureLogPath(env), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[^ ]+ first outcome$/)
    expect(lines[1]).toMatch(/ second outcome$/)
    expect(statSync(captureLogPath(env)).mode & PERMISSION_BITS).toBe(PRIVATE_FILE_MODE)
  })

  it('rotates the log to capture.log.1 once it is past 5 MiB', () => {
    const env = { HOME: home }
    const path = captureLogPath(env)
    appendCaptureLog(env, 'seed')
    writeFileSync(path, 'x'.repeat(CAPTURE_LOG_MAX_BYTES + 1))
    appendCaptureLog(env, 'after rotation')
    expect(statSync(`${path}.1`).size).toBe(CAPTURE_LOG_MAX_BYTES + 1)
    expect(readFileSync(path, 'utf8')).toMatch(/ after rotation\n$/)
    expect(readdirSync(join(home, '.engram')).sort()).toEqual(['capture.log', 'capture.log.1'])
  })

  it('never throws, even when the log cannot be written', () => {
    writeFileSync(join(home, '.engram'), 'a file where the directory should be')
    expect(() => appendCaptureLog({ HOME: home }, 'lost')).not.toThrow()
  })
})
