// @test-kind: unit
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from './e2e/helpers/harness.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => {
    resolve();
  }))));
});

describe('authoring session client startup', () => {
  it('does not reconnect after an established socket resets', async () => {
    let connections = 0;
    const server = createServer(socket => {
      connections += 1;
      // Receiving the handshake proves the client's connect event has fired;
      // only then reset the established socket to exercise operational errors.
      socket.once('data', () => socket.resetAndDestroy());
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') throw new Error('Expected a TCP address');

    const child = spawn(process.execPath, [
      join(repoRoot, 'tests/godot/authoring-session-client.mjs'),
      String(address.port),
      'test-secret',
    ], { stdio: 'ignore' });
    const exitCode = await new Promise<number | null>(resolve => child.once('exit', resolve));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(exitCode).not.toBe(0);
    expect(connections).toBe(1);
  });
});
