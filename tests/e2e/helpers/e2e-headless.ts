/**
 * True when the E2E suite was started with GODOT_MCP_HEADLESS=1, the same
 * flag that makes the MCP server spawn every owned Godot process with
 * `--headless` (the stdio transport inherits the runner's environment).
 * Rendering-dependent assertions are skipped in this mode; pixel coverage
 * stays on CI's Xvfb renderer jobs.
 */
export const e2eHeadless = process.env.GODOT_MCP_HEADLESS === '1';
