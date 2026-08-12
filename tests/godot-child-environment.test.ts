// @test-kind: unit
import { describe, expect, it } from 'vitest';

import {
  buildSanitizedGodotCliEnvironment,
  buildSanitizedGodotEnvironment,
  GODOT_MCP_CHILD_ENV_ALLOW,
  GODOT_MCP_RUNTIME_DISABLED,
} from '../src/godot-child-environment.js';

const LEAK_VARIABLE = 'GODOT_MCP_TEST_SHOULD_NOT_LEAK';
const OPT_IN_VARIABLE = 'GODOT_MCP_TEST_OPT_IN';

function withEnvironment(entries: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env requires literal deletion; assignment stringifies undefined.
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env requires literal deletion; assignment stringifies undefined.
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('buildSanitizedGodotEnvironment', () => {
  it('forwards only allowlisted variables plus explicit extras by default', () => {
    withEnvironment({ [LEAK_VARIABLE]: 'top-secret' }, () => {
      const env = buildSanitizedGodotEnvironment({ GODOT_MCP_RUNTIME_SECRET: 'child-only' });
      expect(env[LEAK_VARIABLE]).toBeUndefined();
      expect(env.GODOT_MCP_RUNTIME_SECRET).toBe('child-only');
      expect(env.PATH).toBe(process.env.PATH);
      if (process.env.HOME !== undefined) expect(env.HOME).toBe(process.env.HOME);
    });
  });

  it('forwards documented opt-in variables without forwarding everything', () => {
    withEnvironment({
      [GODOT_MCP_CHILD_ENV_ALLOW]: OPT_IN_VARIABLE,
      [OPT_IN_VARIABLE]: '/run/user/1000/agent.sock',
      [LEAK_VARIABLE]: 'top-secret',
    }, () => {
      const env = buildSanitizedGodotEnvironment();
      expect(env[OPT_IN_VARIABLE]).toBe('/run/user/1000/agent.sock');
      expect(env[LEAK_VARIABLE]).toBeUndefined();
    });
  });

  it('lets explicit extras override allowlisted variables', () => {
    withEnvironment({}, () => {
      const env = buildSanitizedGodotEnvironment({ PATH: '/custom/bin' });
      expect(env.PATH).toBe('/custom/bin');
    });
  });
});

describe('buildSanitizedGodotCliEnvironment', () => {
  it('disables the runtime transport and forwards nothing beyond the allowlist', () => {
    withEnvironment({ [LEAK_VARIABLE]: 'top-secret' }, () => {
      const env = buildSanitizedGodotCliEnvironment();
      expect(env[GODOT_MCP_RUNTIME_DISABLED]).toBe('true');
      expect(env[LEAK_VARIABLE]).toBeUndefined();
    });
  });

  it('keeps opt-in and explicit variables for CLI runs', () => {
    withEnvironment({
      [GODOT_MCP_CHILD_ENV_ALLOW]: OPT_IN_VARIABLE,
      [OPT_IN_VARIABLE]: '/run/user/1000/agent.sock',
    }, () => {
      const env = buildSanitizedGodotCliEnvironment({ GODOT_MCP_RUNTIME_SECRET: 'not-needed-here' });
      expect(env[GODOT_MCP_RUNTIME_DISABLED]).toBe('true');
      expect(env.GODOT_MCP_RUNTIME_SECRET).toBe('not-needed-here');
      expect(env[OPT_IN_VARIABLE]).toBe('/run/user/1000/agent.sock');
    });
  });
});
