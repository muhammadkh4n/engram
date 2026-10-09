#!/usr/bin/env node
/**
 * Claude Code SessionStart hook.
 *
 * Fires when a session starts or resumes. The worker writes a `session_start`
 * event, then catches up the sessions that ended without a SessionEnd, then
 * drains.
 */

import { isEntryPoint } from '../ingest/entry-point.js'
import { runHookEntry } from './hook-entry.js'

if (isEntryPoint(import.meta.url)) runHookEntry('session-start')
