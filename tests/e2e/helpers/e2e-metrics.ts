/**
 * Cross-suite startup counters for the E2E run. The harness and the shared
 * server fixture increment these as real processes are created; the custom
 * vitest reporter aggregates the per-file tallies and prints a summary with
 * wall-clock time so startup counts can be compared before/after test
 * infrastructure changes on the primary Godot CI job.
 */

export interface E2EMetrics {
  /** MCP server processes spawned through startServer(). */
  mcpServerStarts: number;
  /** Temporary project trees created for isolated cases. */
  projectsCreated: number;
  /** Successful run_project calls observed through the harness. */
  gameLaunches: number;
  /** Successful stop_project calls observed through the harness. */
  gameStops: number;
}

export const e2eMetrics: E2EMetrics = {
  mcpServerStarts: 0,
  projectsCreated: 0,
  gameLaunches: 0,
  gameStops: 0,
};
