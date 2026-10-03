#!/usr/bin/env node
/**
 * Engram project-tag backfill
 *
 * One mode per run:
 *   - tag (default): episodes stored without a `project_id` but with an
 *     ingest-time `metadata.project` tag get the project that tag normalises
 *     to (worktrees fold into their repository, folder names and
 *     cross-cutting categories stay shared).
 *   - evidence (`--sessions` and/or `--roots`): untagged episodes get the
 *     project of their Claude session (from an `engram-session-projects`
 *     map; summaries by the session in `metadata.transcriptPath`), else of
 *     the longest configured root containing `metadata.cwd`. Cross-cutting
 *     categories stay shared.
 *   - retag (`--retag FROM=TO`): episodes, digests, semantic facts and
 *     procedures tagged FROM move to TO.
 *     `--fold-worktrees` prints the pairs the worktree folding proposes and
 *     applies nothing.
 *   - rollback (`--rollback CSV`): restores the values a previous apply
 *     recorded.
 *
 * Dry run by default: prints counts per source and per project, never
 * episode content. `--apply` writes in batches and records each batch in a
 * new rollback CSV (`table,id,old,new`) before writing it.
 *
 * Idempotent: the tag and evidence modes only touch rows whose `project_id`
 * is still NULL, and a retag only rows still tagged FROM.
 *
 * Usage:
 *   engram-project-backfill [--apply]                              # tag mode
 *   engram-project-backfill --sessions map.json [--since ISO] [--roots groups.json] [--apply]
 *   engram-project-backfill --roots groups.json [--since ISO] [--apply]
 *   engram-project-backfill --retag FROM=TO [--retag FROM=TO ...] [--apply]
 *   engram-project-backfill --fold-worktrees [--keep NAME ...]
 *   engram-project-backfill --rollback FILE.csv [--apply]
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY
 */

import { readFileSync } from 'node:fs'
import { PostgrestClient } from '@supabase/postgrest-js'
import { buildKeysetFilter } from './embed-backfill-lib.js'
import { isEntryPoint } from './entry-point.js'
import {
  collectProjectCounts,
  formatEvidenceReport,
  formatReport,
  formatRetagProposals,
  formatRetagReport,
  formatRollbackReport,
  openRollbackCsv,
  parseRetagPair,
  parseRootsFile,
  parseSessionMap,
  proposeWorktreeRetags,
  readRollbackCsv,
  runEvidenceBackfill,
  runProjectBackfill,
  runRetag,
  runRollback,
  validateRetagPairs,
  type BackfillRow,
  type BackfillRules,
  type ProjectBackfillStore,
  type ProjectRetagStore,
  type RetagPair,
  type TaggedRow,
  type UntaggedEpisode,
} from './project-backfill-lib.js'

const TAG = '[engram-project-backfill]'

export type BackfillMode = 'tag' | 'evidence' | 'retag' | 'fold-worktrees' | 'rollback'

export interface BackfillArgs {
  mode: BackfillMode
  apply: boolean
  pageSize: number
  batchSize: number
  rules: BackfillRules
  sessionsFile: string | null
  rootsFile: string | null
  since: string | null
  retag: RetagPair[]
  rollbackFile: string | null
  rollbackOut: string | null
}

export class UsageError extends Error {}

function parsePositiveInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(
      `--${flag} requires a positive integer, got ${raw === undefined ? '(missing value)' : `"${raw}"`}`,
    )
  }
  return n
}

function requireValue(raw: string | undefined, flag: string): string {
  const value = raw?.trim()
  if (!value || value.startsWith('--')) throw new UsageError(`--${flag} requires a value`)
  return value
}

const HELP =
  'engram-project-backfill — set project_id on stored memories (dry run by default)\n' +
  '  One mode per run:\n' +
  '  (no mode flag)     from metadata.project; a tag <repo>-<suffix> folds into <repo>\n' +
  '                     when <repo> is also a tag. Two real repositories sharing a prefix\n' +
  "                     fold too: read the dry run's rename list and pass --keep first.\n" +
  '  --sessions FILE    session map from engram-session-projects (by session id, or the\n' +
  '                     session in metadata.transcriptPath for summaries)\n' +
  '  --roots FILE       project-groups file; metadata.cwd resolved by its roots only\n' +
  '                     (may be combined with --sessions, which is tried first)\n' +
  '  --since ISO        with --sessions/--roots: only episodes created at or after ISO\n' +
  '  --retag FROM=TO    move project FROM to TO on episodes, digests, facts and procedures\n' +
  '                     (repeatable)\n' +
  '  --fold-worktrees   print the FROM=TO pairs the worktree folding proposes; applies nothing\n' +
  '  --rollback FILE    restore the rows a previous apply recorded\n' +
  '  Common:\n' +
  '  --apply            write (records a rollback CSV before each batch)\n' +
  '  --rollback-out F   rollback CSV path (default engram-project-backfill-<time>.rollback.csv)\n' +
  '  --page-size N      rows per fetch (default 1000)\n' +
  '  --batch-size N     ids per update (default 100)\n' +
  '  Tag mode and --fold-worktrees:\n' +
  '  --map FROM=TO      explicit tag mapping, repeatable; TO=none keeps FROM shared\n' +
  '  --shared NAME      treat NAME as a folder, not a repository (repeatable)\n' +
  '  --keep NAME        never fold NAME into another repository (repeatable)\n' +
  '  --repo NAME        a repository name absent from the data (repeatable)\n'

