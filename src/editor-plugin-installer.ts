import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ADDON_DIR = 'addons/mcp_editor';
const PLUGIN_NAME = 'mcp_editor';

export class EditorPluginInstaller {
  constructor(private readonly scriptPath: string) {}

  install(projectPath: string): boolean {
    const addon = join(projectPath, ADDON_DIR);
    const script = join(addon, 'plugin.gd');
    const config = join(addon, 'plugin.cfg');
    const projectFile = join(projectPath, 'project.godot');
    mkdirSync(addon, { recursive: true });
    copyFileSync(this.scriptPath, script);
    writeFileSync(config, '[plugin]\nname="Godot MCP Editor Bridge"\ndescription="Authenticated MCP editor state and undo/redo bridge"\nauthor="Godot MCP"\nversion="1.0"\nscript="plugin.gd"\n');
    const content = readFileSync(projectFile, 'utf8');
    if (content.includes(`"${PLUGIN_NAME}"`)) return false;
    const section = '[editor_plugins]';
    const entry = `enabled=PackedStringArray("${PLUGIN_NAME}")`;
    const updated = content.includes(section)
      ? content.replace(section, `${section}\n\n${entry}`)
      : `${content}\n${section}\n\n${entry}\n`;
    writeFileSync(projectFile, updated, 'utf8');
    return true;
  }

  remove(projectPath: string, owned: boolean): void {
    if (!owned) return;
    const projectFile = join(projectPath, 'project.godot');
    if (existsSync(projectFile)) {
      const content = readFileSync(projectFile, 'utf8');
      writeFileSync(projectFile, content.replace(/\n?\[editor_plugins\][\s\S]*?enabled=PackedStringArray\("mcp_editor"\)\n?/, '\n'), 'utf8');
    }
    rmSync(join(projectPath, ADDON_DIR), { recursive: true, force: true });
  }
}
