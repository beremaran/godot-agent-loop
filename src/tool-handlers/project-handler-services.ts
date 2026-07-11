import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';

import { createErrorResponse, errorMessage, normalizeParameters, validatePath, type OperationParams, type ToolArguments, type ToolResponse, PathSecurity } from '../utils.js';
import type { ProjectSupport } from '../project-support.js';
import type { GodotExecutableService } from '../godot-executable.js';
import type { HeadlessOperationService } from '../headless-operation-service.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GODOT_EXPORT_OPTIONS } from '../godot-subprocess.js';

const execFileAsync = promisify(execFile);

/** Dependencies shared by the focused project-tool services. */
export interface ProjectHandlerServiceContext {
  executable: GodotExecutableService;
  operations: HeadlessOperationService;
  pathSecurity: PathSecurity;
  projectSupport: ProjectSupport;
}

function projectFile(projectPath: string): string {
  return join(projectPath, 'project.godot');
}

function projectRelativePath(context: ProjectHandlerServiceContext, projectPath: string, relativePath: string): string {
  const resolved = context.pathSecurity.resolveProjectPath(projectPath, relativePath);
  if (!resolved) throw new Error(`Path is outside the project: ${relativePath}`);
  return resolved;
}

function validProject(context: ProjectHandlerServiceContext, projectPath: unknown): projectPath is string {
  return typeof projectPath === 'string'
    && context.pathSecurity.isProjectPathAllowed(projectPath)
    && existsSync(projectFile(projectPath));
}

