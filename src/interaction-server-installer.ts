import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { DebugLogger } from './godot-executable.js';

const DEFAULT_AUTOLOAD_NAME = 'McpInteractionServer';
const DESTINATION_SCRIPT_NAME = 'mcp_interaction_server.gd';
/** Domain scripts the server preloads from res://; a missing copy fails the autoload at parse time. */
const RUNTIME_DIR_NAME = 'mcp_runtime';
/**
 * The engine merges override.cfg over project.godot at startup, so the autoload
 * is declared in a file MCP creates and deletes and never in a file the user
 * tracks. Proven against Godot 4.7 in the Phase 6a spike (see TODO.md).
 */
const OVERRIDE_FILE_NAME = 'override.cfg';
const BLOCK_BEGIN = '; godot-mcp: begin interaction server (generated; removed automatically)';
const BLOCK_END = '; godot-mcp: end interaction server';

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
    // A crashed or SIGKILLed earlier server had no chance to clean up; start
    // from a truthful state before deciding who owns the installation.
    this.reapStaleInstallation(projectPath);

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
      // The script is only useful with its domain scripts, so keep them in sync even
      // when an existing installation is left in place.
      this.syncRuntimeDir(projectPath);
      return false;
    }

    copyFileSync(this.options.sourceScriptPath, destinationScript);
    this.syncRuntimeDir(projectPath);
    this.logDebug(`Copied interaction server script to ${destinationScript}`);
    this.appendOverrideBlock(projectPath);
    this.logDebug(`Declared ${this.autoloadName} autoload in ${OVERRIDE_FILE_NAME}; project.godot is untouched`);
    return true;
  }

  /** Removes an MCP-owned installation. User-managed installations are left untouched. */
  remove(projectPath: string, ownedByMcp: boolean): void {
    if (!ownedByMcp) {
      this.logDebug('Interaction server was user-managed; skipping cleanup');
      return;
    }

    if (this.stripOverrideBlock(projectPath)) {
      this.logDebug(`Removed interaction server autoload from ${OVERRIDE_FILE_NAME}`);
    }
    this.removeInstalledArtifacts(projectPath);
  }

  /**
   * Stateless cleanup of artifacts an earlier crashed or SIGKILLed server left
   * behind. Ownership is re-derived from the artifacts themselves: a sentinel
   * block in override.cfg is proof MCP wrote the installation, and a server
   * script byte-identical to the shipped source covers a crash that happened
   * before the override block was written. A user-managed installation — the
   * autoload declared in project.godot — never loses its scripts.
   *
   * Two live MCP servers pointed at the same project cannot be distinguished
   * from a crash by looking at the filesystem; concurrent same-project servers
   * are unsupported (they would collide on the runtime port anyway).
   *
   * Returns the artifacts that were removed.
   */
  reapStaleInstallation(projectPath: string): string[] {
    const reaped: string[] = [];
    const projectFile = join(projectPath, 'project.godot');
    const userManaged = existsSync(projectFile) && readFileSync(projectFile, 'utf8').includes(this.autoloadName);

    const hadOverrideBlock = this.stripOverrideBlock(projectPath);
    if (hadOverrideBlock) reaped.push(join(projectPath, OVERRIDE_FILE_NAME));

    if (!userManaged) {
      const destinationScript = join(projectPath, DESTINATION_SCRIPT_NAME);
      const scriptIsOurs = existsSync(destinationScript)
        && (hadOverrideBlock || this.fileMatchesShippedSource(destinationScript));
      if (scriptIsOurs) {
        reaped.push(...this.removeInstalledArtifacts(projectPath));
      } else if (!existsSync(destinationScript) && this.runtimeDirLooksOwned(projectPath)) {
        // A crash between deleting the script and deleting the domain scripts
        // leaves an orphan mcp_runtime directory that is provably ours.
        rmSync(join(projectPath, RUNTIME_DIR_NAME), { recursive: true, force: true });
        reaped.push(join(projectPath, RUNTIME_DIR_NAME));
      }
    }

    if (reaped.length > 0) {
      this.logDebug(`Reaped stale interaction server artifacts: ${reaped.join(', ')}`);
    }
    return reaped;
  }

  /** Deletes the script, its .uid sidecar, and the domain scripts; returns what existed. */
  private removeInstalledArtifacts(projectPath: string): string[] {
    const removed: string[] = [];
    const destinationScript = join(projectPath, DESTINATION_SCRIPT_NAME);
    if (existsSync(destinationScript)) {
      unlinkSync(destinationScript);
      removed.push(destinationScript);
      this.logDebug('Deleted interaction server script from project');
    }
    const uidFile = `${destinationScript}.uid`;
    if (existsSync(uidFile)) {
      unlinkSync(uidFile);
      removed.push(uidFile);
      this.logDebug('Deleted interaction server .uid file');
    }
    const runtimeDir = join(projectPath, RUNTIME_DIR_NAME);
    if (existsSync(runtimeDir)) {
      // Removes the domain scripts and any .uid files Godot generated beside them.
      rmSync(runtimeDir, { recursive: true, force: true });
      removed.push(runtimeDir);
      this.logDebug('Deleted interaction server domain scripts from project');
    }
    return removed;
  }

  /** Appends the sentinel-delimited autoload block, preserving any user-owned override.cfg content. */
  private appendOverrideBlock(projectPath: string): void {
    const overrideFile = join(projectPath, OVERRIDE_FILE_NAME);
    const block = [
      BLOCK_BEGIN,
      '[autoload]',
      `${this.autoloadName}="*res://${DESTINATION_SCRIPT_NAME}"`,
      BLOCK_END,
      '',
    ].join('\n');
    if (!existsSync(overrideFile)) {
      writeFileSync(overrideFile, block, 'utf8');
      return;
    }
    const current = readFileSync(overrideFile, 'utf8');
    // If the user file lacks a trailing newline one is added and survives
    // removal; a benign normalization, and the only byte the strip cannot
    // attribute. MCP-created files round-trip byte-identically.
    writeFileSync(overrideFile, current.endsWith('\n') || current === '' ? current + block : `${current}\n${block}`, 'utf8');
  }

  /**
   * Removes the sentinel block from override.cfg. Deletes the file when
   * nothing else is in it, so a project that had no override.cfg gets none
   * back. Returns whether a block was found.
   */
  private stripOverrideBlock(projectPath: string): boolean {
    const overrideFile = join(projectPath, OVERRIDE_FILE_NAME);
    if (!existsSync(overrideFile)) return false;
    const content = readFileSync(overrideFile, 'utf8');
    const begin = content.indexOf(BLOCK_BEGIN);
    if (begin < 0) return false;
    const endMarker = content.indexOf(BLOCK_END, begin);
    const end = endMarker < 0 ? content.length : Math.min(endMarker + BLOCK_END.length + 1, content.length);
    const stripped = content.slice(0, begin) + content.slice(end);
    if (stripped.trim() === '') {
      unlinkSync(overrideFile);
    } else {
      writeFileSync(overrideFile, stripped, 'utf8');
    }
    return true;
  }

  /** Whether the installed server script is byte-identical to the shipped source. */
  private fileMatchesShippedSource(installedPath: string): boolean {
    try {
      return readFileSync(installedPath).equals(readFileSync(this.options.sourceScriptPath));
    } catch {
      return false;
    }
  }

  /**
   * Whether every file in the project's mcp_runtime directory is either a
   * Godot-generated .uid sidecar or byte-identical to the shipped domain
   * script of the same name. Anything else means the directory is not ours.
   */
  private runtimeDirLooksOwned(projectPath: string): boolean {
    const installedDir = join(projectPath, RUNTIME_DIR_NAME);
    if (!existsSync(installedDir)) return false;
    const sourceDir = join(dirname(this.options.sourceScriptPath), RUNTIME_DIR_NAME);
    const entries = readdirSync(installedDir, { recursive: true, encoding: 'utf8' });
    for (const entry of entries) {
      if (entry.endsWith('.uid')) continue;
      const installed = join(installedDir, entry);
      const shipped = join(sourceDir, entry);
      try {
        if (readFileSync(installed).equals(readFileSync(shipped))) continue;
      } catch {
        // Directories throw EISDIR on both sides; a file missing from the
        // shipped tree throws ENOENT and means the directory is not ours.
        if (isDirectory(installed) && isDirectory(shipped)) continue;
      }
      return false;
    }
    return true;
  }

  /** Copies the domain scripts the installed server preloads, overwriting stale copies. */
  private syncRuntimeDir(projectPath: string): void {
    const source = join(dirname(this.options.sourceScriptPath), RUNTIME_DIR_NAME);
    if (!existsSync(source)) {
      this.logDebug(`No ${RUNTIME_DIR_NAME} directory beside the source script; nothing to sync`);
      return;
    }
    cpSync(source, join(projectPath, RUNTIME_DIR_NAME), { recursive: true });
    this.logDebug(`Synced ${RUNTIME_DIR_NAME} domain scripts into ${projectPath}`);
  }
}

function isDirectory(path: string): boolean {
  try {
    return readdirSync(path) !== undefined;
  } catch {
    return false;
  }
}
