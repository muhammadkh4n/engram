#!/usr/bin/env node
/**
 * engram-extract — re-runs extraction for one session or every session with
 * an MK utterance since a time. What runs, and how, lives in extract-lib.ts.
 *
 * Usage:
 *   engram-extract (--session <id> | --since <iso>) --max-calls <n> [--version <v>]
 *                  [--dry-run] [--replace] [--report <path>]
 *
 * Env: SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY and the ENGRAM_CHAT_*
 * settings the server reads, so the re-run asks the server's model.
 *
 * Exit codes: 0 every window ran; 1 a usage error, a failed window or a
 * provider or store fault; 2 --version is not this build's extractor
 * version; 3 the run stopped at --max-calls.
 */
import { exitWhenFlushed } from '../cli-exit.js'
import { closeSync, writeSync } from 'node:fs'
import { openaiIntelligence } from '@engram-mem/openai'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { captureModelFromEnv, chatIntelligenceOptionsFromEnv } from '../server-core.js'
import { isEntryPoint } from './entry-point.js'
import {
  EXIT_FAILED,
  EXIT_VERSION,
  USAGE,
  UsageError,
  parseExtractArgs,
  runExtract,
  versionMismatch,
  type ExtractOptions,
} from './extract-lib.js'
import { openPrivateFile } from './private-files.js'

const TAG = '[engram-extract]'

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new UsageError(`${name} is not set`)
  return value
}

/** Opens the report as a new owner-only file; an existing path is refused. */
function openReport(path: string | null): number | null {
  if (path === null) return null
  try {
    return openPrivateFile(path, 'wx')
  } catch (err) {
    const code = (err as { code?: unknown }).code
    throw new UsageError(code === 'EEXIST' ? `--report ${path} already exists; give a new path` : `--report ${path} cannot be created`)
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let opts: ExtractOptions
  let reportFd: number | null = null
  try {
    opts = parseExtractArgs(argv)
    const mismatch = versionMismatch(opts.version)
    if (mismatch !== null) {
      process.stderr.write(`${TAG} ${mismatch}\n`)
      return EXIT_VERSION
    }
    const url = requireEnv('SUPABASE_URL')
    const key = requireEnv('SUPABASE_KEY')
    const apiKey = requireEnv('OPENAI_API_KEY')
    reportFd = openReport(opts.reportPath)
    const fd = reportFd
    const outcome = await runExtract(opts, {
      store: new PostgRestCaptureStore({ url, key }),
      intelligence: openaiIntelligence({ apiKey, ...chatIntelligenceOptionsFromEnv() }),
      model: captureModelFromEnv(),
      now: () => new Date(),
      emit: (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
      log: (line) => process.stderr.write(`${TAG} ${line}\n`),
      report: fd === null ? null : (entry) => writeSync(fd, `${JSON.stringify(entry)}\n`),
    })
    process.stdout.write(`${JSON.stringify({ windows: outcome.windows, calls: outcome.calls, capped: outcome.capped, dry_run: opts.dryRun })}\n`)
    return outcome.exitCode
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${TAG} ${err.message}\nusage: ${USAGE}\n`)
      return EXIT_FAILED
    }
    process.stderr.write(`${TAG} failed: ${err instanceof Error ? err.message.slice(0, 500) : 'unknown error'}\n`)
    return EXIT_FAILED
  } finally {
    if (reportFd !== null) closeSync(reportFd)
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => exitWhenFlushed(code))
}
