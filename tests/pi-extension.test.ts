// @test-kind: unit
import { afterEach, describe, expect, it } from 'vitest';

import { resolvePiServerLaunch } from '../agent-plugin/pi/extension.js';

const localServerEntry = '/package/build/index.js';
const originalExecPath = process.execPath;

afterEach(() => {
  process.execPath = originalExecPath;
});

describe('Pi MCP server launch', () => {
  it('uses the local build when the host executable is Node', () => {
    const launch = resolvePiServerLaunch({
      localServerEntry,
      exists: () => true,
    });

    expect(launch.command).toBe(originalExecPath);
    expect(launch.args).toEqual([localServerEntry]);
  });

  it('uses the pinned package command when the host executable is pi', () => {
    process.execPath = '/opt/pi-coding-agent/pi';

    const launch = resolvePiServerLaunch({
      localServerEntry,
      exists: () => true,
    });

    expect(launch).toMatchObject({
      command: 'npx',
      args: ['-y', '@beremaran/godot-agent-loop@3.0.0'],
    });
  });
});
