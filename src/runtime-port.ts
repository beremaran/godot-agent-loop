/**
 * Shared runtime-port contract for the MCP server and its harnesses.
 *
 * Both ends of the loopback runtime connection (the TypeScript server and the
 * GDScript interaction autoload) inherit `GODOT_MCP_RUNTIME_PORT`. When the
 * variable is unset the product default applies; when it is explicitly
 * supplied it must be a valid TCP port. Harnesses allocate one isolated free
 * port per run and propagate that single value to every child process so
 * parallel runs never share the literal default.
 */

export const DEFAULT_RUNTIME_PORT = 9090;
export const MIN_RUNTIME_PORT = 1;
export const MAX_RUNTIME_PORT = 65535;
export const RUNTIME_PORT_ENVIRONMENT_VARIABLE = 'GODOT_MCP_RUNTIME_PORT';

/** True for an integer TCP port in the range 1-65535. */
export function isValidRuntimePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_RUNTIME_PORT && port <= MAX_RUNTIME_PORT;
}

/**
 * Parse an explicitly supplied port value. Returns undefined when no override
 * was supplied (undefined or empty). Throws a diagnostic error when the value
 * is present but not a valid port so callers can reject it before spawning
 * any process.
 */
export function parseExplicitRuntimePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!isValidRuntimePort(parsed)) {
    throw new Error(
      `Invalid ${RUNTIME_PORT_ENVIRONMENT_VARIABLE}=${raw}; expected an integer port ${MIN_RUNTIME_PORT}-${MAX_RUNTIME_PORT}`,
    );
  }
  return parsed;
}

/**
 * Select the single port for one run: a validated explicit override wins,
 * otherwise the freshly allocated free port is used.
 */
export function selectRuntimePort(explicitRaw: string | undefined, allocatedPort: number): number {
  return parseExplicitRuntimePort(explicitRaw) ?? allocatedPort;
}
