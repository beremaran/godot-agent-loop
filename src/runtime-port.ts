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

/** Error naming the selected runtime port when another process already owns it. */
export class RuntimePortOwnershipError extends Error {
  readonly port: number;

  constructor(port: number, detail?: string) {
    super(
      `${RUNTIME_PORT_ENVIRONMENT_VARIABLE}=${port} is already owned by another process${
        detail ? `: ${detail}` : ''
      }; terminate the owner or select a free port and retry`,
    );
    this.name = 'RuntimePortOwnershipError';
    this.port = port;
  }
}

/** True when the error reports a port-ownership collision. */
export function isRuntimePortOwnershipError(error: unknown): error is RuntimePortOwnershipError {
  return error instanceof RuntimePortOwnershipError;
}

/**
 * Scan captured Godot output for a runtime bind failure against the selected
 * port. Returns the matching line, or null when no ownership failure is
 * visible. Matches the interaction server's bind diagnostic
 * ("Failed to listen on port <port>") and generic address-in-use reports that
 * name the selected port, so the runner can fail fast instead of connecting
 * to the unrelated owner.
 */
export function findRuntimePortOwnershipFailure(output: string, port: number): string | null {
  for (const line of output.split('\n')) {
    if (new RegExp(`Failed to listen on port\\s+${port}\\b`, 'i').test(line)) return line.trim();
    if (/address already in use/i.test(line) && line.includes(String(port))) return line.trim();
    if (/EADDRINUSE/i.test(line) && line.includes(String(port))) return line.trim();
  }
  return null;
}

/**
 * Fail fast when the selected runtime port is already owned. Binds the
 * loopback port briefly: an EADDRINUSE bind proves another process owns it
 * before any Godot child is spawned. Any other bind error propagates
 * unchanged; a successful bind is released immediately (the remaining race
 * to the child's bind is covered by the startup log watcher).
 */
export async function assertRuntimePortAvailable(port: number): Promise<void> {
  const { createServer } = await import('node:net');
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: unknown) => {
      probe.close();
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE') reject(new RuntimePortOwnershipError(port));
      else reject(error instanceof Error ? error : new Error(String(error)));
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(error => {
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve();
      });
    });
  });
}

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
