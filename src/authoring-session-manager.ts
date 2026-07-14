import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

import { GameConnection, type GameLifecycleEvent, type GameResponse } from './game-connection.js';
import { GodotProcessManager } from './godot-process-manager.js';
import type { HeadlessOperationResult } from './headless-operation-runner.js';
import type { InteractionServerInstaller } from './interaction-server-installer.js';
import type { AuthoringSessionToolBackend } from './tool-manifest.js';
import { convertCamelToSnakeCase, errorMessage, type OperationParams } from './utils.js';
import { deterministicSessionArguments, deterministicSessionEnvironment } from './session-timing.js';
import { RENDERING_CONTEXT_CAPABILITY } from './runtime-protocol.js';

interface AuthoringConnection {
  readonly isConnected: boolean;
  supportsCapability(capability: string): boolean;
  connect(projectPath: string, isProcessActive: () => boolean): Promise<void>;
  disconnect(): void;
  send(command: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<GameResponse>;
}

interface AuthoringSessionState {
  projectPath: string;
  ownedInstallation: boolean;
  connection: AuthoringConnection;
  generation: number;
}

export interface AuthoringSessionManagerOptions {
  operationsScriptPath: string;
  resolveGodotPath: () => Promise<string>;
  installer: InteractionServerInstaller;
  logDebug?: (message: string) => void;
  canStart?: () => boolean;
  allocatePort?: () => Promise<number>;
  createConnection?: (port: number, secret: string) => AuthoringConnection;
  processManager?: GodotProcessManager;
  secretFactory?: () => string;
  onLifecycleEvent?: (event: GameLifecycleEvent) => void;
}

/** A startup-only error that is safe to route to the subprocess fallback. */
export class AuthoringSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthoringSessionUnavailableError';
  }
}

/** A headed session could not reach a real or virtual desktop renderer. */
export class RenderingContextUnavailableError extends Error {
  constructor(message = 'Headed authoring session requires a reachable rendering context. Set DISPLAY or WAYLAND_DISPLAY on Linux, or run under a virtual display such as Xvfb.') {
    super(message);
    this.name = 'RenderingContextUnavailableError';
  }
}

/** Owns one serialized, reusable authoring process for the currently edited project. */
export class AuthoringSessionManager {
  private readonly logDebug: (message: string) => void;
  private readonly processManager: GodotProcessManager;
  private current: AuthoringSessionState | null = null;
  private generation = 0;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: AuthoringSessionManagerOptions) {
    this.logDebug = options.logDebug ?? (() => undefined);
    this.processManager = options.processManager ?? new GodotProcessManager(this.logDebug);
  }

  get activeProjectPath(): string | null {
    return this.current?.projectPath ?? null;
  }

  async execute(
    backend: AuthoringSessionToolBackend,
    params: OperationParams,
    projectPath: string,
  ): Promise<HeadlessOperationResult> {
    return this.serialize(async () => {
      await this.ensureSession(projectPath);
      const state = this.current;
      if (!state?.connection.isConnected) {
        throw new AuthoringSessionUnavailableError('Authoring session did not establish its JSON-RPC connection');
      }
      try {
        const response = await state.connection.send(
          backend.command,
          convertCamelToSnakeCase(params),
          30_000,
        );
        if ('error' in response) {
          const details = response.error.data === undefined ? '' : `: ${JSON.stringify(response.error.data)}`;
          return {
            stdout: '',
            stderr: `${response.error.message}${details}`,
            exitCode: 1,
            signal: null,
          };
        }
        const result = response.result;
        if (!result || typeof result !== 'object') {
          return {
            stdout: '', stderr: 'Authoring session returned an invalid result', exitCode: 1, signal: null,
          };
        }
        const payload = result as Record<string, unknown>;
        return {
          stdout: typeof payload.stdout === 'string' ? payload.stdout : JSON.stringify(payload),
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      } catch (error: unknown) {
        // Once a request may have reached Godot, retrying it through the
        // subprocess can duplicate a partial mutation. Report the transport
        // failure and leave recovery to the caller instead.
        return {
          stdout: '',
          stderr: `Authoring session command failed: ${errorMessage(error)}`,
          exitCode: 1,
          signal: null,
        };
      }
    });
  }

  stop(): void {
    const state = this.current;
    if (!state) return;
    this.current = null;
    state.connection.disconnect();
    this.processManager.stop();
    this.options.installer.remove(state.projectPath, state.ownedInstallation);
    this.logDebug(`Stopped authoring session for ${state.projectPath}`);
  }

  private async ensureSession(projectPath: string): Promise<void> {
    if (this.current?.projectPath === projectPath
      && this.current.connection.isConnected
      && this.processManager.active) return;
    if (this.options.canStart && !this.options.canStart()) {
      throw new AuthoringSessionUnavailableError('A user-facing Godot process is active');
    }
    this.stop();

    let ownedInstallation = false;
    try {
      const executable = await this.options.resolveGodotPath();
      const port = await (this.options.allocatePort ?? allocateLoopbackPort)();
      const secret = (this.options.secretFactory ?? (() => randomBytes(32).toString('base64url')))();
      ownedInstallation = this.options.installer.install(projectPath);
      const connection = (this.options.createConnection ?? ((connectionPort, authSecret) => new GameConnection({
        port: connectionPort,
        initialDelayMs: 0,
        retryDelayMs: 50,
        maxAttempts: 200,
        authSecret,
        log: this.logDebug,
        onLifecycleEvent: this.options.onLifecycleEvent,
      })))(port, secret);
      const generation = ++this.generation;
      const state: AuthoringSessionState = { projectPath, ownedInstallation, connection, generation };
      this.current = state;
      this.processManager.start({
        executable,
        args: [
          ...deterministicSessionArguments(),
          '--path', projectPath, '--script', this.options.operationsScriptPath, '--serve-authoring',
        ],
        env: {
          ...deterministicSessionEnvironment(),
          GODOT_MCP_RUNTIME_PORT: String(port),
          GODOT_MCP_RUNTIME_SECRET: secret,
        },
        onExit: () => { this.handleProcessExit(generation); },
        onError: error => {
          this.logDebug(`Authoring session process error: ${error.message}`);
          this.handleProcessExit(generation);
        },
      });
      await connection.connect(projectPath, () => this.current === state && this.processManager.active);
      if (!connection.isConnected) {
        throw new RenderingContextUnavailableError(
          'Headed authoring session exited before its renderer became reachable. Set DISPLAY or WAYLAND_DISPLAY on Linux, or run under a virtual display such as Xvfb.',
        );
      }
      if (!connection.supportsCapability(RENDERING_CONTEXT_CAPABILITY)) {
        throw new RenderingContextUnavailableError();
      }
      this.logDebug(`Started authoring session for ${projectPath} on port ${port}`);
    } catch (error: unknown) {
      if (this.current) this.stop();
      else if (ownedInstallation) this.options.installer.remove(projectPath, true);
      if (error instanceof RenderingContextUnavailableError) throw error;
      throw new AuthoringSessionUnavailableError(`Could not start authoring session: ${errorMessage(error)}`);
    }
  }

  private handleProcessExit(generation: number): void {
    if (this.current?.generation !== generation) return;
    const state = this.current;
    this.current = null;
    state.connection.disconnect();
    this.options.installer.remove(state.projectPath, state.ownedInstallation);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Reserves an ephemeral loopback port long enough to learn its assigned number. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port'));
        return;
      }
      const port = address.port;
      server.close(error => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