function parseSince(raw: string): string {
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) throw new UsageError(`--since requires an ISO timestamp, got "${raw}"`)
  return parsed.toISOString()
}

/** Parses argv; throws UsageError on any invalid or conflicting flag. */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs | 'help' {
  const aliases = new Map<string, string>()
  const sharedNames = new Set<string>()
  const keep = new Set<string>()
  const repos = new Set<string>()
  const retag: RetagPair[] = []
  let apply = false
  let fold = false
  let rulesGiven = false
  let pageSize = 1000
  let batchSize = 100
  let sessionsFile: string | null = null
  let rootsFile: string | null = null
  let since: string | null = null
  let rollbackFile: string | null = null
  let rollbackOut: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--map') {
      const spec = requireValue(argv[++i], 'map')
      const eq = spec.indexOf('=')
      const from = spec.slice(0, eq).trim()
      const to = spec.slice(eq + 1).trim()
      if (eq <= 0 || !from || !to) throw new UsageError(`--map expects FROM=TO, got "${spec}"`)
      aliases.set(from, to)
      rulesGiven = true
    } else if (a === '--shared') {
      sharedNames.add(requireValue(argv[++i], 'shared'))
      rulesGiven = true
    } else if (a === '--keep') {
      keep.add(requireValue(argv[++i], 'keep'))
      rulesGiven = true
    } else if (a === '--repo') {
      repos.add(requireValue(argv[++i], 'repo'))
      rulesGiven = true
    } else if (a === '--sessions') sessionsFile = requireValue(argv[++i], 'sessions')
    else if (a === '--roots') rootsFile = requireValue(argv[++i], 'roots')
    else if (a === '--since') since = parseSince(requireValue(argv[++i], 'since'))
    else if (a === '--retag') {
      try {
        retag.push(parseRetagPair(requireValue(argv[++i], 'retag')))
      } catch (err) {
        throw new UsageError((err as Error).message)
      }
    } else if (a === '--fold-worktrees') fold = true
    else if (a === '--rollback') rollbackFile = requireValue(argv[++i], 'rollback')
    else if (a === '--rollback-out') rollbackOut = requireValue(argv[++i], 'rollback-out')
    else if (a === '--page-size') pageSize = parsePositiveInt(argv[++i], 'page-size')
    else if (a === '--batch-size') batchSize = parsePositiveInt(argv[++i], 'batch-size')
    else if (a === '--help' || a === '-h') return 'help'
    else throw new UsageError(`unknown argument "${a}"`)
  }

  const modes: BackfillMode[] = []
  if (sessionsFile !== null || rootsFile !== null) modes.push('evidence')
  if (retag.length > 0) modes.push('retag')
  if (fold) modes.push('fold-worktrees')
  if (rollbackFile !== null) modes.push('rollback')
  if (modes.length > 1) throw new UsageError(`choose one mode per run, got ${modes.join(' + ')}`)
  const mode = modes[0] ?? 'tag'

  if (since !== null && mode !== 'evidence') throw new UsageError('--since applies only to --sessions/--roots')
  if (rulesGiven && mode !== 'tag' && mode !== 'fold-worktrees') {
    throw new UsageError('--map/--shared/--keep/--repo apply only to the tag mode and --fold-worktrees')
  }
  if (fold && apply) throw new UsageError('--fold-worktrees only proposes; pass the pairs as --retag to apply')
  if (rollbackOut !== null && (!apply || mode === 'rollback')) {
    throw new UsageError('--rollback-out applies only to an --apply that writes new values')
  }
  try {
    validateRetagPairs(retag)
  } catch (err) {
    throw new UsageError((err as Error).message)
  }

  return {
    mode,
    apply,
    pageSize,
    batchSize,
    rules: { aliases, sharedNames, keep, repos },
    sessionsFile,
    rootsFile,
    since,
    retag,
    rollbackFile,
    rollbackOut,
  }
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new UsageError(`${what} ${path} unreadable: ${(err as Error).message}`)
  }
}

