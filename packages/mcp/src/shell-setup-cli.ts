#!/usr/bin/env node
/**
 * engram-shell-setup — install/uninstall/status the zsh preexec hook that
 * captures notable shell commands into Engram memory.
 *
 * Unlike git commits (every commit is intentional) and Claude Code turns
 * (every prompt is conversational signal), most shell commands are pure
 * noise: `ls`, `cd`, `pwd`, `cat`, `grep` etc. Running every command
 * through an LLM classifier would be expensive and pointless.
 *
 * This hook does TWO stages of gating:
 *
 *   Stage 1: pure-regex upstream gate. A small allow-list of command
 *   prefixes / patterns that are *candidates* for memory-worthy status.
 *   Everything else gets dropped instantly with zero cost. Typical
 *   shell usage has >95% of commands silently skipped here.
 *
 *   Stage 2: the classifier runs only on candidates. It asks the LLM
 *   "is this shell command worth remembering?" and filters to the
 *   actually-important ones (deployments, production changes,
 *   destructive ops, significant one-shot scripts).
 *
 * Usage:
 *   engram-shell-setup install     # write preexec snippet + source line
 *   engram-shell-setup uninstall   # remove source line from .zshrc
 *   engram-shell-setup status      # show current state
 */

import { execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const thisFile = fileURLToPath(import.meta.url)
const thisDir = dirname(thisFile)
const INGEST_CLI = resolve(thisDir, 'ingest', 'engram-ingest-cli.js')

const ENGRAM_DIR = join(homedir(), '.engram')
const SHELL_SCRIPT_DIR = join(ENGRAM_DIR, 'shell')
const PREEXEC_SCRIPT_PATH = join(SHELL_SCRIPT_DIR, 'preexec.sh')
const LOG_FILE = join(ENGRAM_DIR, 'shell-hook.log')
const ENV_FILE = join(ENGRAM_DIR, 'env')
const ZSHRC = join(homedir(), '.zshrc')
const SOURCE_LINE = `[ -f ${PREEXEC_SCRIPT_PATH} ] && source ${PREEXEC_SCRIPT_PATH}  # engram shell hook`

// ---------------------------------------------------------------------------
// Shell preexec script builder
// ---------------------------------------------------------------------------

function buildPreexecScript(ingestCli: string, envFile: string, logFile: string): string {
  return `#!/bin/zsh
# Engram zsh preexec hook — installed by engram-shell-setup.
# Safe to source from .zshrc; does nothing if engram-ingest is unavailable.

# Load engram env once per shell
if [ -f "${envFile}" ] && [ -z "\$ENGRAM_ENV_LOADED" ]; then
  . "${envFile}" 2>/dev/null
  export ENGRAM_ENV_LOADED=1
fi

# Stage 1 gate: regex-based upstream filter. Returns 0 if the command
# is a candidate for memory, 1 otherwise. Runs in the shell, zero cost.
_engram_should_capture() {
  local cmd="\$1"
  cmd="\${cmd##[[:space:]]}"

  [ -z "\$cmd" ] && return 1
  [ \${#cmd} -lt 8 ] && return 1

  # Skip obvious noise prefixes (inspection, navigation, env mgmt)
  case "\$cmd" in
    ls|ls\\ *|ll|ll\\ *|la|la\\ *) return 1 ;;
    cd|cd\\ *|pwd|pwd\\ *) return 1 ;;
    cat\\ *|bat\\ *|less\\ *|more\\ *|head\\ *|tail\\ *) return 1 ;;
    grep\\ *|rg\\ *|ag\\ *|fgrep\\ *|egrep\\ *) return 1 ;;
    find\\ *|fd\\ *|locate\\ *) return 1 ;;
    which\\ *|whereis\\ *|type\\ *|command\\ *) return 1 ;;
    man\\ *|tldr\\ *|help\\ *|info\\ *) return 1 ;;
    echo\\ *|printf\\ *|env|env\\ *|export\\ *|unset\\ *) return 1 ;;
    history|history\\ *|clear|reset) return 1 ;;
    exit|exit\\ *|logout|quit) return 1 ;;
    source\\ *|.\\ *) return 1 ;;
    alias|alias\\ *|unalias\\ *) return 1 ;;
    vim\\ *|vi\\ *|nano\\ *|emacs\\ *|code\\ *|subl\\ *|nvim\\ *) return 1 ;;
    brew\\ list*|brew\\ info*|brew\\ search*) return 1 ;;
    npm\\ list*|npm\\ ls*|npm\\ view*|npm\\ search*) return 1 ;;
    git\\ status*|git\\ log*|git\\ diff*|git\\ show*|git\\ branch*|git\\ blame*) return 1 ;;
    git\\ fetch*|git\\ stash\\ list*|git\\ remote*|git\\ config*) return 1 ;;
    docker\\ ps*|docker\\ images*|docker\\ logs*|docker\\ inspect*) return 1 ;;
    kubectl\\ get*|kubectl\\ describe*|kubectl\\ logs*) return 1 ;;
    # Avoid recursive capture of engram CLI itself
    engram-*|*engram-ingest*) return 1 ;;
  esac

  # Stage 1 positive signals: memory-worthy candidates
  case "\$cmd" in
    *deploy*|*release*|*publish*|*push\\ --force*) return 0 ;;
    *rm\\ -rf*|*rm\\ --force*|*drop\\ table*|*DROP\\ TABLE*) return 0 ;;
    npm\\ install*|npm\\ i\\ *|npm\\ uninstall*|npm\\ remove*) return 0 ;;
    npm\\ run\\ *|npm\\ test*|npm\\ publish*) return 0 ;;
    pnpm\\ install*|pnpm\\ add*|pnpm\\ remove*|pnpm\\ publish*) return 0 ;;
    yarn\\ add*|yarn\\ remove*|yarn\\ install*) return 0 ;;
    brew\\ install*|brew\\ uninstall*|brew\\ upgrade*) return 0 ;;
    pip\\ install*|pip\\ uninstall*) return 0 ;;
    git\\ commit*|git\\ push*|git\\ merge*|git\\ rebase*|git\\ reset*) return 0 ;;
    git\\ checkout\\ -b*|git\\ tag*|git\\ cherry-pick*|git\\ revert*) return 0 ;;
    git\\ clone*|git\\ init*) return 0 ;;
    gh\\ pr\\ *|gh\\ issue\\ *|gh\\ release\\ *|gh\\ repo\\ create*) return 0 ;;
    curl\\ *-X\\ POST*|curl\\ *-X\\ DELETE*|curl\\ *-X\\ PUT*) return 0 ;;
    curl\\ *prod*|curl\\ *production*) return 0 ;;
    docker\\ build*|docker\\ run*|docker\\ exec*|docker\\ compose\\ up*) return 0 ;;
    docker\\ compose\\ down*|docker\\ stop*|docker\\ kill*|docker\\ rm*) return 0 ;;
    terraform\\ apply*|terraform\\ destroy*|terraform\\ plan*) return 0 ;;
    kubectl\\ apply*|kubectl\\ delete*|kubectl\\ rollout*) return 0 ;;
    psql\\ *|mysql\\ *|mongosh\\ *|redis-cli\\ *) return 0 ;;
    ssh\\ *) return 0 ;;
  esac

  # Default: skip. Err toward silence — false positives on shell commands
  # pollute the memory store with grep/ls noise that degrades retrieval
  # forever, while false negatives can be re-ingested by hand.
  return 1
}

engram_preexec() {
  local cmd="\$1"

  [ "\$ENGRAM_SALIENCE_DISABLED" = "1" ] && return
  _engram_should_capture "\$cmd" || return

  # Resolve engram-ingest via PATH first, fall back to workspace dist.
  local ingest_bin
  ingest_bin=\$(command -v engram-ingest 2>/dev/null)
  if [ -z "\$ingest_bin" ]; then
    if [ -f "${ingestCli}" ]; then
      ingest_bin="node ${ingestCli}"
    else
      return
    fi
  fi

  # Detect project from cwd (walk up to first .git ancestor)
  local proj="shell"
  local dir="\$PWD"
  local i=0
  while [ \$i -lt 20 ]; do
    if [ -d "\$dir/.git" ] || [ -f "\$dir/.git" ]; then
      proj=\$(basename "\$dir")
      break
    fi
    local parent=\$(dirname "\$dir")
    [ "\$parent" = "\$dir" ] && break
    dir="\$parent"
    i=\$((i + 1))
  done
  [ "\$proj" = "shell" ] && proj=\$(basename "\$PWD")

  # Declarative phrasing so the content reads as a captured action, not
  # a machine tool-call transcript. Classifier is bypassed with --raw
  # below anyway; this also makes the stored memory more readable.
  local content="MK ran this shell command in the \$proj project at \$PWD:
\$cmd"

  # --raw: bypass the classifier. The Stage 1 regex gate above already
  # did the filtering work — the classifier was rejecting candidates as
  # "tool call announcement" because shell command format is closer to
  # machine output than conversational turns. Dedup still runs so we
  # don't re-ingest the same command back-to-back.
  (
    nohup \${=ingest_bin} \\
      --content "\$content" \\
      --turn system \\
      --source shell-preexec \\
      --project "\$proj" \\
      --session-id "shell-\$proj" \\
      --raw \\
      --verbose \\
      >> "${logFile}" 2>&1 &
  ) > /dev/null 2>&1
}

autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook preexec engram_preexec
`
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInstall(): void {
  if (!existsSync(INGEST_CLI)) {
    process.stderr.write(
      `[engram-shell-setup] warning: engram-ingest CLI not found at ${INGEST_CLI}\n`,
    )
    process.stderr.write(
      `[engram-shell-setup] the hook will still install but will no-op until mcp is built\n`,
    )
  }

  mkdirSync(SHELL_SCRIPT_DIR, { recursive: true })
  const script = buildPreexecScript(INGEST_CLI, ENV_FILE, LOG_FILE)
  writeFileSync(PREEXEC_SCRIPT_PATH, script, 'utf-8')
  chmodSync(PREEXEC_SCRIPT_PATH, 0o644)
  process.stdout.write(`wrote ${PREEXEC_SCRIPT_PATH}\n`)

  let zshrcContent = ''
  if (existsSync(ZSHRC)) {
    zshrcContent = readFileSync(ZSHRC, 'utf-8')
  }

  if (zshrcContent.includes('engram shell hook')) {
    process.stdout.write(`${ZSHRC} already sources the engram shell hook — skipping\n`)
  } else {
    const appended = zshrcContent.endsWith('\n') || zshrcContent === ''
      ? `${zshrcContent}\n${SOURCE_LINE}\n`
      : `${zshrcContent}\n\n${SOURCE_LINE}\n`
    writeFileSync(ZSHRC, appended, 'utf-8')
    process.stdout.write(`appended source line to ${ZSHRC}\n`)
  }

  process.stdout.write('\nInstalled. The hook takes effect in every new zsh session.\n')
  process.stdout.write('To activate in the current shell without restarting:\n')
  process.stdout.write(`  source ${PREEXEC_SCRIPT_PATH}\n`)
  process.stdout.write('\nInspect runs with:\n')
  process.stdout.write(`  tail -f ${LOG_FILE}\n`)
  process.stdout.write('\nTo skip capture for a single command:\n')
  process.stdout.write('  ENGRAM_SALIENCE_DISABLED=1 <your command>\n')
  process.stdout.write('\nTo uninstall:\n')
  process.stdout.write('  engram-shell-setup uninstall\n')
}

function cmdUninstall(): void {
  if (existsSync(ZSHRC)) {
    const content = readFileSync(ZSHRC, 'utf-8')
    const filtered = content
      .split('\n')
      .filter((line) => !line.includes('engram shell hook'))
      .join('\n')
    if (filtered !== content) {
      writeFileSync(ZSHRC, filtered, 'utf-8')
      process.stdout.write(`removed source line from ${ZSHRC}\n`)
    } else {
      process.stdout.write(`no engram shell hook line found in ${ZSHRC}\n`)
    }
  }
  process.stdout.write(`\nHook file left in place at ${PREEXEC_SCRIPT_PATH}. Delete manually for full cleanup.\n`)
  process.stdout.write('The current shell still has the hook loaded — restart zsh to fully remove.\n')
}

function cmdStatus(): void {
  process.stdout.write('engram-shell-setup status\n\n')
  process.stdout.write(`hook script: ${PREEXEC_SCRIPT_PATH} ${existsSync(PREEXEC_SCRIPT_PATH) ? '(exists)' : '(MISSING)'}\n`)
  process.stdout.write(`ingest CLI:  ${INGEST_CLI} ${existsSync(INGEST_CLI) ? '(exists)' : '(MISSING)'}\n`)
  process.stdout.write(`env file:    ${ENV_FILE} ${existsSync(ENV_FILE) ? '(exists)' : '(MISSING)'}\n`)
  process.stdout.write(`log file:    ${LOG_FILE} ${existsSync(LOG_FILE) ? '(exists)' : '(empty)'}\n`)

  if (existsSync(ZSHRC)) {
    const content = readFileSync(ZSHRC, 'utf-8')
    const sourced = content.includes('engram shell hook')
    process.stdout.write(`~/.zshrc sources hook: ${sourced ? 'yes' : 'no'}\n`)
  } else {
    process.stdout.write(`~/.zshrc: missing\n`)
  }

  try {
    const inCurrentShell = execSync(
      'zsh -i -c "typeset -f engram_preexec > /dev/null && echo yes || echo no" 2>/dev/null',
      { encoding: 'utf-8' },
    ).trim()
    process.stdout.write(`active in a new zsh: ${inCurrentShell}\n`)
  } catch {
    process.stdout.write(`active in a new zsh: unknown\n`)
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'status'

switch (cmd) {
  case 'install':
    cmdInstall()
    break
  case 'uninstall':
    cmdUninstall()
    break
  case 'status':
    cmdStatus()
    break
  default:
    process.stderr.write(`unknown command: ${cmd}\n`)
    process.stderr.write('usage: engram-shell-setup [install|uninstall|status]\n')
    process.exit(1)
}
