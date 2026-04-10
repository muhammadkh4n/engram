#!/usr/bin/env node
/**
 * engram-git-setup — install/uninstall/status the global git post-commit
 * hook that ingests commit messages into Engram memory.
 *
 * The hook is installed at ~/.engram/git-hooks/post-commit and activated
 * globally via `git config --global core.hooksPath ~/.engram/git-hooks`.
 * This means every git commit in every repo on this machine will fire
 * the hook unless --hooks-path is overridden per-repo or the hook bails
 * out (missing build, disabled env, rebase in progress, etc).
 *
 * The hook is conservative:
 *   - exits 0 unconditionally on any failure path
 *   - skips during rebase / cherry-pick to avoid transient noise
 *   - runs engram-ingest fully detached so `git commit` returns fast
 *   - chains to repo-local .git/hooks/post-commit-local when present so
 *     repo-specific hooks still get a chance to run
 *
 * Usage:
 *   engram-git-setup install           # write hook, set core.hooksPath
 *   engram-git-setup uninstall         # unset core.hooksPath, leave hook file
 *   engram-git-setup status            # show current state
 *   engram-git-setup --dry-run         # print what install would do
 */

import { execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Derive the dist path for engram-ingest from this file's location.
// When installed, this script lives at
//   packages/mcp/dist/git-setup-cli.js
// and the CLI it invokes lives at
//   packages/mcp/dist/ingest/engram-ingest-cli.js
const thisFile = fileURLToPath(import.meta.url)
const thisDir = dirname(thisFile)
const INGEST_CLI = resolve(thisDir, 'ingest', 'engram-ingest-cli.js')

const ENGRAM_DIR = join(homedir(), '.engram')
const HOOK_DIR = join(ENGRAM_DIR, 'git-hooks')
const HOOK_PATH = join(HOOK_DIR, 'post-commit')
const ENV_FILE = join(ENGRAM_DIR, 'env')
const LOG_FILE = join(ENGRAM_DIR, 'git-hook.log')

// ---------------------------------------------------------------------------
// Hook template
// ---------------------------------------------------------------------------

/**
 * Build the post-commit script as a POSIX sh source string.
 *
 * The hook resolves engram-ingest via PATH lookup first (the expected
 * install path after `npm install -g @engram-mem/mcp`), and falls back
 * to the absolute dist path if PATH resolution fails. This lets the
 * hook survive both published installs and in-workspace builds without
 * a reinstall.
 */
function buildPostCommitScript(ingestCli: string, envFile: string, logFile: string): string {
  return `#!/bin/sh
# Engram global git post-commit hook
# Installed by engram-git-setup. Never let this hook fail the commit —
# exit 0 is the default on every path. Reinstall with engram-git-setup.

# Load engram env (credentials). Silent if the file is absent.
[ -f "${envFile}" ] && . "${envFile}" 2>/dev/null || true

# Respect the global salience gate kill switch
if [ "\$ENGRAM_SALIENCE_DISABLED" = "1" ]; then
  exit 0
fi

# Resolve the engram-ingest CLI. Prefer the PATH-installed bin (from
# \`npm install -g @engram-mem/mcp\`), fall back to the in-workspace dist
# path baked in at install time.
INGEST_BIN="\$(command -v engram-ingest 2>/dev/null)"
INGEST_FALLBACK="${ingestCli}"
if [ -z "\$INGEST_BIN" ] && [ ! -f "\$INGEST_FALLBACK" ]; then
  exit 0
fi

# Resolve git context; bail if anything is weird
GIT_DIR=\$(git rev-parse --git-dir 2>/dev/null)
if [ -z "\$GIT_DIR" ]; then
  exit 0
fi

# Skip during rebase / cherry-pick / interactive rewrites. These fire
# commits rapidly in a transient state and we don't want to double-capture
# content that will be squashed, reordered, or discarded.
if [ -f "\$GIT_DIR/rebase-merge/interactive" ] || \\
   [ -d "\$GIT_DIR/rebase-merge" ] || \\
   [ -d "\$GIT_DIR/rebase-apply" ] || \\
   [ -f "\$GIT_DIR/CHERRY_PICK_HEAD" ]; then
  exit 0
fi

# Gather commit metadata. Every command has a safety fallback so any
# single failure falls through to empty rather than aborting the hook.
HASH=\$(git rev-parse --short HEAD 2>/dev/null || echo "")
SUBJECT=\$(git log -1 --format='%s' 2>/dev/null || echo "")
BODY=\$(git log -1 --format='%b' 2>/dev/null || echo "")
BRANCH=\$(git branch --show-current 2>/dev/null || echo detached)
REPO_ROOT=\$(git rev-parse --show-toplevel 2>/dev/null || echo "")
REPO=\$(basename "\$REPO_ROOT" 2>/dev/null || echo unknown)
FILES_COUNT=\$(git log -1 --format='' --name-only 2>/dev/null | grep -c . || echo 0)
TOP_FILES=\$(git log -1 --format='' --name-only 2>/dev/null | head -5 | tr '\\n' ' ' || echo "")

# Skip empty-subject commits (shouldn't happen but defensive)
if [ -z "\$SUBJECT" ]; then
  exit 0
fi

# Build content. Single blank line between subject and body is the standard
# git commit format and gives the classifier enough structure to recognize
# this as a milestone-type entry.
CONTENT="git commit in \$REPO on \$BRANCH: \$SUBJECT

\$BODY

Files (\$FILES_COUNT): \$TOP_FILES
Hash: \$HASH"

# Fire-and-forget detached background ingest.
# The double subshell + nohup + & + redirect ensures the child is fully
# detached from the current shell. \`git commit\` returns the instant this
# block exits, and the classifier/ingest runs without blocking the user.
if [ -n "\$INGEST_BIN" ]; then
  (
    nohup "\$INGEST_BIN" \\
      --content "\$CONTENT" \\
      --turn system \\
      --source git-commit \\
      --project "\$REPO" \\
      --session-id "git-\$REPO" \\
      --verbose \\
      >> "${logFile}" 2>&1 &
  ) > /dev/null 2>&1
else
  (
    nohup node "\$INGEST_FALLBACK" \\
      --content "\$CONTENT" \\
      --turn system \\
      --source git-commit \\
      --project "\$REPO" \\
      --session-id "git-\$REPO" \\
      --verbose \\
      >> "${logFile}" 2>&1 &
  ) > /dev/null 2>&1
fi

# Chain to repo-local hook if the repo provides one at
#   .git/hooks/post-commit-local
# Global core.hooksPath means the repo's own hooks/post-commit is not
# automatically called. This convention lets a repo opt in to its own
# post-commit behavior alongside the engram ingestion.
LOCAL_HOOK="\$GIT_DIR/hooks/post-commit-local"
if [ -x "\$LOCAL_HOOK" ]; then
  "\$LOCAL_HOOK" "\$@" 2>/dev/null || true
fi

exit 0
`
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInstall(dryRun: boolean): void {
  if (!existsSync(INGEST_CLI)) {
    process.stderr.write(
      `[engram-git-setup] warning: engram-ingest CLI not found at ${INGEST_CLI}\n`,
    )
    process.stderr.write(
      `[engram-git-setup] the hook will still be installed but will no-op until the mcp package is built\n`,
    )
  }

  const script = buildPostCommitScript(INGEST_CLI, ENV_FILE, LOG_FILE)

  if (dryRun) {
    process.stdout.write(`[dry-run] would create: ${HOOK_DIR}\n`)
    process.stdout.write(`[dry-run] would write hook to: ${HOOK_PATH}\n`)
    process.stdout.write(`[dry-run] would chmod +x ${HOOK_PATH}\n`)
    process.stdout.write(`[dry-run] would run: git config --global core.hooksPath ${HOOK_DIR}\n`)
    process.stdout.write('\n--- hook script ---\n')
    process.stdout.write(script)
    return
  }

  // 1. Create hook directory
  mkdirSync(HOOK_DIR, { recursive: true })

  // 2. Write hook script
  writeFileSync(HOOK_PATH, script, 'utf-8')
  chmodSync(HOOK_PATH, 0o755)
  process.stdout.write(`wrote ${HOOK_PATH}\n`)

  // 3. Set core.hooksPath globally. Check current value first so we can
  //    warn if we're about to overwrite a pre-existing setup.
  let existing = ''
  try {
    existing = execSync('git config --global --get core.hooksPath', { encoding: 'utf-8' }).trim()
  } catch {
    // not set — that's fine
  }
  if (existing && existing !== HOOK_DIR) {
    process.stderr.write(
      `\n[engram-git-setup] WARNING: core.hooksPath was already set to:\n  ${existing}\n`,
    )
    process.stderr.write(
      `[engram-git-setup] overwriting to ${HOOK_DIR}. Previous hooks in that directory will no longer run.\n`,
    )
    process.stderr.write(
      `[engram-git-setup] if you need to preserve them, move them into ${HOOK_DIR} or revert with 'engram-git-setup uninstall'.\n\n`,
    )
  }
  execSync(`git config --global core.hooksPath ${shellEscape(HOOK_DIR)}`, { stdio: 'inherit' })
  process.stdout.write(`set git config --global core.hooksPath ${HOOK_DIR}\n`)

  // 4. Ensure log file exists and is writable
  try {
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    appendFileSync(LOG_FILE, '')
  } catch {
    // non-fatal
  }

  process.stdout.write('\n')
  process.stdout.write('Installed. Every git commit on this machine now flows through the Engram\n')
  process.stdout.write('salience gate. Inspect recent runs with:\n')
  process.stdout.write(`  tail -f ${LOG_FILE}\n`)
  process.stdout.write('\n')
  process.stdout.write('To skip the hook on a single commit:\n')
  process.stdout.write('  ENGRAM_SALIENCE_DISABLED=1 git commit -m "..."\n')
  process.stdout.write('\n')
  process.stdout.write('To uninstall:\n')
  process.stdout.write('  engram-git-setup uninstall\n')
}

function cmdUninstall(): void {
  try {
    const current = execSync('git config --global --get core.hooksPath', {
      encoding: 'utf-8',
    }).trim()
    if (current === HOOK_DIR) {
      execSync('git config --global --unset core.hooksPath', { stdio: 'inherit' })
      process.stdout.write('unset git config --global core.hooksPath\n')
    } else if (current) {
      process.stdout.write(
        `core.hooksPath is ${current}, not managed by engram-git-setup. Leaving alone.\n`,
      )
    } else {
      process.stdout.write('core.hooksPath was already unset\n')
    }
  } catch {
    process.stdout.write('core.hooksPath was not set\n')
  }
  process.stdout.write(`\nHook file left in place at ${HOOK_PATH} in case you want to reuse it.\n`)
  process.stdout.write('Delete it manually if you want a full cleanup.\n')
}

function cmdStatus(): void {
  process.stdout.write('engram-git-setup status\n\n')

  process.stdout.write(`hook dir:    ${HOOK_DIR}\n`)
  process.stdout.write(`hook file:   ${HOOK_PATH} ${existsSync(HOOK_PATH) ? '(exists)' : '(MISSING)'}\n`)
  process.stdout.write(`ingest CLI:  ${INGEST_CLI} ${existsSync(INGEST_CLI) ? '(exists)' : '(MISSING)'}\n`)
  process.stdout.write(`env file:    ${ENV_FILE} ${existsSync(ENV_FILE) ? '(exists)' : '(MISSING)'}\n`)
  process.stdout.write(`log file:    ${LOG_FILE} ${existsSync(LOG_FILE) ? '(exists)' : '(empty)'}\n`)

  try {
    const current = execSync('git config --global --get core.hooksPath', {
      encoding: 'utf-8',
    }).trim()
    process.stdout.write(`core.hooksPath (global): ${current}\n`)
    if (current === HOOK_DIR) {
      process.stdout.write('=> engram git hooks are ACTIVE for all new commits\n')
    } else if (current) {
      process.stdout.write('=> a different hooks path is active; engram hook is INACTIVE\n')
    }
  } catch {
    process.stdout.write('core.hooksPath (global): <unset>\n')
    process.stdout.write('=> engram git hooks are INACTIVE (install to activate)\n')
  }
}

function shellEscape(s: string): string {
  // Simple escape for paths passed to sh. Paths in a user home directory
  // shouldn't contain adversarial characters, but cheap defense is free.
  return `'${s.replace(/'/g, "'\\''")}'`
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'status'

switch (cmd) {
  case 'install':
    cmdInstall(dryRun)
    break
  case 'uninstall':
    cmdUninstall()
    break
  case 'status':
    cmdStatus()
    break
  default:
    process.stderr.write(`unknown command: ${cmd}\n`)
    process.stderr.write('usage: engram-git-setup [install|uninstall|status] [--dry-run]\n')
    process.exit(1)
}
