import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { DebugLogger } from './godot-executable.js';

const DEFAULT_AUTOLOAD_NAME = 'McpInteractionServer';
const DESTINATION_SCRIPT_NAME = 'mcp_interaction_server.gd';

export interface InteractionServerInstallerOptions {
  sourceScriptPath: string;
  autoloadName?: string;
  logDebug?: DebugLogger;
}

/** Owns the filesystem changes needed to expose the MCP interaction server to a project. */
export class InteractionServerInstaller {
  private readonly autoloadName: string;
  private readonly logDebug: DebugLogger;

  constructor(private readonly options: InteractionServerInstallerOptions) {
    this.autoloadName = options.autoloadName ?? DEFAULT_AUTOLOAD_NAME;
    this.logDebug = options.logDebug ?? (() => undefined);
  }

  /** Installs the server and returns whether MCP owns the resulting autoload entry. */
  install(projectPath: string): boolean {
    const projectFile = join(projectPath, 'project.godot');
    const destinationScript = join(projectPath, DESTINATION_SCRIPT_NAME);
    const existingContent = readFileSync(projectFile, 'utf8');

    if (existingContent.includes(this.autoloadName)) {
      if (!existsSync(destinationScript)) {
        copyFileSync(this.options.sourceScriptPath, destinationScript);
        this.logDebug(`Autoload present but script missing; restored ${destinationScript}`);
      } else {
        this.logDebug('Interaction server autoload and script already present; leaving project untouched');
      }
      return false;
    }

    copyFileSync(this.options.sourceScriptPath, destinationScript);
    this.logDebug(`Copied interaction server script to ${destinationScript}`);
    const autoloadLine = `${this.autoloadName}="*res://${DESTINATION_SCRIPT_NAME}"`;
    const content = existingContent.includes('[autoload]')
      ? existingContent.replace('[autoload]', `[autoload]\n\n${autoloadLine}`)
      : `${existingContent}\n[autoload]\n\n${autoloadLine}\n`;
    writeFileSync(projectFile, content, 'utf8');
    this.logDebug(`Injected ${this.autoloadName} autoload into project.godot`);
    return true;
  }

  /** Removes an MCP-owned installation. User-managed installations are left untouched. */
  remove(projectPath: string, ownedByMcp: boolean): void {
    if (!ownedByMcp) {
      this.logDebug('Interaction server was user-managed; skipping cleanup');
      return;
    }

    const projectFile = join(projectPath, 'project.godot');
    const destinationScript = join(projectPath, DESTINATION_SCRIPT_NAME);
    if (existsSync(projectFile)) {
      let content = readFileSync(projectFile, 'utf8');
      const autoloadLine = `${this.autoloadName}="*res://${DESTINATION_SCRIPT_NAME}"`;
      content = content.replace(new RegExp(`\\n?${escapeRegExp(autoloadLine)}\\n?`), '\n');
      writeFileSync(projectFile, content, 'utf8');
      this.logDebug('Removed interaction server autoload from project.godot');
    }

    if (existsSync(destinationScript)) {
      unlinkSync(destinationScript);
      this.logDebug('Deleted interaction server script from project');
    }
    const uidFile = `${destinationScript}.uid`;
    if (existsSync(uidFile)) {
      unlinkSync(uidFile);
      this.logDebug('Deleted interaction server .uid file');
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
