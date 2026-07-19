import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDITOR_BRIDGE_PROTOCOL_VERSION } from './editor-bridge-protocol.js';

export const PERSISTENT_EDITOR_ADDON_DIR = 'addons/godot_agent_loop';
export const TRANSIENT_EDITOR_ADDON_DIR = 'addons/godot_agent_loop_transient';
const PERSISTENT_PLUGIN_NAME = 'godot_agent_loop';
const TRANSIENT_PLUGIN_NAME = 'godot_agent_loop_transient';
const OWNERSHIP_FILE = '.godot-agent-loop-owned.json';
const OWNERSHIP_ID = 'godot-agent-loop-server';

interface OwnershipMarker {
  owner: typeof OWNERSHIP_ID;
  protocolVersion: string;
  pluginEnabledBeforeInstall: boolean;
  editorPluginsSectionExistedBeforeInstall: boolean;
  files: Record<string, string>;
}

export interface EditorPluginInstallation {
  distribution: 'persistent' | 'transient';
  pluginName: string;
  protocolVersion: string;
  owned: boolean;
  enabledByServer: boolean;
  projectBefore: string;
  projectAfter: string;
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseConfigValue(source: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(source);
  return match?.[1];
}

function enabledPlugins(source: string): string[] {
  const section = /(?:^|\n)\[editor_plugins\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(source);
  const line = section?.[1].match(/^enabled\s*=\s*PackedStringArray\((.*)\)\s*$/m);
  if (!line) return [];
  return [...line[1].matchAll(/"(?:\\.|[^"])*"/g)].map(match => JSON.parse(match[0]) as string);
}

function withEnabledPlugin(source: string, pluginName: string): { content: string; changed: boolean } {
  const plugins = enabledPlugins(source);
  if (plugins.includes(pluginName)) return { content: source, changed: false };
  plugins.push(pluginName);
  return { content: writeEnabledPlugins(source, plugins), changed: true };
}

function withoutEnabledPlugin(source: string, pluginName: string, removeEmptySection: boolean): string {
  const plugins = enabledPlugins(source);
  if (!plugins.includes(pluginName)) return source;
  const remaining = plugins.filter(name => name !== pluginName);
  if (removeEmptySection && remaining.length === 0) {
    return source.replace(/(?:^|\n)\[editor_plugins\]\s*\n[\s\S]*?(?=\n\[|$)/, '');
  }
  return writeEnabledPlugins(source, remaining);
}

function writeEnabledPlugins(source: string, plugins: string[]): string {
  const value = `enabled=PackedStringArray(${plugins.map(name => JSON.stringify(name)).join(', ')})`;
  const sectionPattern = /((?:^|\n)\[editor_plugins\]\s*\n)([\s\S]*?)(?=\n\[|$)/;
  const section = sectionPattern.exec(source);
  if (!section) return `${source.replace(/\s*$/, '')}\n\n[editor_plugins]\n\n${value}\n`;
  const body = section[2];
  const nextBody = /^enabled\s*=.*$/m.test(body)
    ? body.replace(/^enabled\s*=.*$/m, value)
    : `${body.replace(/\s*$/, '')}\n${value}\n`;
  return source.replace(sectionPattern, `${section[1]}${nextBody}`);
}

export class EditorPluginInstaller {
  constructor(private readonly scriptPath: string) {}

  install(projectPath: string): EditorPluginInstallation {
    const projectFile = join(projectPath, 'project.godot');
    const projectBefore = readFileSync(projectFile, 'utf8');
    const persistentConfig = join(projectPath, PERSISTENT_EDITOR_ADDON_DIR, 'plugin.cfg');
    const persistentBaseline = existsSync(persistentConfig)
      ? this.recoverOwnedTransient(projectPath, projectBefore)
      : projectBefore;
    const persistent = this.persistentInstallation(projectPath, persistentBaseline);
    if (persistent) return persistent;
    return this.transientInstallation(projectPath, projectBefore);
  }

  remove(projectPath: string, installation: EditorPluginInstallation | null): { filesRemoved: boolean; filesPreserved: boolean } {
    if (!installation) return { filesRemoved: false, filesPreserved: false };
    const projectFile = join(projectPath, 'project.godot');
    if (installation.enabledByServer && existsSync(projectFile)) {
      const current = readFileSync(projectFile, 'utf8');
      const restored = current === installation.projectAfter
        ? installation.projectBefore
        : withoutEnabledPlugin(
            current,
            installation.pluginName,
            !/(?:^|\n)\[editor_plugins\]\s*\n/.test(installation.projectBefore),
          );
      if (restored !== current) writeFileSync(projectFile, restored, 'utf8');
    }
    if (!installation.owned) return { filesRemoved: false, filesPreserved: true };
    const addon = join(projectPath, TRANSIENT_EDITOR_ADDON_DIR);
    if (!this.isUnmodifiedOwnedTransient(addon)) return { filesRemoved: false, filesPreserved: existsSync(addon) };
    rmSync(addon, { recursive: true });
    return { filesRemoved: true, filesPreserved: false };
  }

  private persistentInstallation(projectPath: string, projectBefore: string): EditorPluginInstallation | undefined {
    const addon = join(projectPath, PERSISTENT_EDITOR_ADDON_DIR);
    const configPath = join(addon, 'plugin.cfg');
    if (!existsSync(configPath)) return undefined;
    const config = readFileSync(configPath, 'utf8');
    const script = parseConfigValue(config, 'script');
    const protocolVersion = parseConfigValue(config, 'protocol_version');
    if (!script || !existsSync(join(addon, script))) {
      throw new Error('Godot Agent Loop persistent addon is incomplete: plugin script is missing');
    }
    if (protocolVersion !== EDITOR_BRIDGE_PROTOCOL_VERSION) {
      throw new Error(`Godot Agent Loop editor protocol is incompatible: server ${EDITOR_BRIDGE_PROTOCOL_VERSION}, addon ${protocolVersion ?? 'missing'}`);
    }
    const enabled = withEnabledPlugin(projectBefore, PERSISTENT_PLUGIN_NAME);
    if (enabled.changed) writeFileSync(join(projectPath, 'project.godot'), enabled.content, 'utf8');
    return {
      distribution: 'persistent',
      pluginName: PERSISTENT_PLUGIN_NAME,
      protocolVersion,
      owned: false,
      enabledByServer: enabled.changed,
      projectBefore,
      projectAfter: enabled.content,
    };
  }

  private recoverOwnedTransient(projectPath: string, projectSource: string): string {
    const addon = join(projectPath, TRANSIENT_EDITOR_ADDON_DIR);
    if (!existsSync(addon)) return projectSource;
    const marker = this.readUnmodifiedOwnedTransient(addon);
    if (!marker) {
      throw new Error(`Persistent addon cannot start while a user-managed path exists at ${TRANSIENT_EDITOR_ADDON_DIR}`);
    }
    const restored = marker.pluginEnabledBeforeInstall
      ? projectSource
      : withoutEnabledPlugin(
          projectSource,
          TRANSIENT_PLUGIN_NAME,
          !marker.editorPluginsSectionExistedBeforeInstall,
        );
    if (restored !== projectSource) writeFileSync(join(projectPath, 'project.godot'), restored, 'utf8');
    rmSync(addon, { recursive: true });
    return restored;
  }

  private transientInstallation(projectPath: string, projectBefore: string): EditorPluginInstallation {
    const addon = join(projectPath, TRANSIENT_EDITOR_ADDON_DIR);
    let previousMarker: OwnershipMarker | undefined;
    if (existsSync(addon)) {
      previousMarker = this.readUnmodifiedOwnedTransient(addon);
      if (!previousMarker) {
        throw new Error(`Refusing to overwrite user-managed editor addon at ${TRANSIENT_EDITOR_ADDON_DIR}`);
      }
      rmSync(addon, { recursive: true });
    }
    const pluginEnabledBeforeInstall = previousMarker?.pluginEnabledBeforeInstall
      ?? enabledPlugins(projectBefore).includes(TRANSIENT_PLUGIN_NAME);
    const editorPluginsSectionExistedBeforeInstall = previousMarker?.editorPluginsSectionExistedBeforeInstall
      ?? /(?:^|\n)\[editor_plugins\]\s*\n/.test(projectBefore);
    try {
      mkdirSync(addon, { recursive: true });
      copyFileSync(this.scriptPath, join(addon, 'plugin.gd'));
      writeFileSync(join(addon, 'plugin.cfg'), [
        '[plugin]',
        '',
        'name="Godot Agent Loop Transient Bridge"',
        'description="Session-owned authenticated editor bridge"',
        'author="Godot Agent Loop"',
        'version="1.1.3"',
        'script="plugin.gd"',
        `protocol_version="${EDITOR_BRIDGE_PROTOCOL_VERSION}"`,
        'minimum_godot_version="4.7"',
        '',
      ].join('\n'));
      const marker: OwnershipMarker = {
        owner: OWNERSHIP_ID,
        protocolVersion: EDITOR_BRIDGE_PROTOCOL_VERSION,
        pluginEnabledBeforeInstall,
        editorPluginsSectionExistedBeforeInstall,
        files: {
          'plugin.gd': hashFile(join(addon, 'plugin.gd')),
          'plugin.cfg': hashFile(join(addon, 'plugin.cfg')),
        },
      };
      writeFileSync(join(addon, OWNERSHIP_FILE), `${JSON.stringify(marker, null, 2)}\n`);
    } catch (error) {
      rmSync(addon, { recursive: true, force: true });
      throw error;
    }
    const enabled = withEnabledPlugin(projectBefore, TRANSIENT_PLUGIN_NAME);
    const cleanupBaseline = previousMarker && !pluginEnabledBeforeInstall
      ? withoutEnabledPlugin(
          projectBefore,
          TRANSIENT_PLUGIN_NAME,
          !editorPluginsSectionExistedBeforeInstall,
        )
      : projectBefore;
    try {
      if (enabled.changed) writeFileSync(join(projectPath, 'project.godot'), enabled.content, 'utf8');
    } catch (error) {
      if (this.isUnmodifiedOwnedTransient(addon)) rmSync(addon, { recursive: true });
      throw error;
    }
    return {
      distribution: 'transient',
      pluginName: TRANSIENT_PLUGIN_NAME,
      protocolVersion: EDITOR_BRIDGE_PROTOCOL_VERSION,
      owned: true,
      enabledByServer: enabled.changed || Boolean(previousMarker && !pluginEnabledBeforeInstall),
      projectBefore: cleanupBaseline,
      projectAfter: enabled.content,
    };
  }

  private isUnmodifiedOwnedTransient(addon: string): boolean {
    return this.readUnmodifiedOwnedTransient(addon) !== undefined;
  }

  private readUnmodifiedOwnedTransient(addon: string): OwnershipMarker | undefined {
    const markerPath = join(addon, OWNERSHIP_FILE);
    if (!existsSync(markerPath)) return undefined;
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as OwnershipMarker;
      if (
        marker.owner !== OWNERSHIP_ID
        || typeof marker.pluginEnabledBeforeInstall !== 'boolean'
        || typeof marker.editorPluginsSectionExistedBeforeInstall !== 'boolean'
      ) return undefined;
      return Object.entries(marker.files).every(([name, hash]) => (
        existsSync(join(addon, name)) && hashFile(join(addon, name)) === hash
      )) ? marker : undefined;
    } catch {
      return undefined;
    }
  }
}