function tagStore(client: PostgrestClient): ProjectBackfillStore {
  return {
    async fetchPage(cursor, pageSize) {
      let q = client
        .from('memory_episodes')
        .select('id, created_at, project:metadata->>project, category:metadata->>salienceCategory')
        .is('project_id', null)
        .not('metadata->>project', 'is', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(pageSize)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
      if (error) throw new Error(`fetchPage failed: ${error.message}`)
      return (data ?? []) as unknown as BackfillRow[]
    },
    async assignProject(ids, project) {
      const { data, error } = await client
        .from('memory_episodes')
        .update({ project_id: project })
        .in('id', [...ids])
        .is('project_id', null)
        .select('id')
      if (error) throw new Error(`update to ${project} failed: ${error.message}`)
      return (data ?? []).length
    },
  }
}

function retagStore(client: PostgrestClient): ProjectRetagStore {
  return {
    async fetchUntaggedEpisodes(since, cursor, pageSize) {
      let q = client
        .from('memory_episodes')
        .select(
          'id, created_at, session_id, transcript_path:metadata->>transcriptPath, ' +
            'cwd:metadata->>cwd, category:metadata->>salienceCategory',
        )
        .is('project_id', null)
      if (since !== null) q = q.gte('created_at', since)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(pageSize)
      if (error) throw new Error(`fetchUntaggedEpisodes failed: ${error.message}`)
      return (data ?? []) as unknown as UntaggedEpisode[]
    },
    async fetchTagged(table, project, cursor, pageSize) {
      let q = client.from(table).select('id, created_at, project_id')
      q = project === null ? q.not('project_id', 'is', null) : q.eq('project_id', project)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(pageSize)
      if (error) throw new Error(`fetchTagged(${table}) failed: ${error.message}`)
      return (data ?? []) as TaggedRow[]
    },
    async setProject(table, ids, from, to) {
      let q = client.from(table).update({ project_id: to }).in('id', [...ids])
      q = from === null ? q.is('project_id', null) : q.eq('project_id', from)
      const { data, error } = await q.select('id')
      if (error) throw new Error(`update ${table} to ${to ?? 'NULL'} failed: ${error.message}`)
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
    },
  }
}

function defaultRollbackPath(now: Date = new Date()): string {
  return `engram-project-backfill-${now.toISOString().replace(/[:.]/g, '-')}.rollback.csv`
}

async function run(args: BackfillArgs, client: PostgrestClient): Promise<string> {
  const store = retagStore(client)
  if (args.mode === 'fold-worktrees') {
    const counts = await collectProjectCounts(store, args.pageSize)
    return formatRetagProposals(proposeWorktreeRetags(counts, args.rules))
  }
  if (args.mode === 'rollback') {
    const changes = readRollbackCsv(args.rollbackFile!)
    const report = await runRollback(store, changes, { apply: args.apply, batchSize: args.batchSize })
    return formatRollbackReport(report, args.apply)
  }

  const rollbackPath = args.apply ? (args.rollbackOut ?? defaultRollbackPath()) : null
  const rollback = rollbackPath ? openRollbackCsv(rollbackPath) : undefined
  if (rollbackPath) console.log(`${TAG} rollback record: ${rollbackPath}`)
  const write = { apply: args.apply, pageSize: args.pageSize, batchSize: args.batchSize, rollback }
  try {
    if (args.mode === 'evidence') {
      const sessions = args.sessionsFile
        ? parseSessionMap(readJson(args.sessionsFile, 'session map'))
        : undefined
      const roots = args.rootsFile ? parseRootsFile(readJson(args.rootsFile, 'roots file'), args.rootsFile) : undefined
      const report = await runEvidenceBackfill(store, { sessions, roots }, { ...write, since: args.since })
      return formatEvidenceReport(report, args.apply)
    }
    if (args.mode === 'retag') return formatRetagReport(await runRetag(store, args.retag, write), args.apply)
    return formatReport(await runProjectBackfill(tagStore(client), args.rules, write), args.apply)
  } finally {
    rollback?.close()
  }
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2))
  if (args === 'help') {
    console.log(HELP)
    return
  }
  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_KEY']
  if (!url || !key) throw new UsageError('Missing SUPABASE_URL / SUPABASE_KEY')

  const client = new PostgrestClient(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  })
  console.log(
    `${TAG} mode=${args.mode} ${args.apply ? 'APPLY' : 'DRY-RUN'} page-size=${args.pageSize} batch-size=${args.batchSize}`,
  )
  console.log(await run(args, client))
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err: unknown) => {
    const prefix = err instanceof UsageError ? TAG : `${TAG} FATAL:`
    console.error(prefix, err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
