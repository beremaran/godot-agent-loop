import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import {
  assertNoLeakedGodotProcesses,
  killGodotProcesses,
  startServer,
  writeFixtureProject,
  type E2EServer,
  type StartServerOptions,
} from './harness.js';
import { e2eMetrics } from './e2e-metrics.js';

/**
 * Scoped shared-server fixture: one MCP server process for the whole suite,
 * with a fresh isolated subproject inside the server's allowed root for every
 * test case. This removes the per-test Node process spawn, MCP handshake,
 * runtime-port allocation, and teardown costs while keeping project-state
 * isolation as strong as a per-test server:
 *
 * - each case starts from the pristine fixture project in its own subproject,
 *   so no test can observe files or settings a prior test left behind;
 * - after each case the engine is stopped through stop_project, any lingering
 *   authoring session is force-dropped, a process-leak gate proves no Godot
 *   process survived, and only then is the subproject removed;
 * - the suite-level afterAll closes the server, which stops every child
 *   process, and runs the full root-wide leak assertion.
 *
 * Suites that intentionally exercise crash injection, editor attachment,
 * process ownership, concurrent projects, or renderer-specific cleanup keep
 * per-test startServer() calls instead.
 */

export interface SharedServerScope {
  /** The long-lived MCP server shared by the whole suite. */
  readonly server: E2EServer;
  /**
   * The current test case's isolated project. Replaced before each test, so
   * read it inside the test (or via call/waitForGameConnection helpers), never
   * at module scope.
   */
  readonly project: { root: string; projectPath: string };
  /** Tool-call helper bound to the shared server. */
  call(name: string, args?: Record<string, unknown>): Promise<{
    text: string; isError: boolean; raw: unknown;
  }>;
  /** Poll a runtime-backed tool until the game connection for this case is live. */
  waitForGameConnection(): Promise<void>;
}

export function useSharedServer(options: StartServerOptions = {}): SharedServerScope {
  let server: E2EServer | null = null;
  const current: { root: string; projectPath: string } = { root: '', projectPath: '' };

  beforeAll(async () => {
    server = await startServer(options);
  });

  beforeEach(() => {
    const scope = server;
    if (!scope) throw new Error('useSharedServer: server was not started by beforeAll');
    const root = mkdtempSync(join(scope.root, 'case-'));
    const projectPath = join(root, 'project');
    mkdirSync(projectPath, { recursive: true });
    writeFixtureProject(projectPath);
    e2eMetrics.projectsCreated += 1;
    current.root = root;
    current.projectPath = projectPath;
  });

  afterEach(async () => {
    const scope = server;
    if (!scope || !current.root) return;
    const root = current.root;
    current.root = '';
    current.projectPath = '';
    // A prior case may have left the engine running (config and runtime suites
    // verify through a live game): stop it gracefully before touching the tree.
    try {
      await scope.call('stop_project');
    } catch {
      // The engine may already be stopped; cleanup continues either way.
    }
    // Drop any lingering authoring session for the discarded project, then
    // prove no Godot process survived before removing the directory.
    await killGodotProcesses(root);
    await assertNoLeakedGodotProcesses(root);
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await server?.close();
  });

  return {
    get server(): E2EServer {
      if (!server) throw new Error('useSharedServer: server accessed before beforeAll completed');
      return server;
    },
    get project(): { root: string; projectPath: string } {
      if (!current.root) throw new Error('useSharedServer: project accessed outside a test case');
      return current;
    },
    call(name, args) {
      const scope = this.server;
      return scope.call(name, args);
    },
    waitForGameConnection() {
      return this.server.waitForGameConnection();
    },
  };
}
