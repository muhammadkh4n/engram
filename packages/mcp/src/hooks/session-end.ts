#!/usr/bin/env node
/**
 * Claude Code SessionEnd hook.
 *
 * Fires when a session ends. The worker spools the transcript, closing the
 * turn still open, writes a `session_end` event, then drains.
 */

import { isEntryPoint } from '../ingest/entry-point.js'
import { runHookEntry } from './hook-entry.js'

if (isEntryPoint(import.meta.url)) runHookEntry('session-end')
