export const AUTHORING_MODE_ENV = 'GODOT_MCP_AUTHORING_MODE';

export type AuthoringMode = 'persistent' | 'headless';

export function resolveAuthoringMode(value = process.env[AUTHORING_MODE_ENV]): AuthoringMode {
  if (value === undefined || value === '' || value === 'persistent') return 'persistent';
  if (value === 'headless') return 'headless';
  throw new Error(`Unknown ${AUTHORING_MODE_ENV} value: ${value}. Expected persistent or headless.`);
}
