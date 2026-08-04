import type { ProjectSupport } from '../project-support.js';
import type { GodotExecutableService } from '../godot-executable.js';
import {
  createErrorResponse,
  PathSecurity,
  type ToolArguments,
} from '../utils.js';
import {
  ImportPipelineService,
  ProjectIntegrityService,
  ExportReadinessService,
  DotnetWorkflowService,
  AddonManagementService,
  ProjectTestService,
} from './project-handler-services.js';

export interface ProjectToolHandlerContext {
  executable: GodotExecutableService;
  logDebug: (message: string) => void;
  projectSupport: ProjectSupport;
  pathSecurity?: PathSecurity;
  ownedTransientFiles?: (projectPath: string) => ReadonlySet<string>;
}

/** Implements the retained project inspection and validation tools. */
export class ProjectToolHandlers {
  private readonly context: Omit<ProjectToolHandlerContext, 'pathSecurity'> & { pathSecurity: PathSecurity };
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
    };
    const serviceContext = {
      executable: context.executable,
      pathSecurity,
      projectSupport: context.projectSupport,
      ownedTransientFiles: context.ownedTransientFiles,
    };
    this.projectTests = new ProjectTestService(serviceContext);
    this.importPipeline = new ImportPipelineService(serviceContext);
    this.projectIntegrity = new ProjectIntegrityService(serviceContext);
    this.exportReadiness = new ExportReadinessService(serviceContext);
    this.dotnetWorkflow = new DotnetWorkflowService(serviceContext);
    this.addonManagement = new AddonManagementService(serviceContext);
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
}
