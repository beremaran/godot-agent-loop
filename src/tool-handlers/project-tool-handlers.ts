import { join, basename } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  normalizeParameters,
  validatePath,
  createErrorResponse,
  errorMessage,
  PathSecurity,
} from '../utils.js';
import { type ToolArguments } from '../utils.js';
import type { ProjectSupport } from '../project-support.js';
import type { GodotExecutableService } from '../godot-executable.js';
import type { HeadlessOperationService } from '../headless-operation-service.js';
import { GODOT_VERSION_OPTIONS } from '../godot-subprocess.js';
import { currentExecutionContext, isAbortError } from '../execution-context.js';
import {
  ProjectExportService,
  ImportPipelineService,
  ProjectIntegrityService,
  ExportReadinessService,
  DotnetWorkflowService,
  AddonManagementService,
  ProjectTestService,
  ScriptValidationService,
} from './project-handler-services.js';

const execFileAsync = promisify(execFile);

export interface ProjectToolHandlerContext {
  executable: GodotExecutableService;
  logDebug: (message: string) => void;
  operations: HeadlessOperationService;
  projectSupport: ProjectSupport;
  pathSecurity?: PathSecurity;
  ownedTransientFiles?: (projectPath: string) => ReadonlySet<string>;
}

interface ProjectOperationApi {
  getGodotPath: () => string | null;
  detectGodotPath: () => Promise<void>;
}

interface ValidationResult {
  scriptPath: string;
  checked: boolean;
  valid?: boolean;
  error?: string;
  errorCount?: number;
  errors?: unknown[];
}

/** Implements the retained project inspection, validation, and export tools. */
export class ProjectToolHandlers {
  private readonly context: Omit<ProjectToolHandlerContext, 'pathSecurity'> & { pathSecurity: PathSecurity } & ProjectOperationApi;
  private readonly scriptValidation: ScriptValidationService;
  private readonly exportService: ProjectExportService;
  private readonly projectTests: ProjectTestService;
  private readonly importPipeline: ImportPipelineService;
  private readonly projectIntegrity: ProjectIntegrityService;
  private readonly exportReadiness: ExportReadinessService;
  private readonly dotnetWorkflow: DotnetWorkflowService;
  private readonly addonManagement: AddonManagementService;

  constructor(context: ProjectToolHandlerContext) {
    const pathSecurity = context.pathSecurity ?? new PathSecurity();
    this.context = {
      ...context,
      pathSecurity,
      getGodotPath: () => context.executable.path,
      detectGodotPath: async () => { await context.executable.detect(); },
    };
    const serviceContext = {
      executable: context.executable,
      operations: context.operations,
      pathSecurity,
      projectSupport: context.projectSupport,
      ownedTransientFiles: context.ownedTransientFiles,
    };
    this.scriptValidation = new ScriptValidationService(serviceContext);
    this.exportService = new ProjectExportService(serviceContext);
    this.projectTests = new ProjectTestService(serviceContext);
    this.importPipeline = new ImportPipelineService(serviceContext);
    this.projectIntegrity = new ProjectIntegrityService(serviceContext);
    this.exportReadiness = new ExportReadinessService(serviceContext);
    this.dotnetWorkflow = new DotnetWorkflowService(serviceContext);
    this.addonManagement = new AddonManagementService(serviceContext);
  }