/** Owns project-relative file operations and their security checks. */
export class ProjectFileIOService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async read(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath) return createErrorResponse('projectPath and filePath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.filePath)) return createErrorResponse('Invalid path.');
    try {
      const fullPath = projectRelativePath(this.context, args.projectPath, args.filePath);
      if (!existsSync(fullPath)) return createErrorResponse(`File does not exist: ${args.filePath}`);
      return { content: [{ type: 'text', text: readFileSync(fullPath, 'utf8') }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to read file: ${errorMessage(error)}`); }
  }

  async write(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath || args.content === undefined) return createErrorResponse('projectPath, filePath, and content are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.filePath)) return createErrorResponse('Invalid path.');
    try {
      const fullPath = projectRelativePath(this.context, args.projectPath, args.filePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, args.content, 'utf8');
      return { content: [{ type: 'text', text: `File written: ${args.filePath}` }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to write file: ${errorMessage(error)}`); }
  }

  async delete(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath) return createErrorResponse('projectPath and filePath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.filePath)) return createErrorResponse('Invalid path.');
    try {
      const fullPath = projectRelativePath(this.context, args.projectPath, args.filePath);
      if (!existsSync(fullPath)) return createErrorResponse(`File does not exist: ${args.filePath}`);
      unlinkSync(fullPath);
      return { content: [{ type: 'text', text: `File deleted: ${args.filePath}` }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to delete file: ${errorMessage(error)}`); }
  }

  async createDirectory(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.directoryPath) return createErrorResponse('projectPath and directoryPath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.directoryPath)) return createErrorResponse('Invalid path.');
    try {
      mkdirSync(projectRelativePath(this.context, args.projectPath, args.directoryPath), { recursive: true });
      return { content: [{ type: 'text', text: `Directory created: ${args.directoryPath}` }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to create directory: ${errorMessage(error)}`); }
  }

  async rename(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath || !args.newPath) return createErrorResponse('projectPath, filePath, and newPath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.filePath) || !validatePath(args.newPath)) return createErrorResponse('Invalid path.');
    try {
      const source = projectRelativePath(this.context, args.projectPath, args.filePath);
      if (!existsSync(source)) return createErrorResponse(`File not found: ${args.filePath}`);
      const destination = projectRelativePath(this.context, args.projectPath, args.newPath);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
      return { content: [{ type: 'text', text: `Renamed ${args.filePath} → ${args.newPath}` }] };
    } catch (error: unknown) { return createErrorResponse(`rename_file failed: ${errorMessage(error)}`); }
  }
}

/** Owns direct reads and writes to project.godot settings. */
export class ProjectConfigurationService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async read(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath) return createErrorResponse('projectPath is required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid path.');
    try {
      const sections: Record<string, Record<string, string>> = {};
      let currentSection = '';
      for (const line of readFileSync(projectFile(args.projectPath), 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';')) continue;
        const section = /^\[(.+)\]$/.exec(trimmed);
        if (section) { currentSection = section[1]; sections[currentSection] ??= {}; continue; }
        const setting = /^([^=]+)=(.*)$/.exec(trimmed);
        if (setting && currentSection) sections[currentSection][setting[1].trim()] = setting[2].trim();
      }
      return { content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to read project settings: ${errorMessage(error)}`); }
  }

  async modify(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.section || !args.key || args.value === undefined) return createErrorResponse('projectPath, section, key, and value are required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid path.');
    try {
      let content = readFileSync(projectFile(args.projectPath), 'utf8');
      const header = `[${args.section}]`;
      const setting = `${args.key}=${args.value}`;
      const index = content.indexOf(header);
      if (index === -1) content += `\n\n${header}\n\n${setting}\n`;
      else {
        const end = content.indexOf('\n[', index + header.length);
        const section = content.slice(index, end === -1 ? undefined : end);
        const keyPattern = new RegExp(`^${args.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
        const updated = keyPattern.test(section) ? section.replace(keyPattern, setting) : `${section}\n${setting}`;
        content = content.slice(0, index) + updated + (end === -1 ? '' : content.slice(end));
      }
      writeFileSync(projectFile(args.projectPath), content, 'utf8');
      return { content: [{ type: 'text', text: `Setting updated: [${args.section}] ${args.key}=${args.value}` }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to modify project settings: ${errorMessage(error)}`); }
  }
}

/** Owns GDScript validation and keeps batch limits in one place. */
export class ScriptValidationService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async validate(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scriptPath) return createErrorResponse('projectPath and scriptPath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.scriptPath)) return createErrorResponse('Invalid path.');
    if (!/\.gd$/i.test(args.scriptPath)) return createErrorResponse('validate_script only checks GDScript (.gd) files.');
    const scriptPath = projectRelativePath(this.context, args.projectPath, args.scriptPath);
    if (!existsSync(scriptPath)) return createErrorResponse(`Script does not exist: ${args.scriptPath}`);
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return createErrorResponse('Could not find a valid Godot executable path');
    const check = await this.context.projectSupport.runGdScriptCheck(args.projectPath, scriptPath);
    if (!check.completed) return createErrorResponse(`validate_script could not check the script; ${check.error}`);
    return { content: [{ type: 'text', text: JSON.stringify({ valid: check.errors.length === 0, scriptPath: args.scriptPath, errorCount: check.errors.length, errors: check.errors }, null, 2) }] };
  }
}

/** Owns invocation of Godot's export command. */
export class ProjectExportService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async export(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.presetName || !args.outputPath) return createErrorResponse('projectPath, presetName, and outputPath are required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid project path.');
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return createErrorResponse('Could not find Godot executable.');
    try {
      const flag = args.debug ? '--export-debug' : '--export-release';
      const { stdout, stderr } = await execFileAsync(this.context.executable.path, ['--headless', '--path', args.projectPath, flag, args.presetName, args.outputPath], GODOT_EXPORT_OPTIONS);
      if (stderr && stderr.includes('ERROR')) return createErrorResponse(`Export failed: ${stderr}`);
      return { content: [{ type: 'text', text: `Export succeeded.\n\nOutput: ${stdout || args.outputPath}` }] };
    } catch (error: unknown) { return createErrorResponse(`Export failed: ${errorMessage(error)}`); }
  }
}

/** Owns the common headless scene-operation delegation. */
export class SceneOperationService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async run(operation: string, args: ToolArguments, params: OperationParams): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath) return createErrorResponse('projectPath is required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid path.');
    return this.context.operations.run(operation, args.projectPath, params);
  }
}
