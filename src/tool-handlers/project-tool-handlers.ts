import { join, dirname, basename } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  normalizeParameters,
  validatePath,
  createErrorResponse,
  errorMessage,
  isGodot44OrLater,
  generateGodotProjectFeatures,
  generateCsprojContent,
  generateCsharpScriptSource,
  toDotnetIdentifier,
  isValidCsharpIdentifier,
  PathSecurity,
} from '../utils.js';
import { type OperationParams, type ToolArguments, type ToolResponse } from '../utils.js';
import type { ProjectSupport } from '../project-support.js';
import type { GodotExecutableService } from '../godot-executable.js';
import type { HeadlessOperationService } from '../headless-operation-service.js';
import { GODOT_VERSION_OPTIONS } from '../godot-subprocess.js';
import {
  ProjectConfigurationService,
  ProjectExportService,
  ProjectFileIOService,
  SceneOperationService,
  ScriptValidationService,
} from './project-handler-services.js';

const execFileAsync = promisify(execFile);

export interface ProjectToolHandlerContext {
  executable: GodotExecutableService;
  logDebug: (message: string) => void;
  operations: HeadlessOperationService;
  projectSupport: ProjectSupport;
  pathSecurity?: PathSecurity;
}

interface ProjectOperationApi {
  getGodotPath: () => string | null;
  detectGodotPath: () => Promise<void>;
  executeOperation: (operation: string, params: OperationParams, projectPath: string) => Promise<{ stdout: string; stderr: string }>;
  headlessOp: (operation: string, args: ToolArguments, argsFn: (a: ToolArguments) => { projectPath: string; params: OperationParams }) => Promise<ToolResponse>;
}

interface ValidationResult {
  scriptPath: string;
  checked: boolean;
  valid?: boolean;
  error?: string;
  errorCount?: number;
  errors?: unknown[];
}

/** Implements project, scene, file, script, and export tools. */
export class ProjectToolHandlers {
  private readonly context: Omit<ProjectToolHandlerContext, 'pathSecurity'> & { pathSecurity: PathSecurity } & ProjectOperationApi;
  private readonly fileIO: ProjectFileIOService;
  private readonly configuration: ProjectConfigurationService;
  private readonly scriptValidation: ScriptValidationService;
  private readonly exportService: ProjectExportService;
  private readonly sceneOperations: SceneOperationService;

  constructor(context: ProjectToolHandlerContext) {
    const pathSecurity = context.pathSecurity ?? new PathSecurity();
    this.context = {
      ...context,
      pathSecurity,
      getGodotPath: () => context.executable.path,
      detectGodotPath: async () => { await context.executable.detect(); },
      executeOperation: (operation, params, projectPath) => context.operations.execute(operation, params, projectPath),
      headlessOp: (operation, args, argsFn) => {
        const { projectPath, params } = argsFn(args);
        return context.operations.run(operation, projectPath, params);
      },
    };
    const serviceContext = {
      executable: context.executable,
      operations: context.operations,
      pathSecurity,
      projectSupport: context.projectSupport,
    };
    this.fileIO = new ProjectFileIOService(serviceContext);
    this.configuration = new ProjectConfigurationService(serviceContext);
    this.scriptValidation = new ScriptValidationService(serviceContext);
    this.exportService = new ProjectExportService(serviceContext);
    this.sceneOperations = new SceneOperationService(serviceContext);
  }

  private projectRelativePath(projectPath: string, relativePath: string): string {
    const resolved = this.context.pathSecurity.resolveProjectPath(projectPath, relativePath);
    if (!resolved) throw new Error(`Path is outside the project: ${relativePath}`);
    return resolved;
  }