  public async handleGetProjectInfo(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }
  
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath, true)) {
      return createErrorResponse(
        `Project path is outside the allowed roots: ${args.projectPath}`
      );
    }

    if (!existsSync(args.projectPath)) {
      return createErrorResponse(
        `Project directory does not exist: ${args.projectPath}.`
      );
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) {
      return createErrorResponse(
        `Project path cannot be read safely: ${args.projectPath}`
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.context.getGodotPath()) {
        await this.context.detectGodotPath();
        if (!this.context.getGodotPath()) {
          return createErrorResponse(
            'Could not find a valid Godot executable path'
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }
  
      this.context.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const { stdout } = await execFileAsync(this.context.getGodotPath()!, ['--version'], {
        ...GODOT_VERSION_OPTIONS,
        signal: currentExecutionContext()?.signal,
      });
  
      // Get project structure using the recursive method
      const projectStructure = await this.context.projectSupport.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const projectFileContent = readFileSync(projectFile, 'utf8');
        const configNameMatch = /config\/name="([^"]+)"/.exec(projectFileContent);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.context.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.context.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                isDotnet: this.context.projectSupport.isDotnetProject(args.projectPath),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: unknown) {
      if (isAbortError(error) || currentExecutionContext()?.signal.aborted) throw error;
      return createErrorResponse(
        `Failed to get project info: ${errorMessage(error)}`
      );
    }
  }

  public async handleExportProject(args: ToolArguments) {
    return this.exportService.export(args);
  }

  public async handleRunProjectTests(args: ToolArguments) {
    if (args.action !== 'discover' && args.action !== 'run') {
      return createErrorResponse('action must be discover or run.');
    }
    return this.projectTests.execute(args);
  }

  public async handleManageImportPipeline(args: ToolArguments) {
    if (!['inspect', 'change', 'reimport', 'dependencies'].includes(String(args.action))) {
      return createErrorResponse('action must be inspect, change, reimport, or dependencies.');
    }
    return this.importPipeline.execute(args);
  }

  public async handleAnalyzeProjectIntegrity(args: ToolArguments) {
    if (!['analyze', 'preview_rename', 'assets', 'localization', 'accessibility', 'extensions', 'leaks'].includes(args.action)) {
      return createErrorResponse('action must be analyze, preview_rename, assets, localization, accessibility, extensions, or leaks.');
    }
    return this.projectIntegrity.execute(args);
  }

  public async handleVerifyExportReadiness(args: ToolArguments) {
    if (args.action !== 'inspect' && args.action !== 'export_smoke') {
      return createErrorResponse('action must be inspect or export_smoke.');
    }
    return this.exportReadiness.execute(args);
  }

  public async handleVerifyDotnetProject(args: ToolArguments) {
    if (!['inspect', 'restore', 'build', 'run'].includes(String(args.action))) {
      return createErrorResponse('action must be inspect, restore, build, or run.');
    }
    return this.dotnetWorkflow.execute(args);
  }

  public async handleManageAddon(args: ToolArguments) {
    if (!['inspect', 'install', 'update', 'remove', 'enable', 'disable'].includes(String(args.action))) {
      return createErrorResponse('action must be inspect, install, update, remove, enable, or disable.');
    }
    return this.addonManagement.execute(args);
  }

  public async handleValidateScript(args: ToolArguments) {
    return this.scriptValidation.validate(args);
  }

  public async handleValidateScripts(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath) return createErrorResponse('projectPath is required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    if (!this.context.getGodotPath()) {
      await this.context.detectGodotPath();
      if (!this.context.getGodotPath()) return createErrorResponse('Could not find a valid Godot executable path');
    }

    let scope: string;
    let candidates: string[];
    const explicit = Array.isArray(args.scriptPaths) && args.scriptPaths.length > 0;
    if (explicit) {
      scope = 'explicit';
      candidates = args.scriptPaths.map((p: unknown) => String(p));
    } else if (args.scope === undefined || args.scope === 'changed') {
      scope = 'changed';
      const changed = await this.context.projectSupport.listChangedGdFiles(args.projectPath);
      if (changed.error) return createErrorResponse(changed.error);
      candidates = changed.files!;
    } else if (args.scope === 'all') {
      scope = 'all';
      const ownedTransientFiles = this.context.ownedTransientFiles?.(args.projectPath) ?? new Set<string>();
      candidates = this.context.projectSupport.listAllGdFiles(args.projectPath)
        .filter(path => !ownedTransientFiles.has(path));
    } else {
      return createErrorResponse(`Invalid scope "${args.scope}". Use "changed" or "all", or pass scriptPaths.`);
    }

    const results: ValidationResult[] = [];
    let filesWithErrors = 0;
    const toCheck: string[] = [];
    const warnings: string[] = [];
    if (scope !== 'explicit' && candidates.length === 0) {
      warnings.push('No GDScript files matched this scope; validation did not run. Use scope: "all" or pass scriptPaths.');
    }
    for (const rel of candidates) {
      if (!/\.gd$/i.test(rel) || !validatePath(rel)) {
        if (explicit) results.push({ scriptPath: rel, checked: false, error: 'Not a valid .gd path' });
        continue;
      }
      if (!existsSync(join(args.projectPath, rel))) {
        if (explicit) results.push({ scriptPath: rel, checked: false, error: 'Script does not exist' });
        continue;
      }
      toCheck.push(rel);
    }

    const MAX_BATCH = 60;
    if (toCheck.length > MAX_BATCH)
      return createErrorResponse(`Too many scripts to validate (${toCheck.length} > ${MAX_BATCH}). Narrow the scope or pass an explicit scriptPaths list.`);

    for (const rel of toCheck) {
      const check = await this.context.projectSupport.runGdScriptCheck(args.projectPath, join(args.projectPath, rel));
      if (!check.completed) {
        results.push({ scriptPath: rel, checked: false, error: check.error });
      } else {
        if (check.errors.length > 0) filesWithErrors++;
        results.push({ scriptPath: rel, checked: true, valid: check.errors.length === 0, errorCount: check.errors.length, errors: check.errors });
      }
    }

    const report: Record<string, unknown> = {
      scope,
      fileCount: results.length,
      filesWithErrors,
      allValid: warnings.length === 0 && filesWithErrors === 0 && results.every(r => r.checked),
      results,
    };
    if (warnings.length > 0) report.warning = warnings.join(' ');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(report, null, 2),
        },
      ],
    };
  }

}
