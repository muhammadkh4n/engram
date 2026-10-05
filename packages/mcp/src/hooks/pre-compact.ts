#!/usr/bin/env node
/**
 * Claude Code PreCompact hook.
 *
 * Fires before a compaction. The worker spools the transcript's closed turns
 * and a `pre_compact` event, then drains. Nothing is printed, so the
 * compaction never waits on capture.
 */

import { isEntryPoint } from '../ingest/entry-point.js'
import { runHookEntry } from './hook-entry.js'

if (isEntryPoint(import.meta.url)) runHookEntry('pre-compact')