  public async handleListProjects(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.directory) {
      return createErrorResponse(
        'Directory is required'
      );
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.directory)) {
      return createErrorResponse(
        'Invalid directory path'
      );
    }

    try {
      this.context.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return createErrorResponse(
          `Directory does not exist: ${args.directory}`
        );
      }

      const recursive = args.recursive === true;
      const projects = this.context.projectSupport.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(
        `Failed to list projects: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */

  public async handleGetProjectInfo(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }
  
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path'
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
      const { stdout } = await execFileAsync(this.context.getGodotPath()!, ['--version'], GODOT_VERSION_OPTIONS);
  
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
      return createErrorResponse(
        `Failed to get project info: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Handle the create_scene tool
   */

  public async handleCreateScene(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse(
        'Project path and scene path are required'
      );
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType: args.rootNodeType || 'Node2D',
      };

      // Execute the operation
      const { stdout, stderr } = await this.context.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to create scene: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(
        `Failed to create scene: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Handle the add_node tool
   */

  public async handleAddNode(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the scene file exists
      const scenePath = this.projectRelativePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: OperationParams = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.context.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to add node: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(
        `Failed to add node: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */

  public async handleLoadSprite(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (
      !this.context.pathSecurity.isProjectPathAllowed(args.projectPath) ||
      !validatePath(args.scenePath) ||
      !validatePath(args.nodePath) ||
      !validatePath(args.texturePath)
    ) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the scene file exists
      const scenePath = this.projectRelativePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Check if the texture file exists
      const texturePath = this.projectRelativePath(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.context.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to load sprite: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(
        `Failed to load sprite: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */

  public async handleExportMeshLibrary(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (
      !this.context.pathSecurity.isProjectPathAllowed(args.projectPath) ||
      !validatePath(args.scenePath) ||
      !validatePath(args.outputPath)
    ) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the scene file exists
      const scenePath = this.projectRelativePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: OperationParams = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.context.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to export mesh library: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(
        `Failed to export mesh library: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Handle the save_scene tool
   */

  public async handleSaveScene(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !validatePath(args.newPath)) {
      return createErrorResponse(
        'Invalid new path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the scene file exists
      const scenePath = this.projectRelativePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: OperationParams = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.context.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to save scene: ${stderr}`
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(
        `Failed to save scene: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Handle the get_uid tool
   */

  public async handleGetUid(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath) || !validatePath(args.filePath)) {
      return createErrorResponse(
        'Invalid path'
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

      // Check if the file exists
      const filePath = this.projectRelativePath(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return createErrorResponse(
          `File does not exist: ${args.filePath}`
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.context.getGodotPath()!, ['--version'], GODOT_VERSION_OPTIONS);
      const version = versionOutput.trim();

      if (!isGodot44OrLater(version)) {
        return createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.context.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to get UID: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(
        `Failed to get UID: ${errorMessage(error)}`
      );
    }
  }


  /**
   * Handle the game_screenshot tool
   */

  public async handleReadScene(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse('projectPath and scenePath are required.');
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse('Invalid path.');
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }

    const scenePath = this.projectRelativePath(args.projectPath, args.scenePath);
    if (!existsSync(scenePath)) {
      return createErrorResponse(`Scene file does not exist: ${args.scenePath}`);
    }

    try {
      const { stdout, stderr } = await this.context.executeOperation('read_scene', {
        scenePath: args.scenePath,
      }, args.projectPath);

      // Extract JSON from the SCENE_JSON_START/END markers
      const startMarker = 'SCENE_JSON_START';
      const endMarker = 'SCENE_JSON_END';
      const startIdx = stdout.indexOf(startMarker);
      const endIdx = stdout.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        const jsonStr = stdout.substring(startIdx + startMarker.length, endIdx).trim();
        try {
          const parsed = JSON.parse(jsonStr);
          return {
            content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
          };
        } catch {
          return {
            content: [{ type: 'text', text: `Raw scene data:\n${jsonStr}` }],
          };
        }
      }

      return {
        content: [{ type: 'text', text: `Scene read output:\n${stdout}\n${stderr ? 'Errors:\n' + stderr : ''}` }],
      };
    } catch (error: unknown) {
      return createErrorResponse(`Failed to read scene: ${errorMessage(error)}`);
    }
  }

  /**
   * Handle the modify_scene_node tool
   */

  public async handleModifySceneNode(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.properties)
      return createErrorResponse('projectPath, scenePath, nodePath, and properties are required.');
    return this.sceneOperations.run('modify_node', args, { scenePath: args.scenePath, nodePath: args.nodePath, properties: args.properties });
  }

  public async handleRemoveSceneNode(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath)
      return createErrorResponse('projectPath, scenePath, and nodePath are required.');
    return this.sceneOperations.run('remove_node', args, { scenePath: args.scenePath, nodePath: args.nodePath });
  }


  /**
   * Handle the read_project_settings tool - Parse project.godot as JSON
   */

  public async handleReadProjectSettings(args: ToolArguments) {
    return this.configuration.read(args);
  }

  /**
   * Handle the modify_project_settings tool - Change a project.godot setting
   */

  public async handleModifyProjectSettings(args: ToolArguments) {
    return this.configuration.modify(args);
  }

  /**
   * Handle the list_project_files tool - List files with extension filtering
   */

  public async handleListProjectFiles(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath) {
      return createErrorResponse('projectPath is required.');
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) {
      return createErrorResponse('Invalid path.');
    }

    if (!existsSync(args.projectPath)) {
      return createErrorResponse(`Directory does not exist: ${args.projectPath}`);
    }

    try {
      const baseDir = args.subdirectory
        ? this.projectRelativePath(args.projectPath, args.subdirectory)
        : args.projectPath;

      if (!existsSync(baseDir)) {
        return createErrorResponse(`Subdirectory does not exist: ${args.subdirectory}`);
      }

      const files: string[] = [];
      const extensions: string[] | undefined = args.extensions;

      const scanDir = (dir: string, relativeTo: string) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(dir, entry.name);
          const relativePath = fullPath.substring(relativeTo.length + 1).replace(/\\/g, '/');

          if (entry.isDirectory()) {
            scanDir(fullPath, relativeTo);
          } else if (entry.isFile()) {
            if (extensions && extensions.length > 0) {
              const ext = '.' + entry.name.split('.').pop();
              if (extensions.includes(ext)) {
                files.push(relativePath);
              }
            } else {
              files.push(relativePath);
            }
          }
        }
      };

      scanDir(baseDir, args.projectPath);

      return {
        content: [{ type: 'text', text: JSON.stringify({ count: files.length, files }, null, 2) }],
      };
    } catch (error: unknown) {
      return createErrorResponse(`Failed to list project files: ${errorMessage(error)}`);
    }
  }

  public async handleAttachScript(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.scriptPath)
      return createErrorResponse('projectPath, scenePath, nodePath, and scriptPath are required.');
    return this.context.headlessOp('attach_script', args, a => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath, scriptPath: a.scriptPath },
    }));
  }

  public async handleCreateResource(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.resourceType || !args.resourcePath)
      return createErrorResponse('projectPath, resourceType, and resourcePath are required.');
    return this.context.headlessOp('create_resource', args, a => ({
      projectPath: a.projectPath,
      params: { resourceType: a.resourceType, resourcePath: a.resourcePath, ...(a.properties ? { properties: a.properties } : {}) },
    }));
  }

  // --- File I/O handlers ---

  public async handleReadFile(args: ToolArguments) {
    return this.fileIO.read(args);
  }

  public async handleWriteFile(args: ToolArguments) {
    return this.fileIO.write(args);
  }

  public async handleDeleteFile(args: ToolArguments) {
    return this.fileIO.delete(args);
  }

  public async handleCreateDirectory(args: ToolArguments) {
    return this.fileIO.createDirectory(args);
  }

  // --- Error/Log capture handlers ---

  public async handleCreateProject(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.projectName)
      return createErrorResponse('projectPath and projectName are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath, true))
      return createErrorResponse('Invalid path.');
    try {
      if (!existsSync(args.projectPath)) {
        mkdirSync(args.projectPath, { recursive: true });
      }
      const projectFile = join(args.projectPath, 'project.godot');
      if (existsSync(projectFile))
        return createErrorResponse('A project.godot already exists at this path.');
      const isDotnet = args.dotnet === true;
      const assemblyName = toDotnetIdentifier(args.projectName);
      const features = generateGodotProjectFeatures(isDotnet);
      let content = `; Engine configuration file.\n; Generated by Godot MCP.\n\nconfig_version=5\n\n[application]\n\nconfig/name="${args.projectName}"\nconfig/features=${features}\n`;
      if (isDotnet) {
        content += `\n[dotnet]\n\nproject/assembly_name="${assemblyName}"\n`;
      }
      writeFileSync(projectFile, content, 'utf8');
      if (isDotnet) {
        const sdkVersion = (await this.context.projectSupport.detectGodotNetSdkVersion()) ?? undefined;
        writeFileSync(this.projectRelativePath(args.projectPath, `${assemblyName}.csproj`), generateCsprojContent(args.projectName, sdkVersion), 'utf8');
      }
      return { content: [{ type: 'text', text: `Project "${args.projectName}" created at ${args.projectPath}${isDotnet ? ' (Godot .NET / C#)' : ''}` }] };
    } catch (error: unknown) {
      return createErrorResponse(`Failed to create project: ${errorMessage(error)}`);
    }
  }

  public async handleCreateCsharpScript(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scriptPath) return createErrorResponse('projectPath and scriptPath are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath) || !validatePath(args.scriptPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    if (!this.context.projectSupport.isDotnetProject(args.projectPath))
      return createErrorResponse('Not a Godot .NET project (no .csproj found). Use create_project with dotnet: true first.');
    if (!/\.cs$/i.test(args.scriptPath))
      return createErrorResponse('scriptPath must end with .cs');
    const fileBase = basename(args.scriptPath).replace(/\.cs$/i, '');
    if (!isValidCsharpIdentifier(fileBase))
      return createErrorResponse(`Invalid C# script file name "${fileBase}.cs": the name must be a valid class name (letters, digits, underscore; not starting with a digit), because Godot requires the class name to match the file name.`);
    if (args.className && args.className !== fileBase)
      return createErrorResponse(`className "${args.className}" must match the script file name "${fileBase}" for Godot to attach the script.`);
    try {
      const fullPath = this.projectRelativePath(args.projectPath, args.scriptPath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      let source = args.source;
      if (!source) {
        source = generateCsharpScriptSource({
          className: fileBase,
          baseClass: args.baseClass,
          namespaceName: args.namespaceName,
          methods: Array.isArray(args.methods) ? args.methods : undefined,
        });
      }
      writeFileSync(fullPath, source, 'utf8');
      return { content: [{ type: 'text', text: `C# script created at ${args.scriptPath}` }] };
    } catch (error: unknown) {
      return createErrorResponse(`create_csharp_script failed: ${errorMessage(error)}`);
    }
  }

  public async handleManageAutoloads(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const autoloads: Record<string, string> = {};
        const autoloadMatch = /\[autoload\]([\s\S]*?)(?=\n\[|$)/.exec(content);
        if (autoloadMatch) {
          for (const line of autoloadMatch[1].split('\n')) {
            const kv = /^([^=]+)=(.*)$/.exec(line.trim());
            if (kv) autoloads[kv[1].trim()] = kv[2].trim();
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(autoloads, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.name || !args.path)
          return createErrorResponse('name and path are required for add action.');
        const autoloadLine = `${args.name}="*${args.path}"`;
        if (content.includes('[autoload]')) {
          content = content.replace('[autoload]', `[autoload]\n\n${autoloadLine}`);
        } else {
          content += `\n[autoload]\n\n${autoloadLine}\n`;
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Autoload "${args.name}" added: ${args.path}` }] };
      } else if (args.action === 'remove') {
        if (!args.name)
          return createErrorResponse('name is required for remove action.');
        const pattern = new RegExp(`\\n?${args.name}\\s*=.*\\n?`, 'g');
        content = content.replace(pattern, '\n');
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Autoload "${args.name}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: unknown) {
      return createErrorResponse(`Failed to manage autoloads: ${errorMessage(error)}`);
    }
  }

  public async handleManageInputMap(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const actions: Record<string, string> = {};
        const inputMatch = /\[input\]([\s\S]*?)(?=\n\[|$)/.exec(content);
        if (inputMatch) {
          for (const line of inputMatch[1].split('\n')) {
            const kv = /^([^=]+)=(.*)$/.exec(line.trim());
            if (kv) actions[kv[1].trim()] = kv[2].trim();
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(actions, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.actionName)
          return createErrorResponse('actionName is required for add action.');
        const deadzone = args.deadzone !== undefined ? args.deadzone : 0.5;
        let events = '';
        if (args.key) {
          events = `, "events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":${this.context.projectSupport.keyNameToScancode(args.key)},"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)]`;
        }
        const inputLine = `${args.actionName}={"deadzone": ${deadzone}${events}}`;
        if (content.includes('[input]')) {
          content = content.replace('[input]', `[input]\n\n${inputLine}`);
        } else {
          content += `\n[input]\n\n${inputLine}\n`;
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Input action "${args.actionName}" added.` }] };
      } else if (args.action === 'remove') {
        if (!args.actionName)
          return createErrorResponse('actionName is required for remove action.');
        const pattern = new RegExp(`\\n?${args.actionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*\\n?`, 'g');
        content = content.replace(pattern, '\n');
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Input action "${args.actionName}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: unknown) {
      return createErrorResponse(`Failed to manage input map: ${errorMessage(error)}`);
    }
  }

  public async handleManageExportPresets(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const presetsFile = join(args.projectPath, 'export_presets.cfg');
    try {
      if (args.action === 'list') {
        if (!existsSync(presetsFile))
          return { content: [{ type: 'text', text: JSON.stringify({ presets: [] }, null, 2) }] };
        const content = readFileSync(presetsFile, 'utf8');
        const presets: { name: string; platform: string }[] = [];
        const nameMatches = content.matchAll(/name="([^"]+)"/g);
        const platformMatches = content.matchAll(/platform="([^"]+)"/g);
        const names = [...nameMatches].map(m => m[1]);
        const platforms = [...platformMatches].map(m => m[1]);
        for (let i = 0; i < names.length; i++) {
          presets.push({ name: names[i], platform: platforms[i] || 'unknown' });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ presets }, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.name || !args.platform)
          return createErrorResponse('name and platform are required for add action.');
        const runnable = args.runnable ? 'true' : 'false';
        const presetBlock = `\n[preset.${Date.now()}]\n\nname="${args.name}"\nplatform="${args.platform}"\nrunnable=${runnable}\n`;
        let content = existsSync(presetsFile) ? readFileSync(presetsFile, 'utf8') : '';
        content += presetBlock;
        writeFileSync(presetsFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Export preset "${args.name}" added for platform "${args.platform}".` }] };
      } else if (args.action === 'remove') {
        if (!args.name)
          return createErrorResponse('name is required for remove action.');
        if (!existsSync(presetsFile))
          return createErrorResponse('No export_presets.cfg file found.');
        let content = readFileSync(presetsFile, 'utf8');
        // Remove the preset section containing the given name
        const pattern = new RegExp(`\\[preset\\.[^\\]]+\\]\\s*\\n[\\s\\S]*?name="${args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?(?=\\[preset\\.|$)`, 'g');
        content = content.replace(pattern, '');
        writeFileSync(presetsFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Export preset "${args.name}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: unknown) {
      return createErrorResponse(`Failed to manage export presets: ${errorMessage(error)}`);
    }
  }

  // --- Advanced runtime handlers ---

  public async handleExportProject(args: ToolArguments) {
    return this.exportService.export(args);
  }

  public async handleRenameFile(args: ToolArguments) {
    return this.fileIO.rename(args);
  }

  public async handleManageResource(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.resourcePath || !args.action) return createErrorResponse('projectPath, resourcePath, and action are required.');
    return this.context.headlessOp('manage_resource', args, a => ({
      projectPath: a.projectPath,
      params: { resourcePath: a.resourcePath, action: a.action, ...(a.properties ? { properties: a.properties } : {}) },
    }));
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
      candidates = this.context.projectSupport.listAllGdFiles(args.projectPath);
    } else {
      return createErrorResponse(`Invalid scope "${args.scope}". Use "changed" or "all", or pass scriptPaths.`);
    }

    const results: ValidationResult[] = [];
    let filesWithErrors = 0;
    const toCheck: string[] = [];
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

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            scope,
            fileCount: results.length,
            filesWithErrors,
            allValid: filesWithErrors === 0 && results.every(r => r.checked),
            results,
          }, null, 2),
        },
      ],
    };
  }

  public async handleCreateScript(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scriptPath) return createErrorResponse('projectPath and scriptPath are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath) || !validatePath(args.scriptPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      const fullPath = this.projectRelativePath(args.projectPath, args.scriptPath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      let source = args.source;
      if (!source) {
        const ext = args.extends || 'Node';
        const lines = [`extends ${ext}`, ''];
        if (args.className) lines.splice(1, 0, `class_name ${args.className}`);
        if (args.methods && Array.isArray(args.methods)) {
          for (const m of args.methods) {
            lines.push('', `func ${m}():`);
            lines.push('\tpass');
          }
        }
        source = lines.join('\n') + '\n';
      }
      writeFileSync(fullPath, source, 'utf8');
      return { content: [{ type: 'text', text: `Script created at ${args.scriptPath}` }] };
    } catch (error: unknown) {
      return createErrorResponse(`create_script failed: ${errorMessage(error)}`);
    }
  }

  public async handleManageSceneSignals(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.action) return createErrorResponse('projectPath, scenePath, and action are required.');
    return this.sceneOperations.run('manage_scene_signals', args, {
      scenePath: args.scenePath, action: args.action,
      ...(args.signalName ? { signalName: args.signalName } : {}),
      ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
      ...(args.targetPath ? { targetPath: args.targetPath } : {}),
      ...(args.method ? { method: args.method } : {}),
    });
  }

  public async handleManageLayers(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const layerRegex = /layer_names\/([\w_]+)\/layer_(\d+)="([^"]+)"/g;
        const layers: unknown[] = [];
        let match;
        while ((match = layerRegex.exec(content)) !== null) {
          layers.push({ type: match[1], layer: parseInt(match[2]), name: match[3] });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ layers }, null, 2) }] };
      } else if (args.action === 'set') {
        if (!args.layerType || !args.layer || !args.name) return createErrorResponse('layerType, layer, and name are required for set.');
        const key = `layer_names/${args.layerType}/layer_${args.layer}`;
        const settingLine = `${key}="${args.name}"`;
        const existingRegex = new RegExp(`${key.replace(/\//g, '\\/')}="[^"]*"`);
        if (existingRegex.test(content)) {
          content = content.replace(existingRegex, settingLine);
        } else {
          if (!content.includes('[layer_names]')) content += '\n[layer_names]\n';
          content = content.replace('[layer_names]', `[layer_names]\n${settingLine}`);
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Layer set: ${settingLine}` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: unknown) {
      return createErrorResponse(`manage_layers failed: ${errorMessage(error)}`);
    }
  }

  public async handleManagePlugins(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const pluginRegex = /(\w+)\/enabled=true/g;
        const plugins: string[] = [];
        let match;
        while ((match = pluginRegex.exec(content)) !== null) {
          plugins.push(match[1]);
        }
        const addonsDir = join(args.projectPath, 'addons');
        const available: string[] = [];
        if (existsSync(addonsDir)) {
          const entries = readdirSync(addonsDir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) available.push(e.name);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify({ enabled: plugins, available }, null, 2) }] };
      } else if (args.action === 'enable' || args.action === 'disable') {
        if (!args.pluginName) return createErrorResponse('pluginName is required.');
        const key = `${args.pluginName}/enabled`;
        const val = args.action === 'enable' ? 'true' : 'false';
        const existingRegex = new RegExp(`${args.pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/enabled=\\w+`);
        if (existingRegex.test(content)) {
          content = content.replace(existingRegex, `${key}=${val}`);
        } else {
          if (!content.includes('[editor_plugins]')) content += '\n[editor_plugins]\n';
          content = content.replace('[editor_plugins]', `[editor_plugins]\n${key}=${val}`);
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Plugin ${args.pluginName} ${args.action}d.` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: unknown) {
      return createErrorResponse(`manage_plugins failed: ${errorMessage(error)}`);
    }
  }

  public async handleManageShader(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.shaderPath || !args.action) return createErrorResponse('projectPath, shaderPath, and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath) || !validatePath(args.shaderPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const fullPath = this.projectRelativePath(args.projectPath, args.shaderPath);
    try {
      if (args.action === 'read') {
        if (!existsSync(fullPath)) return createErrorResponse(`Shader not found: ${args.shaderPath}`);
        const source = readFileSync(fullPath, 'utf8');
        return { content: [{ type: 'text', text: source }] };
      } else if (args.action === 'create') {
        const dir = dirname(fullPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        let source = args.source;
        if (!source) {
          const type = args.shaderType || 'spatial';
          source = `shader_type ${type};\n\nvoid fragment() {\n\t// Called for every pixel the material is visible on.\n}\n`;
        }
        writeFileSync(fullPath, source, 'utf8');
        return { content: [{ type: 'text', text: `Shader created at ${args.shaderPath}` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: unknown) {
      return createErrorResponse(`manage_shader failed: ${errorMessage(error)}`);
    }
  }

  public async handleManageThemeResource(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.resourcePath || !args.action) return createErrorResponse('projectPath, resourcePath, and action are required.');
    return this.context.headlessOp('manage_theme_resource', args, a => ({
      projectPath: a.projectPath,
      params: { resourcePath: a.resourcePath, action: a.action, ...(a.properties ? { properties: a.properties } : {}) },
    }));
  }

  public async handleSetMainScene(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath) return createErrorResponse('projectPath and scenePath are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      const resPath = args.scenePath.startsWith('res://') ? args.scenePath : `res://${args.scenePath}`;
      const settingLine = `run/main_scene="${resPath}"`;
      const existingRegex = /run\/main_scene="[^"]*"/;
      if (existingRegex.test(content)) {
        content = content.replace(existingRegex, settingLine);
      } else {
        if (content.includes('[application]')) {
          content = content.replace('[application]', `[application]\n\n${settingLine}`);
        } else {
          content += `\n[application]\n\n${settingLine}\n`;
        }
      }
      writeFileSync(projectFile, content, 'utf8');
      return { content: [{ type: 'text', text: `Main scene set to ${resPath}` }] };
    } catch (error: unknown) {
      return createErrorResponse(`set_main_scene failed: ${errorMessage(error)}`);
    }
  }

  public async handleManageSceneStructure(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.action || !args.nodePath)
      return createErrorResponse('projectPath, scenePath, action, and nodePath are required.');
    return this.sceneOperations.run('manage_scene_structure', args, {
      scenePath: args.scenePath, action: args.action, nodePath: args.nodePath,
      ...(args.newName ? { newName: args.newName } : {}),
      ...(args.newParentPath ? { newParentPath: args.newParentPath } : {}),
    });
  }

  public async handleManageTranslations(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const match = /translations=PackedStringArray\(([^)]*)\)/.exec(content);
        const translations = match ? match[1].split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean) : [];
        return { content: [{ type: 'text', text: JSON.stringify({ translations }, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.translationPath) return createErrorResponse('translationPath is required.');
        const resPath = args.translationPath.startsWith('res://') ? args.translationPath : `res://${args.translationPath}`;
        const match = /translations=PackedStringArray\(([^)]*)\)/.exec(content);
        if (match) {
          const existing = match[1];
          const newVal = existing ? `${existing}, "${resPath}"` : `"${resPath}"`;
          content = content.replace(/translations=PackedStringArray\([^)]*\)/, `translations=PackedStringArray(${newVal})`);
        } else {
          if (!content.includes('[internationalization]')) content += '\n[internationalization]\n';
          content = content.replace('[internationalization]', `[internationalization]\n\ntranslations=PackedStringArray("${resPath}")`);
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Translation added: ${resPath}` }] };
      } else if (args.action === 'remove') {
        if (!args.translationPath) return createErrorResponse('translationPath is required.');
        const resPath = args.translationPath.startsWith('res://') ? args.translationPath : `res://${args.translationPath}`;
        content = content.replace(new RegExp(`,?\\s*"${resPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), '');
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Translation removed: ${resPath}` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: unknown) {
      return createErrorResponse(`manage_translations failed: ${errorMessage(error)}`);
    }
  }

  public async handleManageCiPipeline(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const workflowDir = join(args.projectPath, '.github', 'workflows');
    const workflowPath = join(workflowDir, 'godot-export.yml');
    try {
      if (args.action === 'read') {
        if (!existsSync(workflowPath)) return createErrorResponse('No workflow file found at .github/workflows/godot-export.yml');
        const content = readFileSync(workflowPath, 'utf8');
        return { content: [{ type: 'text', text: content }] };
      } else if (args.action === 'create') {
        if (!existsSync(workflowDir)) mkdirSync(workflowDir, { recursive: true });
        const godotVersion = args.godotVersion || '4.3-stable';
        const platforms = args.platforms || ['linux'];
        const exportSteps = platforms.map((p: string) => `      - name: Export ${p}\n        run: godot --headless --export-release "${p}" build/${p}/game`).join('\n');
        const workflow = `name: Godot Export\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs:\n  export:\n    runs-on: ubuntu-latest\n    container:\n      image: barichello/godot-ci:${godotVersion}\n    steps:\n      - uses: actions/checkout@v4\n      - name: Setup export templates\n        run: |\n          mkdir -p ~/.local/share/godot/export_templates/${godotVersion}\n          mv /root/.local/share/godot/export_templates/${godotVersion}/* ~/.local/share/godot/export_templates/${godotVersion}/ || true\n${exportSteps}\n      - uses: actions/upload-artifact@v4\n        with:\n          name: game-builds\n          path: build/\n`;
        writeFileSync(workflowPath, workflow, 'utf8');
        return { content: [{ type: 'text', text: `CI pipeline created at .github/workflows/godot-export.yml for platforms: ${platforms.join(', ')}` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: unknown) {
      return createErrorResponse(`manage_ci_pipeline failed: ${errorMessage(error)}`);
    }
  }

  public async handleManageDockerExport(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const dockerfilePath = join(args.projectPath, 'Dockerfile');
    try {
      if (args.action === 'read') {
        if (!existsSync(dockerfilePath)) return createErrorResponse('No Dockerfile found in project root.');
        const content = readFileSync(dockerfilePath, 'utf8');
        return { content: [{ type: 'text', text: content }] };
      } else if (args.action === 'create') {
        const godotVersion = args.godotVersion || '4.3-stable';
        const baseImage = args.baseImage || 'ubuntu:22.04';
        const exportPreset = args.exportPreset || 'Linux/X11';
        const dockerfile = `FROM ${baseImage}\n\nARG GODOT_VERSION=${godotVersion}\n\nRUN apt-get update && apt-get install -y \\\n    wget unzip ca-certificates \\\n    && rm -rf /var/lib/apt/lists/*\n\nRUN wget -q https://github.com/godotengine/godot/releases/download/\${GODOT_VERSION}/Godot_v\${GODOT_VERSION}_linux.x86_64.zip \\\n    && unzip Godot_v\${GODOT_VERSION}_linux.x86_64.zip \\\n    && mv Godot_v\${GODOT_VERSION}_linux.x86_64 /usr/local/bin/godot \\\n    && rm Godot_v\${GODOT_VERSION}_linux.x86_64.zip\n\nRUN wget -q https://github.com/godotengine/godot/releases/download/\${GODOT_VERSION}/Godot_v\${GODOT_VERSION}_export_templates.tpz \\\n    && mkdir -p /root/.local/share/godot/export_templates/\${GODOT_VERSION} \\\n    && unzip Godot_v\${GODOT_VERSION}_export_templates.tpz \\\n    && mv templates/* /root/.local/share/godot/export_templates/\${GODOT_VERSION}/ \\\n    && rm -rf templates Godot_v\${GODOT_VERSION}_export_templates.tpz\n\nWORKDIR /game\nCOPY . .\n\nRUN mkdir -p build\nCMD ["godot", "--headless", "--export-release", "${exportPreset}", "build/game"]\n`;
        writeFileSync(dockerfilePath, dockerfile, 'utf8');
        return { content: [{ type: 'text', text: `Dockerfile created for headless Godot export (preset: ${exportPreset})` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: unknown) {
      return createErrorResponse(`manage_docker_export failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Handle the update_project_uids tool
   */

  public async handleUpdateProjectUids(args: ToolArguments) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }

    if (!this.context.pathSecurity.isProjectPathAllowed(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path'
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

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.context.getGodotPath()!, ['--version'], GODOT_VERSION_OPTIONS);
      const version = versionOutput.trim();

      if (!isGodot44OrLater(version)) {
        return createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.context.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to update project UIDs: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(
        `Failed to update project UIDs: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Run the MCP server
   */
}
