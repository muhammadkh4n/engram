#!/usr/bin/env node
/**
 * Claude Code Stop hook.
 *
 * Fires when the assistant finishes a turn. The worker spools the transcript's
 * closed turns, then drains the spool. A Stop fired while a Stop hook is
 * already active starts nothing.
 */

import { isEntryPoint } from '../ingest/entry-point.js'
import { runHookEntry } from './hook-entry.js'

if (isEntryPoint(import.meta.url)) runHookEntry('stop')
