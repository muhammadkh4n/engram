#!/usr/bin/env node
/**
 * engram-git-setup — install/uninstall/status the global git post-commit
 * hook that captures every commit as a raw event (full sha, verbatim
 * message, files touched) for the Engram capture route.
 *
 * The hook is installed at ~/.engram/git-hooks/post-commit and activated
 * globally via `git config --global core.hooksPath ~/.engram/git-hooks`.
 * This means every git commit in every repo on this machine will fire
 * the hook unless --hooks-path is overridden per-repo or the hook bails
 * out (missing build, rebase in progress, etc).
 *
 * The hook is conservative:
 *   - exits 0 unconditionally on any failure path
 *   - skips during rebase / cherry-pick to avoid transient noise
 *   - runs engram-capture-commit fully detached so `git commit` returns fast
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
import { isEntryPoint } from './ingest/entry-point.js'
import { ensurePrivateDir } from './ingest/private-files.js'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Derive the dist path of the commit capture from this file's location.
// When installed, this script lives at
//   packages/mcp/dist/git-setup-cli.js
// and the entry the hook runs lives at
//   packages/mcp/dist/hooks/git-commit.js
const thisFile = fileURLToPath(import.meta.url)
const thisDir = dirname(thisFile)
const COMMIT_ENTRY = resolve(thisDir, 'hooks', 'git-commit.js')

const ENGRAM_DIR = join(homedir(), '.engram')
const HOOK_DIR = join(ENGRAM_DIR, 'git-hooks')
const HOOK_PATH = join(HOOK_DIR, 'post-commit')
const LOG_FILE = join(ENGRAM_DIR, 'git-hook.log')

// ---------------------------------------------------------------------------
// Hook template
// ---------------------------------------------------------------------------

/**
 * Build the post-commit script as a POSIX sh source string.
 *
 * The hook runs `engram-capture-commit` from PATH (the bin of an installed
 * @engram-mem/mcp), else `node <commitEntry>` (the dist path baked in at
 * install time), detached in the background. The capture reads the commit
 * itself from the working directory and its configuration from the
 * environment, so the script passes nothing but the working directory.
 */
export function buildPostCommitScript(commitEntry: string, logFile: string): string {
  return `#!/bin/sh
# Engram global git post-commit hook
# Installed by engram-git-setup. Never let this hook fail the commit —
# exit 0 is the default on every path. Reinstall with engram-git-setup.

# Resolve the commit capture. Prefer the PATH-installed bin, fall back to the
# dist entry baked in at install time.
CAPTURE_BIN="\$(command -v engram-capture-commit 2>/dev/null)"
CAPTURE_FALLBACK="${commitEntry}"
if [ -z "\$CAPTURE_BIN" ] && [ ! -f "\$CAPTURE_FALLBACK" ]; then
  CAPTURE_FALLBACK=""
fi

GIT_DIR=\$(git rev-parse --git-dir 2>/dev/null)
if [ -z "\$GIT_DIR" ]; then
  exit 0
fi

# Skip during rebase / cherry-pick / interactive rewrites. These fire
# commits rapidly in a transient state that will be squashed, reordered,
# or discarded.
if [ -f "\$GIT_DIR/rebase-merge/interactive" ] || \\
   [ -d "\$GIT_DIR/rebase-merge" ] || \\
   [ -d "\$GIT_DIR/rebase-apply" ] || \\
   [ -f "\$GIT_DIR/CHERRY_PICK_HEAD" ]; then
  exit 0
fi

# Fire-and-forget: the double subshell + nohup + & detach the capture from
# this shell, so \`git commit\` returns as soon as this block exits.
if [ -n "\$CAPTURE_BIN" ]; then
  (
    nohup "\$CAPTURE_BIN" >> "${logFile}" 2>&1 < /dev/null &
  ) > /dev/null 2>&1
elif [ -n "\$CAPTURE_FALLBACK" ]; then
  (
    nohup node "\$CAPTURE_FALLBACK" >> "${logFile}" 2>&1 < /dev/null &
  ) > /dev/null 2>&1
fi

# Chain to repo-local hook if the repo provides one at
#   .git/hooks/post-commit-local
# Global core.hooksPath means the repo's own hooks/post-commit is not
# automatically called. This convention lets a repo opt in to its own
# post-commit behavior alongside the engram capture.
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
  if (!existsSync(COMMIT_ENTRY)) {
    process.stderr.write(
      `[engram-git-setup] warning: commit capture not found at ${COMMIT_ENTRY}\n`,
    )
    process.stderr.write(
      `[engram-git-setup] the hook will still be installed but will no-op until the mcp package is built\n`,
    )
  }

  const script = buildPostCommitScript(COMMIT_ENTRY, LOG_FILE)

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
  ensurePrivateDir(ENGRAM_DIR)
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
  process.stdout.write('Installed. Every git commit on this machine is now captured for Engram.\n')
  process.stdout.write('Inspect recent runs with:\n')
  process.stdout.write(`  tail -f ${LOG_FILE}\n`)
  process.stdout.write('\n')
  process.stdout.write('To skip the hook on a single commit:\n')
  process.stdout.write('  git -c core.hooksPath=/dev/null commit -m "..."\n')
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
  process.stdout.write(`capture:     ${COMMIT_ENTRY} ${existsSync(COMMIT_ENTRY) ? '(exists)' : '(MISSING)'}\n`)
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

function main(argv: string[]): void {
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
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2))
}
