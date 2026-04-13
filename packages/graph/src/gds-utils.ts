/**
 * GDS projection lifecycle utilities.
 *
 * GDS projections persist in memory until explicitly dropped. If a prior
 * run crashed mid-consolidation, a stale projection may block the next
 * run. These helpers handle the drop-if-exists + project + algorithm +
 * drop lifecycle in a single call.
 */

import type { NeuralGraph } from './neural-graph.js'

/**
 * Run a GDS algorithm with automatic projection cleanup.
 *
 * 1. Drop stale projection if it exists (handles crash recovery)
 * 2. Create the projection
 * 3. Run the algorithm
 * 4. Drop the projection to free memory
 *
 * Returns the algorithm result. Throws if any step fails after retry.
 */
export async function runWithProjectionCleanup(
  graph: NeuralGraph,
  projectionName: string,
  projectQuery: string,
  projectParams: Record<string, unknown> | undefined,
  algorithmQuery: string,
  algorithmParams?: Record<string, unknown>,
): Promise<unknown> {
  // Step 1: Drop stale projection if it exists
  try {
    await graph.runCypher(
      `CALL gds.graph.drop($name, false)`,
      { name: projectionName },
    )
  } catch {
    // Projection didn't exist — expected path
  }

  // Step 2: Create projection
  try {
    await graph.runCypher(projectQuery, projectParams)
  } catch (err: unknown) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('already exists')) {
      // Race condition: another process created it between our drop and project
      await graph.runCypher(`CALL gds.graph.drop($name, false)`, { name: projectionName })
      await graph.runCypher(projectQuery, projectParams)
    } else {
      throw err
    }
  }

  // Step 3: Run algorithm
  let result: unknown
  try {
    result = await graph.runCypher(algorithmQuery, algorithmParams)
  } finally {
    // Step 4: Always drop projection to free memory
    try {
      await graph.runCypher(`CALL gds.graph.drop($name, false)`, { name: projectionName })
    } catch {
      // Best effort cleanup
    }
  }

  return result
}
