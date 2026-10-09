#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook.
 *
 * Fires before the assistant reads a prompt. The worker only drains the
 * spool: the prompt itself reaches the spool from the transcript, read by the
 * next Stop, PreCompact or SessionEnd.
 */

import { isEntryPoint } from '../ingest/entry-point.js'
import { runHookEntry } from './hook-entry.js'

if (isEntryPoint(import.meta.url)) runHookEntry('drain')
