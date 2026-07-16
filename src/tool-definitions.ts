import { toolManifest } from './tool-manifest.js';
import { structuredResultSchemaFor } from './tool-output-schema.js';

const WAIT_CONDITION_FIELDS = ['nodePath', 'property', 'value', 'signal', 'text', 'scenePath'] as const;
const SCENARIO_INPUT_TOOLS = [
  'game_key_press', 'game_key_hold', 'game_key_release', 'game_click', 'game_mouse_move',
  'game_scroll', 'game_mouse_drag', 'game_gamepad', 'game_input_action',
] as const;
const SCENARIO_OBSERVE_TOOLS = [
  'game_get_scene_tree', 'game_get_ui', 'game_get_node_info', 'game_get_property',
  'game_get_errors', 'game_get_logs', 'game_get_camera', 'game_get_audio', 'game_performance',
] as const;

export interface ToolSchemaInvalidExample {
  value: unknown;
  path: string;
  keyword: string;
  action?: string;
}

export interface ToolPropertySchema {
  $schema?: string;
  $defs?: Record<string, ToolPropertySchema>;
  $ref?: string;
  type?: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
  description?: string;
  enum?: readonly unknown[];
  const?: unknown;
  examples?: readonly unknown[];
  'x-invalidExamples'?: readonly ToolSchemaInvalidExample[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  oneOf?: readonly ToolPropertySchema[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: ToolPropertySchema;
  properties?: Record<string, ToolPropertySchema>;
  required?: readonly string[];
  additionalProperties?: boolean | ToolPropertySchema;
  allOf?: readonly ToolPropertySchema[];
  anyOf?: readonly ToolPropertySchema[];
  not?: ToolPropertySchema;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: ToolPropertySchema;
  outputSchema?: ToolPropertySchema;
  annotations?: ToolAnnotations;
}

const rawToolDefinitions = [
{
  name: 'godot_catalog',
  description: 'Search or inspect the complete Godot tool catalog without executing a tool',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'describe'], description: 'Read-only catalog action' },
      query: { type: 'string', maxLength: 200, description: 'User intent, Godot concept, action, or tool-name search text' },
      toolName: {
        type: 'string',
        pattern: '^[a-z][a-z0-9_]*$',
        description: 'Required for describe. The field name is exactly toolName, not name, tool, or query.',
        examples: ['verify_export_readiness'],
      },
      detail: { type: 'string', enum: ['summary', 'schema', 'full'], description: 'Description detail. Default: summary' },
      domain: { type: 'string', enum: ['lifecycle', 'project', 'game'], description: 'Optional owning-domain filter' },
      backend: { type: 'string', enum: ['process', 'subprocess', 'authoring-session', 'runtime', 'runtime-buffer', 'godot-cli', 'local'], description: 'Optional execution-backend filter' },
      effect: { type: 'string', enum: ['read-only', 'project-persistent', 'runtime-ephemeral', 'process', 'external-open-world'], description: 'Optional effect-scope filter' },
      state: { type: 'string', enum: ['none', 'project', 'editor', 'runtime'], description: 'Optional required-state filter' },
      privilege: { type: 'string', enum: ['none', 'required'], description: 'Optional privilege filter' },
      mutation: { type: 'string', enum: ['read-only', 'mutating', 'mixed'], description: 'Optional mutation-behavior filter' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum ranked search results. Default: 20' },
    },
    required: ['action'],
  },
},
{
  name: 'godot_call',
  description: 'Execute one named hidden Godot tool after inspecting it with godot_catalog',
  inputSchema: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        pattern: '^[a-z][a-z0-9_]*$',
        description: 'Required hidden tool name. The field name is exactly toolName; dispatchers cannot be nested recursively.',
        examples: ['verify_export_readiness'],
      },
      arguments: { type: 'object', description: 'Arguments validated against the selected tool schema before policy and dispatch' },
    },
    required: ['toolName'],
  },
},
{
  name: 'godot_tools',
  description: 'Deprecated compatibility alias for godot_catalog and godot_call',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'describe', 'call'], description: 'Discovery or dispatch action' },
      query: { type: 'string', maxLength: 200, description: 'Name/description/action search text' },
      domain: { type: 'string', enum: ['lifecycle', 'project', 'game'], description: 'Optional domain filter' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum search results. Default: 20' },
      toolName: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: 'Tool to describe or call' },
      arguments: { type: 'object', description: 'Arguments passed to the selected tool' },
    },
    required: ['action'],
  },
},
{
  name: 'launch_editor',
  description: 'Attach to an existing matching editor or launch one when needed',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
    },
    required: ['projectPath'],
  },
},
{
  name: 'editor_session',
  description: 'Discover, attach, inspect, or disconnect a per-project Godot editor session',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', enum: ['ensure', 'status', 'disconnect'], description: 'Session action' },
      launchIfNeeded: { type: 'boolean', description: 'For ensure, launch an editor only after discovery finds none. Default: false' },
      timeoutSeconds: { type: 'number', minimum: 0, maximum: 30, description: 'Bounded discovery/attach wait. Default: 2' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'editor_control',
  description: 'Inspect and edit open scenes through an authenticated editor bridge',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path whose editor is open' },
      action: { type: 'string', enum: ['inspect', 'select', 'save', 'reload', 'open_scene', 'set_property', 'rename_node', 'undo', 'redo'], description: 'Editor action' },
      nodePaths: { type: 'array', items: { type: 'string' }, maxItems: 128, description: 'Scene-relative node paths for select' },
      scenePath: { type: 'string', description: 'Project-relative or res:// scene path' },
      nodePath: { type: 'string', description: 'Scene-relative node path' },
      property: { type: 'string', description: 'Property to edit' },
      value: { description: 'New property value' },
      name: { type: 'string', minLength: 1, maxLength: 128, description: 'New node name' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'editor_transaction',
  description: 'Apply one validated compound scene edit as one editor undo step',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path whose editor is attached' },
      scenePath: { type: 'string', description: 'Project-relative or res:// scene path' },
      name: { type: 'string', minLength: 1, maxLength: 128, description: 'Human-readable undo action name' },
      rootType: { type: 'string', maxLength: 128, description: 'Root node type when creating a missing scene' },
      operations: {
        type: 'array', minItems: 1, maxItems: 256, description: 'Ordered editor-native scene operations',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add_node', 'remove_node', 'rename_node', 'duplicate_node', 'reparent_node', 'set_properties', 'instantiate_scene', 'attach_script', 'assign_resource', 'save'], description: 'Discriminator selecting one editor-native operation shape' },
            nodePath: { type: 'string', description: 'Existing or previously staged scene-relative node path' },
            parentPath: { type: 'string', description: 'Parent path for a new or instantiated node. Default: scene root' },
            newParentPath: { type: 'string', description: 'Destination parent for reparent_node' },
            nodeType: { type: 'string', description: 'Godot class name for add_node' },
            nodeName: { type: 'string', description: 'Unique child name for add_node or instantiation' },
            name: { type: 'string', description: 'New node name for rename_node' },
            properties: { type: 'object', description: 'Free-form Godot property dictionary for add_node or set_properties' },
            property: { type: 'string', description: 'Target property name for assign_resource' },
            value: { description: 'Canonical Godot Variant value for a single property' },
            scenePath: { type: 'string', description: 'Project resource path for instantiate_scene' },
            scriptPath: { type: 'string', description: 'Project resource path for attach_script' },
            resourcePath: { type: 'string', description: 'Project resource path for assign_resource' },
            keepGlobalTransform: { type: 'boolean', description: 'Preserve the global transform during reparent_node. Default: true' },
          },
          required: ['op'],
        },
      },
      focusPath: { type: 'string', description: 'Node to reveal after commit' },
      save: { type: 'boolean', description: 'Save and independently reopen/read the scene. Default: true' },
    },
    required: ['projectPath', 'scenePath', 'name', 'operations'],
  },
},
{
  name: 'run_project',
  description: 'Run the Godot project and capture output',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scene: {
        type: 'string',
        description: 'Optional: Specific scene to run',
      },
      timingMode: {
        type: 'string', enum: ['realtime', 'deterministic'],
        description: 'realtime follows display/VSync; deterministic uses fixed 60 FPS. Default: realtime',
      },
    },
    required: ['projectPath'],
  },
},
{
  name: 'verify_project',
  description: 'Run bounded assertions and capture evidence with deterministic teardown',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      scene: { type: 'string', description: 'Optional scene to run' },
      waitFrames: { type: 'integer', minimum: 1, maximum: 600, description: 'Frames to wait before assertions. Default: 2' },
      assertions: {
        type: 'array',
        maxItems: 32,
        description: 'Bounded assertions evaluated against the running game',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['node_exists', 'group_count', 'log_contains'], description: 'Assertion kind' },
            nodePath: { type: 'string', description: 'Node path for node_exists' },
            group: { type: 'string', description: 'Group name for group_count' },
            count: { type: 'integer', minimum: 0, description: 'Expected group member count' },
            text: { type: 'string', description: 'Required output substring for log_contains' },
          },
          required: ['kind'],
        },
      },
      captureScreenshot: { type: 'boolean', description: 'Capture a screenshot and return its SHA-256 digest. Default: false' },
      teardown: { type: 'boolean', description: 'Stop the project after verification. Default: true' },
    },
    required: ['projectPath'],
  },
},
{
  name: 'run_project_tests',
  description: 'Discover or run native, GUT, and GdUnit4 project tests with structured results',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', enum: ['discover', 'run'], description: 'Discover tests or run them' },
      framework: { type: 'string', enum: ['auto', 'native', 'gut', 'gdunit4'], description: 'Test framework. Default: auto' },
      testPaths: { type: 'array', items: { type: 'string' }, maxItems: 64, description: 'Project-relative test files or directories' },
      artifactPaths: { type: 'array', items: { type: 'string' }, maxItems: 32, description: 'Project-relative report files to return as artifact metadata' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 300, description: 'Per-run timeout. Default: 60' },
      failFast: { type: 'boolean', description: 'Stop native execution after the first failed file. Default: false' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'manage_import_pipeline',
  description: 'Inspect, change, reimport, and trace imported Godot source assets',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', enum: ['inspect', 'change', 'reimport', 'dependencies'], description: 'Import workflow action' },
      sourcePath: { type: 'string', description: 'Project-relative source asset path' },
      settings: { type: 'object', description: 'Importer parameter values for change (string, number, or boolean)' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 300, description: 'Reimport timeout. Default: 120' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'analyze_project_integrity',
  description: 'Analyze dependencies and integrity or preview a safe resource rename',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: {
        type: 'string',
        enum: ['analyze', 'preview_rename', 'assets', 'localization', 'accessibility', 'extensions', 'leaks'],
        description: 'Analysis action. Static audits are bounded and read-only; leaks reports runtime-independent orphan candidates.',
      },
      sourcePath: { type: 'string', description: 'Existing project-relative path for rename preview' },
      destinationPath: { type: 'string', description: 'Proposed project-relative rename destination' },
      maxFiles: { type: 'integer', minimum: 1, maximum: 50000, description: 'Resource scan limit. Default: 10000' },
      allowProceduralMainScene: { type: 'boolean', description: 'Suppress the trivial-main-scene warning when procedural construction is an explicit design requirement. Default: false' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'verify_export_readiness',
  description: 'Validate presets/templates, export, inspect artifacts, and smoke-run builds',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', enum: ['inspect', 'export_smoke'], description: 'Inspect readiness or export and smoke-run' },
      presetName: { type: 'string', description: 'Export preset name' },
      outputPath: { type: 'string', description: 'Project-relative or allowed absolute export artifact path' },
      debug: { type: 'boolean', description: 'Use debug export/templates. Default: false' },
      smoke: { type: 'boolean', description: 'Smoke-run supported local outputs. Default: true' },
      expectedOutput: { type: 'string', maxLength: 4096, description: 'Required smoke-run output substring' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 600, description: 'Export timeout. Default: 120' },
      smokeTimeoutSeconds: { type: 'number', minimum: 1, maximum: 60, description: 'Smoke runtime before quit. Default: 5' },
    },
    required: ['projectPath', 'action', 'presetName'],
  },
},
{
  name: 'verify_dotnet_project',
  description: 'Inspect, restore, build, and run a project with the matching Godot.NET.Sdk',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot .NET project path' },
      action: { type: 'string', enum: ['inspect', 'restore', 'build', 'run'], description: '.NET workflow action' },
      csprojPath: { type: 'string', description: 'Project-relative .csproj path; auto-detected when unique' },
      configuration: { type: 'string', enum: ['Debug', 'Release'], description: 'Build configuration. Default: Debug' },
      expectedOutput: { type: 'string', maxLength: 4096, description: 'Required game-run output substring' },
      timeoutSeconds: { type: 'number', minimum: 1, maximum: 600, description: 'Restore/build timeout. Default: 120' },
      runTimeoutSeconds: { type: 'number', minimum: 1, maximum: 60, description: 'Game runtime before quit. Default: 5' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'manage_addon',
  description: 'Install and manage hash-pinned local EditorPlugins with reload validation',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', enum: ['inspect', 'install', 'update', 'remove', 'enable', 'disable'], description: 'Add-on lifecycle action' },
      pluginName: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,80}$', description: 'Target addons directory name' },
      sourcePath: { type: 'string', description: 'Allowed local source directory for install/update' },
      expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'Required deterministic source-tree SHA-256 pin' },
      enable: { type: 'boolean', description: 'Enable after install/update. Default: false' },
      expectedOutput: { type: 'string', maxLength: 4096, description: 'Required editor reload output substring' },
    },
    required: ['projectPath', 'action', 'pluginName'],
  },
},
{
  name: 'get_debug_output',
  description: 'Get the current debug output and errors',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
{
  name: 'stop_project',
  description: 'Stop the currently running Godot project',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
{
  name: 'get_godot_version',
  description: 'Get the installed Godot version',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
{
  name: 'list_projects',
  description: 'List Godot projects in a directory',
  inputSchema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Directory to search for Godot projects',
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to search recursively (default: false)',
      },
    },
    required: ['directory'],
  },
},
{
  name: 'get_project_info',
  description: 'Retrieve metadata about a Godot project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
    },
    required: ['projectPath'],
  },
},
{
  name: 'create_scene',
  description: 'Create a new Godot scene file',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scenePath: {
        type: 'string',
        description: 'Path where the scene file will be saved (relative to project)',
      },
      rootNodeType: {
        type: 'string',
        description: 'Type of the root node (e.g., Node2D, Node3D)',
      },
    },
    required: ['projectPath', 'scenePath'],
  },
},
{
  name: 'add_node',
  description: 'Add a node to an existing scene',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scenePath: {
        type: 'string',
        description: 'Scene file path (relative to project)',
      },
      parentNodePath: {
        type: 'string',
        description: 'Path to the parent node (e.g., "root" or "root/Player")',
      },
      nodeType: {
        type: 'string',
        description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
      },
      nodeName: {
        type: 'string',
        description: 'Name for the new node',
      },
      properties: {
        type: 'object',
        description: 'Optional properties to set on the node',
      },
    },
    required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
  },
},
{
  name: 'load_sprite',
  description: 'Load a sprite into a Sprite2D node',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scenePath: {
        type: 'string',
        description: 'Scene file path (relative to project)',
      },
      nodePath: {
        type: 'string',
        description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
      },
      texturePath: {
        type: 'string',
        description: 'Path to the texture file (relative to project)',
      },
    },
    required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
  },
},
{
  name: 'export_mesh_library',
  description: 'Export a scene as a MeshLibrary resource',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scenePath: {
        type: 'string',
        description: 'Path to the scene file (.tscn) to export',
      },
      outputPath: {
        type: 'string',
        description: 'Path where the mesh library (.res) will be saved',
      },
      meshItemNames: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Optional: Names of specific mesh items to include (defaults to all)',
      },
    },
    required: ['projectPath', 'scenePath', 'outputPath'],
  },
},
{
  name: 'save_scene',
  description: 'Save changes to a scene file',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scenePath: {
        type: 'string',
        description: 'Scene file path (relative to project)',
      },
      newPath: {
        type: 'string',
        description: 'Optional: New path to save the scene to (for creating variants)',
      },
    },
    required: ['projectPath', 'scenePath'],
  },
},
{
  name: 'get_uid',
  description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      filePath: {
        type: 'string',
        description: 'Path to the file (relative to project) for which to get the UID',
      },
    },
    required: ['projectPath', 'filePath'],
  },
},
{
  name: 'update_project_uids',
  description: 'Update UID references by resaving resources (4.4+)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
    },
    required: ['projectPath'],
  },
},
{
  name: 'game_screenshot',
  description: 'Capture a PNG preview with dimensions, digest, and optional temp artifact',
  inputSchema: {
    type: 'object',
    properties: {
      retainArtifact: { type: 'boolean', description: 'Retain a PNG in the system temp artifact directory. Default: false' },
    },
    required: [],
  },
},
{
  name: 'game_visual_regression',
  description: 'Capture or compare rendered PNGs with tolerances, masks, and diff artifacts',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['capture_baseline', 'compare'], description: 'Capture a baseline or compare the current frame' },
      baselinePath: { type: 'string', description: 'Project-relative baseline PNG path' },
      maskPath: { type: 'string', description: 'Optional PNG mask; transparent pixels are ignored' },
      diffArtifactPath: { type: 'string', description: 'Optional project-relative output PNG for retained diff evidence' },
      channelTolerance: { type: 'integer', minimum: 0, maximum: 255, description: 'Maximum per-channel delta. Default: 0' },
      maxDifferentPixelRatio: { type: 'number', minimum: 0, maximum: 1, description: 'Allowed different-pixel ratio. Default: 0' },
    },
    required: ['action', 'baselinePath'],
  },
},
{
  name: 'game_click',
  description: 'Click at a position in the running Godot game window',
  inputSchema: {
    type: 'object',
    properties: {
      x: {
        type: 'number',
        description: 'X coordinate to click',
      },
      y: {
        type: 'number',
        description: 'Y coordinate to click',
      },
      button: {
        type: 'integer',
        description: 'Mouse button (1=left, 2=right, 3=middle). Default: 1',
      },
    },
    required: ['x', 'y'],
  },
},
{
  name: 'game_key_press',
  description: 'Tap a key or input action for one frame; use game_key_hold plus game_key_release for continuous input',
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Key name (e.g. "W", "Space", "Escape", "Enter")',
      },
      action: {
        type: 'string',
        description: 'Godot input action name (e.g. "move_forward", "ui_accept")',
      },
      pressed: {
        type: 'boolean',
        description: 'Press (true) or release (false). Default: true (auto-release)',
      },
      text: { type: 'string', minLength: 1, maxLength: 256, description: 'Unicode text to inject instead of a named key/action' },
      physical: { type: 'boolean', description: 'Treat key as a physical key location' },
      shift: { type: 'boolean', description: 'Shift modifier' },
      ctrl: { type: 'boolean', description: 'Ctrl modifier' },
      alt: { type: 'boolean', description: 'Alt modifier' },
      meta: { type: 'boolean', description: 'Meta/Command modifier' },
    },
    required: [],
  },
},
{
  name: 'game_mouse_move',
  description: 'Move the mouse in the running Godot game',
  inputSchema: {
    type: 'object',
    properties: {
      x: {
        type: 'number',
        description: 'Absolute X position',
      },
      y: {
        type: 'number',
        description: 'Absolute Y position',
      },
      relative_x: {
        type: 'number',
        description: 'Relative X movement',
      },
      relative_y: {
        type: 'number',
        description: 'Relative Y movement',
      },
    },
    required: ['x', 'y'],
  },
},
{
  name: 'game_get_ui',
  description: 'Get visible UI elements from the running game',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
{
  name: 'game_get_scene_tree',
  description: 'Get scene tree structure of the running game',
  inputSchema: {
    type: 'object',
    properties: {
      maxNodes: { type: 'integer', minimum: 1, maximum: 10000, description: 'Maximum nodes returned in deterministic pre-order. Default: 1000' },
    },
    required: [],
  },
},
{
  name: 'game_eval',
  description: 'Execute GDScript in the running game. Use "return" for values.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'GDScript code to execute. Use "return" to return values.',
      },
    },
    required: ['code'],
  },
},
{
  name: 'game_get_property',
  description: 'Get a property value from any node in the running game by its path',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: {
        type: 'string',
        description: 'Path to the node (e.g., "/root/Player", "/root/Main/Enemy")',
      },
      property: {
        type: 'string',
        description: 'Property name to get (e.g., "position", "health", "visible")',
      },
    },
    required: ['nodePath', 'property'],
  },
},
{
  name: 'game_set_property',
  description: 'Set a property on a node in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: {
        type: 'string',
        description: 'Path to the node',
      },
      property: {
        type: 'string',
        description: 'Property name to set',
      },
      value: {
        description: 'Value to set. Use objects for vectors/colors',
      },
      typeHint: {
        type: 'string',
        description: 'Optional type hint: "Vector2", "Vector3", "Color"',
      },
    },
    required: ['nodePath', 'property', 'value'],
  },
},
{
  name: 'game_call_method',
  description: 'Call a method on any node in the running game with optional arguments',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: {
        type: 'string',
        description: 'Path to the node',
      },
      method: {
        type: 'string',
        description: 'Method name to call',
      },
      args: {
        type: 'array',
        description: 'Optional array of arguments to pass to the method',
      },
    },
    required: ['nodePath', 'method'],
  },
},
{
  name: 'game_get_node_info',
  description: 'Get node info: class, properties, signals, methods, children',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: {
        type: 'string',
        description: 'Path to the node (e.g., "/root/Player")',
      },
    },
    required: ['nodePath'],
  },
},
{
  name: 'game_instantiate_scene',
  description: 'Load a PackedScene and add it as a child of a node in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      scenePath: {
        type: 'string',
        description: 'Resource path to the scene (e.g., "res://scenes/enemy.tscn")',
      },
      parentPath: {
        type: 'string',
        description: 'Path to the parent node. Default: "/root"',
      },
    },
    required: ['scenePath'],
  },
},
{
  name: 'game_remove_node',
  description: 'Remove and free a node from the running game\'s scene tree',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: {
        type: 'string',
        description: 'Path to the node to remove',
      },
    },
    required: ['nodePath'],
  },
},
{
  name: 'game_change_scene',
  description: 'Switch to a different scene file in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      scenePath: {
        type: 'string',
        description: 'Resource path to the scene (e.g., "res://scenes/levels/level2.tscn")',
      },
    },
    required: ['scenePath'],
  },
},
{
  name: 'game_pause',
  description: 'Pause or unpause the running game',
  inputSchema: {
    type: 'object',
    properties: {
      paused: {
        type: 'boolean',
        description: 'True to pause, false to unpause. Default: true',
      },
    },
    required: [],
  },
},
{
  name: 'game_performance',
  description: 'Sample live performance metrics or run a bounded profiler session',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['sample', 'start', 'stop', 'report', 'stress', 'leaks'], description: 'Profiler action. Default: sample' },
      sampleCount: { type: 'integer', minimum: 1, maximum: 120, description: 'Number of samples for a bounded session. Default: 1' },
    },
    required: [],
  },
},
{
  name: 'game_wait',
  description: 'Wait N frames in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      frames: {
        type: 'integer',
        description: 'Positive integer number of frames to wait. Default: 1',
      },
      frameType: {
        type: 'string',
        enum: ['render', 'physics'],
        description: 'Frame to wait on: "physics" (fixed 60Hz ticks) or "render". Default: render',
      },
    },
    required: [],
  },
},
{
  name: 'game_wait_until',
  description: 'Wait once for a bounded runtime condition and return the last observation',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path for trace correlation' },
      condition: { type: 'string', enum: ['connection', 'node', 'property', 'signal', 'log', 'scene'], description: 'Condition kind' },
      nodePath: { type: 'string', description: 'Runtime node path for node, property, or signal conditions' },
      property: { type: 'string', description: 'Property name for a property condition' },
      value: { description: 'Expected canonical Godot Variant value for a property condition' },
      signal: { type: 'string', description: 'Signal name for a signal condition' },
      text: { type: 'string', maxLength: 1000, description: 'Required bounded substring for a log condition' },
      scenePath: { type: 'string', description: 'Expected current scene resource path for a scene condition' },
      timeoutSeconds: { type: 'number', minimum: 0.05, maximum: 60, description: 'Maximum wait. Default: 10' },
      pollIntervalMs: { type: 'integer', minimum: 20, maximum: 1000, description: 'Internal poll interval. Default: 100' },
    },
    required: ['condition'],
  },
},
{
  name: 'game_scenario',
  description: 'Run bounded input, wait, assertion, screenshot, and performance steps',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path for trace correlation' },
      name: { type: 'string', minLength: 1, maxLength: 128, description: 'Human-readable scenario and parent trace name' },
      timeoutSeconds: { type: 'number', minimum: 0.1, maximum: 120, description: 'Whole scenario timeout. Default: 60' },
      steps: {
        type: 'array', minItems: 1, maxItems: 100, description: 'Bounded ordered scenario steps',
        items: {
          type: 'object', description: 'One discriminated scenario step',
          properties: {
            type: { type: 'string', enum: ['input', 'wait', 'observe', 'assert', 'screenshot', 'performance'], description: 'Scenario step discriminator' },
            tool: { type: 'string', description: 'Allowlisted runtime tool for input or observation' },
            arguments: { type: 'object', description: 'Arguments validated against the selected scenario tool' },
            condition: { type: 'object', description: 'game_wait_until-compatible condition for wait or assert' },
            label: { type: 'string', maxLength: 200, description: 'Optional evidence label' },
          },
          required: ['type'],
        },
      },
    },
    required: ['name', 'steps'],
  },
},
{
  name: 'read_scene',
  description: 'Read a saved scene with legacy, compact, authored, or full detail',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scenePath: {
        type: 'string',
        description: 'Scene file path (relative to project)',
      },
      detail: { type: 'string', enum: ['compact', 'authored', 'full'], description: 'Explicit detail mode; omitted preserves legacy full-tree behavior' },
      nodePath: { type: 'string', description: 'Optional scene-relative subtree path, using names separated by /' },
      propertyNames: { type: 'array', items: { type: 'string', description: 'Exact property name' }, maxItems: 128, description: 'Optional property allowlist' },
      maxDepth: { type: 'integer', minimum: 0, maximum: 64, description: 'Maximum child depth below the selected node' },
      authoredOnly: { type: 'boolean', description: 'Return authored storage properties only. Default: true for authored mode' },
      includeResources: { type: 'boolean', description: 'Include resource-valued properties. Default: false for compact, true otherwise' },
      includeDefaults: { type: 'boolean', description: 'Include properties whose values still match their defaults' },
      responseLimit: { type: 'integer', minimum: 1024, maximum: 1048576, description: 'Explicit serialized response byte limit with truncation metadata' },
    },
    required: ['projectPath', 'scenePath'],
  },
},
{
  name: 'modify_scene_node',
  description: 'Modify node properties in a scene file (headless)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scenePath: {
        type: 'string',
        description: 'Scene file path (relative to project)',
      },
      nodePath: {
        type: 'string',
        description: 'Path to the node within the scene (e.g., "root/Player/Sprite2D")',
      },
      properties: {
        type: 'object',
        description: 'Properties to set on the node as key-value pairs',
      },
    },
    required: ['projectPath', 'scenePath', 'nodePath', 'properties'],
  },
},
{
  name: 'remove_scene_node',
  description: 'Remove a node from a scene file (headless)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      scenePath: {
        type: 'string',
        description: 'Scene file path (relative to project)',
      },
      nodePath: {
        type: 'string',
        description: 'Path to the node to remove (e.g., "root/Player/OldNode")',
      },
    },
    required: ['projectPath', 'scenePath', 'nodePath'],
  },
},
{
  name: 'read_project_settings',
  description: 'Read project.godot as structured JSON',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
    },
    required: ['projectPath'],
  },
},
{
  name: 'modify_project_settings',
  description: 'Modify a project.godot setting',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      section: {
        type: 'string',
        description: 'Section in project.godot (e.g., "application", "display", "rendering")',
      },
      key: {
        type: 'string',
        description: 'Setting key (e.g., "run/main_scene", "window/size/viewport_width")',
      },
      value: {
        type: 'string',
        description: 'Value to set (as a string, will be written as-is)',
      },
    },
    required: ['projectPath', 'section', 'key', 'value'],
  },
},
{
  name: 'list_project_files',
  description: 'List project files, optionally filtered by extension',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Godot project path',
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional file extensions to filter by (e.g., [".gd", ".tscn"]). Include the dot.',
      },
      subdirectory: {
        type: 'string',
        description: 'Optional subdirectory to search in (e.g., "scripts/player")',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
        description: 'Maximum files returned per page. Default: 1000',
      },
      cursor: {
        type: 'integer',
        minimum: 0,
        description: 'Zero-based cursor from a previous response. Default: 0',
      },
    },
    required: ['projectPath'],
  },
},
{
  name: 'game_connect_signal',
  description: 'Connect a signal from one node to a method on another node in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the source node that emits the signal' },
      signalName: { type: 'string', description: 'Name of the signal to connect' },
      targetPath: { type: 'string', description: 'Path to the target node that receives the signal' },
      method: { type: 'string', description: 'Method name to call on the target node' },
      binds: { type: 'array', description: 'Optional arguments appended after emitted signal arguments' },
      deferred: { type: 'boolean', description: 'Deliver the callable at the end of the current frame' },
      oneShot: { type: 'boolean', description: 'Disconnect automatically after the first delivery' },
      referenceCounted: { type: 'boolean', description: 'Allow duplicate connections using Godot reference counting' },
    },
    required: ['nodePath', 'signalName', 'targetPath', 'method'],
  },
},
{
  name: 'game_disconnect_signal',
  description: 'Disconnect a signal connection in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the source node' },
      signalName: { type: 'string', description: 'Name of the signal' },
      targetPath: { type: 'string', description: 'Path to the target node' },
      method: { type: 'string', description: 'Method name on the target' },
      binds: { type: 'array', description: 'Bound arguments used when the connection was created' },
    },
    required: ['nodePath', 'signalName', 'targetPath', 'method'],
  },
},
{
  name: 'game_emit_signal',
  description: 'Emit a signal on a node in the running game, optionally with arguments',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node' },
      signalName: { type: 'string', description: 'Name of the signal to emit' },
      args: { type: 'array', description: 'Optional arguments to pass with the signal' },
    },
    required: ['nodePath', 'signalName'],
  },
},
{
  name: 'game_play_animation',
  description: 'Control an AnimationPlayer node: play, stop, pause, or list animations',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the AnimationPlayer node' },
      action: { type: 'string', enum: ['play', 'stop', 'pause', 'get_list'], description: 'Playback action. Default: play' },
      animation: { type: 'string', description: 'Animation name (required for "play" action)' },
    },
    required: ['nodePath'],
  },
},
{
  name: 'game_tween_property',
  description: 'Tween a node property in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node' },
      property: { type: 'string', description: 'Property to tween (e.g., "position", "modulate")' },
      finalValue: { description: 'Target value. Use {x,y} for Vector2, {x,y,z} for Vector3, {r,g,b,a} for Color' },
      duration: { type: 'number', minimum: 0.001, description: 'Duration in seconds. Default: 1.0' },
      transType: { type: 'integer', minimum: 0, maximum: 11, description: 'Tween.TransitionType enum value. Default: 0 (LINEAR)' },
      easeType: { type: 'integer', minimum: 0, maximum: 3, description: 'Tween.EaseType enum value. Default: 2 (IN_OUT)' },
    },
    required: ['nodePath', 'property', 'finalValue'],
  },
},
{
  name: 'game_get_nodes_in_group',
  description: 'Get all nodes belonging to a specific group in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      group: { type: 'string', description: 'Group name (e.g., "enemies", "player", "checkpoints")' },
    },
    required: ['group'],
  },
},
{
  name: 'game_find_nodes_by_class',
  description: 'Find all nodes of a specific class type in the running game',
  inputSchema: {
    type: 'object',
    properties: {
      className: { type: 'string', description: 'Class name to search for (e.g., "CharacterBody3D", "Light3D")' },
      rootPath: { type: 'string', description: 'Root node path to start searching from. Default: "/root"' },
    },
    required: ['className'],
  },
},
{
  name: 'game_reparent_node',
  description: 'Move a node to a new parent in the running game\'s scene tree',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node to move' },
      newParentPath: { type: 'string', description: 'Path to the new parent node' },
      keepGlobalTransform: { type: 'boolean', description: 'Whether to keep the global transform. Default: true' },
    },
    required: ['nodePath', 'newParentPath'],
  },
},
{
  name: 'attach_script',
  description: 'Attach a GDScript to a scene node (headless)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      scenePath: { type: 'string', description: 'Scene file path (relative to project)' },
      nodePath: { type: 'string', description: 'Path to the node within the scene (e.g., "root/Player")' },
      scriptPath: { type: 'string', description: 'Path to the .gd script file (relative to project)' },
    },
    required: ['projectPath', 'scenePath', 'nodePath', 'scriptPath'],
  },
},
{
  name: 'create_resource',
  description: 'Create a .tres resource file (headless)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      resourceType: { type: 'string', description: 'Godot class name (e.g., "StandardMaterial3D", "Theme", "Environment")' },
      resourcePath: { type: 'string', description: 'Where to save the .tres file (relative to project)' },
      properties: { type: 'object', description: 'Optional properties to set on the resource' },
    },
    required: ['projectPath', 'resourceType', 'resourcePath'],
  },
},
// File I/O tools
{
  name: 'read_file',
  description: 'Read a text file from a Godot project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      filePath: { type: 'string', description: 'File path relative to project root' },
    },
    required: ['projectPath', 'filePath'],
  },
},
{
  name: 'write_file',
  description: 'Create or overwrite a text file in a Godot project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      filePath: { type: 'string', description: 'File path relative to project root' },
      content: { type: 'string', description: 'File content to write' },
    },
    required: ['projectPath', 'filePath', 'content'],
  },
},
{
  name: 'delete_file',
  description: 'Delete a file from a Godot project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      filePath: { type: 'string', description: 'File path relative to project root' },
    },
    required: ['projectPath', 'filePath'],
  },
},
{
  name: 'create_directory',
  description: 'Create a directory inside a Godot project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      directoryPath: { type: 'string', description: 'Directory path relative to project root' },
    },
    required: ['projectPath', 'directoryPath'],
  },
},
// Error/Log capture tools
{
  name: 'game_get_errors',
  description: 'Get new push_error/push_warning messages since last call',
  inputSchema: {
    type: 'object',
    properties: {
      maxItems: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum unread error lines returned. Default: 1000' },
    },
    required: [],
  },
},
{
  name: 'game_get_logs',
  description: 'Get new print output from the running game since last call',
  inputSchema: {
    type: 'object',
    properties: {
      maxItems: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum unread log lines returned. Default: 1000' },
    },
    required: [],
  },
},
// Enhanced input tools
{
  name: 'game_key_hold',
  description: 'Hold a key down without auto-releasing',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key name (e.g. "W", "Space", "Shift")' },
      action: { type: 'string', description: 'Godot input action name (e.g. "move_forward")' },
    },
    required: [],
  },
},
{
  name: 'game_key_release',
  description: 'Release a previously held key',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key name to release' },
      action: { type: 'string', description: 'Godot input action name to release' },
    },
    required: [],
  },
},
{
  name: 'game_scroll',
  description: 'Send mouse scroll wheel event at position',
  inputSchema: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'X position for scroll event' },
      y: { type: 'number', description: 'Y position for scroll event' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction. Default: up' },
      amount: { type: 'integer', minimum: 1, maximum: 1000, description: 'Scroll clicks. Default: 1' },
    },
    required: ['x', 'y'],
  },
},
{
  name: 'game_mouse_drag',
  description: 'Drag mouse between two points over N frames',
  inputSchema: {
    type: 'object',
    properties: {
      fromX: { type: 'number', description: 'Start X coordinate' },
      fromY: { type: 'number', description: 'Start Y coordinate' },
      toX: { type: 'number', description: 'End X coordinate' },
      toY: { type: 'number', description: 'End Y coordinate' },
      button: { type: 'integer', description: 'Mouse button (1=left, 2=right, 3=middle, 8/9=extra). Default: 1' },
      steps: { type: 'integer', description: 'Positive number of frames for the drag. Default: 10' },
    },
    required: ['fromX', 'fromY', 'toX', 'toY'],
  },
},
{
  name: 'game_gamepad',
  description: 'Send gamepad button or axis input event',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['button', 'axis'], description: 'Input type' },
      index: { type: 'integer', minimum: 0, maximum: 15, description: 'Button or axis index' },
      value: { type: 'number', minimum: -1, maximum: 1, description: 'Button pressure or axis value' },
      device: { type: 'integer', minimum: 0, maximum: 7, description: 'Gamepad device index. Default: 0' },
      deadzone: { type: 'number', minimum: 0, maximum: 1, description: 'Axis values below this magnitude become zero' },
    },
    required: ['type', 'index', 'value'],
  },
},
// Project management tools
{
  name: 'create_project',
  description: 'Create a new Godot project from scratch',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Directory where the project will be created' },
      projectName: { type: 'string', minLength: 1, maxLength: 128, description: 'Name of the project' },
      dotnet: { type: 'boolean', description: 'Scaffold a .NET (C#) project (.csproj + "C#" feature). Default: false' },
    },
    required: ['projectPath', 'projectName'],
  },
},
{
  name: 'create_csharp_script',
  description: 'Create a C# script file in a Godot .NET project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot .NET project path (must contain a .csproj)' },
      scriptPath: { type: 'string', description: 'Script file path relative to project (e.g. "scripts/Player.cs")' },
      className: { type: 'string', description: 'C# class name. Default: derived from the file name' },
      baseClass: { type: 'string', description: 'Godot base class to extend. Default: Node' },
      namespaceName: { type: 'string', description: 'Optional C# namespace' },
      methods: { type: 'array', items: { type: 'string' }, description: 'Method stubs (e.g. _Ready, _Process) to include' },
      source: { type: 'string', description: 'Full source code (overrides template)' },
    },
    required: ['projectPath', 'scriptPath'],
  },
},
{
  name: 'manage_autoloads',
  description: 'Add, remove, or list autoloads in a Godot project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', description: '"list", "add", or "remove"' },
      name: { type: 'string', description: 'Autoload name (required for add/remove)' },
      path: { type: 'string', description: 'Script/scene path (required for add, e.g. "res://globals.gd")' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'manage_input_map',
  description: 'Add, remove, or list input actions and bindings',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', description: '"list", "add", or "remove"' },
      actionName: { type: 'string', description: 'Input action name (required for add/remove)' },
      key: { type: 'string', description: 'Key to bind (for add, e.g. "W", "Space")' },
      deadzone: { type: 'number', description: 'Deadzone for the action. Default: 0.5' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'manage_export_presets',
  description: 'Create or modify export preset configuration',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', description: '"list", "add", or "remove"' },
      name: { type: 'string', description: 'Preset name (required for add/remove)' },
      platform: { type: 'string', description: 'Platform (for add, e.g. "Windows Desktop", "Linux", "Web")' },
      runnable: { type: 'boolean', description: 'Whether this preset is runnable. Default: false' },
    },
    required: ['projectPath', 'action'],
  },
},
// Advanced runtime tools
{
  name: 'game_get_camera',
  description: 'Get active camera position, rotation, and size',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
{
  name: 'game_set_camera',
  description: 'Move or rotate the active camera',
  inputSchema: {
    type: 'object',
    properties: {
      position: { type: 'object', description: '{x,y} or {x,y,z} for camera position' },
      rotation: {
        type: 'object',
        description: 'Camera rotation in degrees: {z} for Camera2D or {x,y,z} for Camera3D',
        anyOf: [
          {
            type: 'object',
            properties: { z: { type: 'number', description: '2D rotation in degrees' } },
            required: ['z'],
          },
          {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'X rotation in degrees' },
              y: { type: 'number', description: 'Y rotation in degrees' },
              z: { type: 'number', description: 'Z rotation in degrees' },
            },
            required: ['x', 'y', 'z'],
          },
        ],
      },
      zoom: { type: 'object', description: '{x,y} zoom for Camera2D' },
      fov: { type: 'number', description: 'Field of view for Camera3D' },
    },
    required: [],
  },
},
{
  name: 'game_raycast',
  description: 'Cast a ray and return collision results',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'object', description: 'Start point {x,y} or {x,y,z}' },
      to: { type: 'object', description: 'End point {x,y} or {x,y,z}' },
      collisionMask: { type: 'integer', description: 'Collision mask. Default: 0xFFFFFFFF' },
    },
    required: ['from', 'to'],
  },
},
{
  name: 'game_get_audio',
  description: 'Get audio bus layout and playing streams',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
{
  name: 'game_spawn_node',
  description: 'Create a new node of any type at runtime',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Node class name (e.g. "Sprite2D", "CharacterBody3D")' },
      name: { type: 'string', description: 'Name for the new node. Default: auto-generated' },
      parentPath: { type: 'string', description: 'Parent node path. Default: "/root"' },
      properties: { type: 'object', description: 'Properties to set on the new node' },
    },
    required: ['type'],
  },
},
// Shader, audio, navigation, tilemap, collision, environment tools
{
  name: 'game_set_shader_param',
  description: 'Set a shader parameter on a node\'s material',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node with a ShaderMaterial' },
      paramName: { type: 'string', description: 'Shader parameter name' },
      value: { description: 'Value to set (number, object, array, etc.)' },
      typeHint: { type: 'string', description: 'Optional type hint (e.g. "Color", "Vector2")' },
    },
    required: ['nodePath', 'paramName', 'value'],
  },
},
{
  name: 'game_audio_play',
  description: 'Play, stop, or pause an AudioStreamPlayer node',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to AudioStreamPlayer/2D/3D node' },
      action: { type: 'string', enum: ['play', 'stop', 'pause', 'resume'], description: 'Playback action. Default: play' },
      stream: { type: 'string', description: 'Optional res:// path to load a new stream' },
      volume: { type: 'number', description: 'Volume (linear 0-1)' },
      pitch: { type: 'number', description: 'Pitch scale' },
      bus: { type: 'string', description: 'Audio bus name' },
      fromPosition: { type: 'number', description: 'Start position in seconds' },
    },
    required: ['nodePath'],
  },
},
{
  name: 'game_audio_bus',
  description: 'Set volume, mute, or solo on an audio bus',
  inputSchema: {
    type: 'object',
    properties: {
      busName: { type: 'string', description: 'Bus name. Default: "Master"' },
      volume: { type: 'number', description: 'Volume (linear 0-1)' },
      mute: { type: 'boolean', description: 'Mute the bus' },
      solo: { type: 'boolean', description: 'Solo the bus' },
    },
    required: [],
  },
},
{
  name: 'game_navigate_path',
  description: 'Query a navigation path between two points',
  inputSchema: {
    type: 'object',
    properties: {
      start: { type: 'object', description: 'Start point {x,y} or {x,y,z}' },
      end: { type: 'object', description: 'End point {x,y} or {x,y,z}' },
      optimize: { type: 'boolean', description: 'Use string-pulling optimization. Default: true' },
    },
    required: ['start', 'end'],
  },
},
{
  name: 'game_tilemap',
  description: 'Get or set cells in a TileMapLayer node',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to TileMapLayer node' },
      action: { type: 'string', enum: ['set_cells', 'get_cell', 'erase_cells', 'get_used_cells'], description: 'Action: set_cells, get_cell, erase_cells, get_used_cells' },
      x: { type: 'integer', description: 'Cell X coordinate (for get_cell)' },
      y: { type: 'integer', description: 'Cell Y coordinate (for get_cell)' },
      cells: {
        type: 'array',
        description: 'Cell objects for set_cells/erase_cells',
        items: {
          type: 'object',
          properties: {
            x: { type: 'integer', description: 'Cell X coordinate' },
            y: { type: 'integer', description: 'Cell Y coordinate' },
            sourceId: { type: 'integer', description: 'TileSet source ID' },
            atlasX: { type: 'integer', description: 'Atlas X coordinate' },
            atlasY: { type: 'integer', description: 'Atlas Y coordinate' },
            altTile: { type: 'integer', description: 'Alternative tile ID' },
          },
          required: ['x', 'y'],
        },
      },
      sourceId: { type: 'integer', description: 'Filter by source_id (for get_used_cells)' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_add_collision',
  description: 'Add a collision shape to a physics body node',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Path to CollisionBody/Area node' },
      shapeType: { type: 'string', enum: ['box', 'sphere', 'circle', 'capsule', 'cylinder', 'ray', 'segment'], description: 'Shape: box, sphere/circle, capsule, cylinder, ray, segment' },
      shapeParams: { type: 'object', description: 'Shape dimensions (e.g. {radius, height})' },
      collisionLayer: { type: 'integer', description: 'Collision layer bitmask' },
      collisionMask: { type: 'integer', description: 'Collision mask bitmask' },
      disabled: { type: 'boolean', description: 'Start disabled' },
    },
    required: ['parentPath', 'shapeType'],
  },
},
{
  name: 'game_environment',
  description: 'Get or set environment and post-processing settings',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: 'Action: get or set. Default: set' },
      backgroundMode: { type: 'integer', description: '0=clear, 1=custom_color, 2=sky, 3=canvas' },
      backgroundColor: { type: 'object', description: 'Background color {r,g,b,a}' },
      ambientLightColor: { type: 'object', description: 'Ambient light color {r,g,b,a}' },
      ambientLightEnergy: { type: 'number', description: 'Ambient light energy' },
      fogEnabled: { type: 'boolean', description: 'Enable fog' },
      fogDensity: { type: 'number', description: 'Fog density' },
      fogLightColor: { type: 'object', description: 'Fog light color {r,g,b,a}' },
      glowEnabled: { type: 'boolean', description: 'Enable glow' },
      glowIntensity: { type: 'number', description: 'Glow intensity' },
      glowBloom: { type: 'number', description: 'Glow bloom' },
      tonemapMode: { type: 'integer', description: '0=linear, 1=reinhardt, 2=filmic, 3=aces' },
      ssaoEnabled: { type: 'boolean', description: 'Enable SSAO' },
      ssaoRadius: { type: 'number', description: 'SSAO radius' },
      ssaoIntensity: { type: 'number', description: 'SSAO intensity' },
      ssrEnabled: { type: 'boolean', description: 'Enable SSR' },
      brightness: { type: 'number', description: 'Brightness adjustment' },
      contrast: { type: 'number', description: 'Contrast adjustment' },
      saturation: { type: 'number', description: 'Saturation adjustment' },
    },
    required: [],
  },
},
// Group, timer, particles, animation, export, state, physics, joint, bone, theme, viewport, debug tools
{
  name: 'game_manage_group',
  description: 'Add or remove a node from a group, or list groups',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node' },
      action: { type: 'string', description: 'Action: add, remove, get_groups, clear_group' },
      group: { type: 'string', description: 'Group name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_create_timer',
  description: 'Create a Timer node with configuration',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path. Default: "/root"' },
      waitTime: { type: 'number', description: 'Timer duration in seconds. Default: 1.0' },
      oneShot: { type: 'boolean', description: 'One-shot mode. Default: false' },
      autostart: { type: 'boolean', description: 'Auto-start the timer. Default: false' },
      name: { type: 'string', description: 'Optional timer node name' },
    },
    required: [],
  },
},
{
  name: 'game_set_particles',
  description: 'Configure GPUParticles2D/3D node properties',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to GPUParticles node' },
      emitting: { type: 'boolean', description: 'Enable/disable emission' },
      amount: { type: 'number', description: 'Number of particles' },
      lifetime: { type: 'number', description: 'Particle lifetime in seconds' },
      oneShot: { type: 'boolean', description: 'One-shot mode' },
      speedScale: { type: 'number', description: 'Speed scale' },
      explosiveness: { type: 'number', description: 'Explosiveness ratio (0-1)' },
      randomness: { type: 'number', description: 'Randomness ratio (0-1)' },
      processMaterial: { type: 'object', description: 'ParticleProcessMaterial settings: direction {x,y,z}, spread, gravity {x,y,z}, initialVelocityMin, initialVelocityMax, color {r,g,b,a}, scaleMin, scaleMax' },
    },
    required: ['nodePath'],
  },
},
{
  name: 'game_create_animation',
  description: 'Create an animation with tracks and keyframes',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to AnimationPlayer node' },
      animationName: { type: 'string', description: 'Name for the new animation' },
      length: { type: 'number', description: 'Animation length in seconds. Default: 1.0' },
      loopMode: { type: 'integer', minimum: 0, maximum: 2, description: '0=none, 1=linear, 2=pingpong' },
      tracks: { type: 'array', description: 'Array of track definitions' },
      library: { type: 'string', description: 'Animation library name. Default: ""' },
    },
    required: ['nodePath', 'animationName'],
  },
},
{
  name: 'export_project',
  description: 'Export a Godot project using a preset',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      presetName: { type: 'string', description: 'Export preset name' },
      outputPath: { type: 'string', description: 'Output file path for the exported build' },
      debug: { type: 'boolean', description: 'Use debug export. Default: false' },
    },
    required: ['projectPath', 'presetName', 'outputPath'],
  },
},
{
  name: 'game_serialize_state',
  description: 'Save or load node tree state as JSON',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Root node path. Default: "/root"' },
      action: { type: 'string', description: 'Action: save or load. Default: save' },
      data: { type: 'object', description: 'State data to restore (for load)' },
      maxDepth: { type: 'number', description: 'Max tree depth to serialize. Default: 5' },
    },
    required: [],
  },
},
{
  name: 'game_physics_body',
  description: 'Configure physics body properties (mass, velocity, etc.)',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to physics body node' },
      gravityScale: { type: 'number', description: 'Gravity scale' },
      mass: { type: 'number', description: 'Body mass' },
      linearVelocity: { type: 'object', description: 'Linear velocity {x,y} or {x,y,z}' },
      angularVelocity: { description: 'Angular velocity (float for 2D, {x,y,z} for 3D)' },
      linearDamp: { type: 'number', description: 'Linear damping' },
      angularDamp: { type: 'number', description: 'Angular damping' },
      friction: { type: 'number', description: 'Physics material friction' },
      bounce: { type: 'number', description: 'Physics material bounce' },
      freeze: { type: 'boolean', description: 'Freeze the body' },
      sleeping: { type: 'boolean', description: 'Put body to sleep' },
    },
    required: ['nodePath'],
  },
},
{
  name: 'game_create_joint',
  description: 'Create a physics joint between two bodies',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path for the joint' },
      jointType: { type: 'string', enum: ['pin_2d', 'spring_2d', 'groove_2d', 'pin_3d', 'hinge_3d', 'cone_3d', 'slider_3d'], description: 'Joint type: pin_2d, spring_2d, groove_2d, pin_3d, hinge_3d, cone_3d, slider_3d' },
      nodeAPath: { type: 'string', description: 'Path to first body' },
      nodeBPath: { type: 'string', description: 'Path to second body' },
      stiffness: { type: 'number', description: 'Spring stiffness (spring_2d)' },
      damping: { type: 'number', description: 'Spring damping (spring_2d)' },
      length: { type: 'number', description: 'Length (spring_2d, groove_2d)' },
      restLength: { type: 'number', description: 'Rest length (spring_2d)' },
      softness: { type: 'number', description: 'Softness (pin_2d)' },
      initialOffset: { type: 'number', description: 'Initial offset (groove_2d)' },
    },
    required: ['parentPath', 'jointType'],
  },
},
{
  name: 'game_bone_pose',
  description: 'Get or set bone poses on a Skeleton3D node',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to Skeleton3D node' },
      action: { type: 'string', enum: ['list', 'get', 'set'], description: 'Action. Default: list' },
      boneIndex: { type: 'integer', minimum: 0, description: 'Bone index' },
      boneName: { type: 'string', description: 'Bone name (alternative to index)' },
      position: { type: 'object', description: 'Bone position {x,y,z}' },
      rotation: { type: 'object', description: 'Bone rotation quaternion {x,y,z,w}' },
      scale: { type: 'object', description: 'Bone scale {x,y,z}' },
    },
    required: ['nodePath'],
  },
},
{
  name: 'game_ui_theme',
  description: 'Apply theme overrides to a Control node',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to Control node' },
      overrides: { type: 'object', description: 'Theme overrides: {colors, constants, fontSizes}' },
    },
    required: ['nodePath', 'overrides'],
  },
},
{
  name: 'game_viewport',
  description: 'Create or configure a SubViewport node',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: create, configure, or get' },
      parentPath: { type: 'string', description: 'Parent path (for create)' },
      nodePath: { type: 'string', description: 'SubViewport path (for configure/get)' },
      width: { type: 'number', description: 'Viewport width' },
      height: { type: 'number', description: 'Viewport height' },
      msaa: { type: 'number', description: 'MSAA level (0=disabled, 1=2x, 2=4x, 3=8x)' },
      transparentBg: { type: 'boolean', description: 'Transparent background' },
      name: { type: 'string', description: 'Viewport name (for create)' },
    },
    required: [],
  },
},
{
  name: 'game_debug_draw',
  description: 'Draw debug lines, spheres, or boxes in 3D',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['line', 'sphere', 'box', 'clear'], description: 'Action: line, sphere, box, or clear' },
      from: { type: 'object', description: 'Line start {x,y,z}' },
      to: { type: 'object', description: 'Line end {x,y,z}' },
      center: { type: 'object', description: 'Sphere/box center {x,y,z}' },
      radius: { type: 'number', minimum: 0, description: 'Sphere radius. Default: 0.5' },
      size: { type: 'object', description: 'Box size {x,y,z}' },
      color: { type: 'object', description: 'Draw color {r,g,b,a}. Default: red' },
      duration: { type: 'integer', minimum: 0, description: 'Frames to persist (0=permanent)' },
    },
    required: ['action'],
  },
},
// Batch 1: Networking + Input + System + Signals + Script
{
  name: 'game_http_request',
  description: 'HTTP GET/POST/PUT/DELETE with headers and body',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 8192, pattern: '^https?://', description: 'HTTP(S) request URL' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method. Default: GET' },
      headers: { type: 'object', description: 'Request headers as key-value pairs' },
      body: { type: 'string', maxLength: 1048576, description: 'Request body string (maximum 1 MiB UTF-16 code units)' },
      timeout: { type: 'number', minimum: 0.01, maximum: 30, description: 'Timeout in seconds. Default: 30' },
    },
    required: ['url'],
  },
},
{
  name: 'game_websocket',
  description: 'WebSocket client connect/disconnect/send messages',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['connect', 'disconnect', 'send', 'receive', 'status'], description: 'Action: connect, disconnect, send, receive, status' },
      url: { type: 'string', description: 'WebSocket URL (for connect)' },
      message: { type: 'string', description: 'Message to send (for send)' },
      timeout: { type: 'number', minimum: 0, description: 'Connect or receive timeout in seconds. Default: 5' },
    },
    required: ['action'],
  },
},
{
  name: 'game_multiplayer',
  description: 'ENet multiplayer create server/client/disconnect',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create_server', 'create_client', 'disconnect', 'status'], description: 'Action: create_server, create_client, disconnect, status' },
      port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Server port. Default: 7000' },
      address: { type: 'string', description: 'Server address for client. Default: 127.0.0.1' },
      maxClients: { type: 'integer', minimum: 1, description: 'Max clients for server. Default: 32' },
    },
    required: ['action'],
  },
},
{
  name: 'game_rpc',
  description: 'Call or configure RPC methods on nodes',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node' },
      action: { type: 'string', enum: ['call', 'configure'], description: 'Action: call or configure' },
      method: { type: 'string', minLength: 1, maxLength: 256, description: 'RPC method name' },
      args: { type: 'array', maxItems: 64, description: 'Arguments for the RPC call' },
      peerId: { type: 'integer', minimum: 0, description: 'Target peer ID for call; 0 broadcasts' },
      mode: { type: 'string', enum: ['any_peer', 'authority'], description: 'RPC authority mode' },
      sync: { type: 'string', enum: ['call_local', 'call_remote'], description: 'Local invocation mode' },
      transferMode: { type: 'string', enum: ['unreliable', 'unreliable_ordered', 'reliable'], description: 'RPC transfer mode' },
      channel: { type: 'integer', minimum: 0, maximum: 255, description: 'Transfer channel' },
    },
    required: ['nodePath', 'action', 'method'],
  },
},
{
  name: 'game_touch',
  description: 'Simulate touch press/release/drag and gestures',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['press', 'release', 'drag'], description: 'Touch action' },
      x: { type: 'number', description: 'Touch X position' },
      y: { type: 'number', description: 'Touch Y position' },
      index: { type: 'integer', minimum: 0, maximum: 31, description: 'Touch index. Default: 0' },
      toX: { type: 'number', description: 'Drag end X (for drag)' },
      toY: { type: 'number', description: 'Drag end Y (for drag)' },
      steps: { type: 'integer', minimum: 1, maximum: 1000, description: 'Drag steps. Default: 10' },
    },
    required: ['action', 'x', 'y'],
  },
},
{
  name: 'game_input_state',
  description: 'Query key, action, mouse, and connected joypad state or configure the mouse',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['query', 'warp_mouse', 'set_mouse_mode'], description: 'Action: query, warp_mouse, set_mouse_mode' },
      x: { type: 'number', description: 'Mouse X (for warp_mouse)' },
      y: { type: 'number', description: 'Mouse Y (for warp_mouse)' },
      mouseMode: { type: 'string', enum: ['visible', 'hidden', 'captured', 'confined'], description: 'Mode: visible, hidden, captured, confined' },
      keys: { type: 'array', items: { type: 'string' }, maxItems: 128, description: 'Key names to inspect during query' },
      actions: { type: 'array', items: { type: 'string' }, maxItems: 128, description: 'InputMap actions to inspect during query' },
      mouseButtons: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 9 }, maxItems: 9, description: 'Mouse button indices to inspect during query' },
    },
    required: [],
  },
},
{
  name: 'game_input_action',
  description: 'Manage runtime InputMap actions and strength',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set_strength', 'add_action', 'remove_action', 'list'], description: 'Action: set_strength, add_action, remove_action, list' },
      actionName: { type: 'string', description: 'Input action name' },
      strength: { type: 'number', description: 'Action strength 0.0-1.0' },
      key: { type: 'string', description: 'Key name (for add_action)' },
    },
    required: ['action'],
  },
},
{
  name: 'game_list_signals',
  description: 'List all signals on a node with connections',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node' },
    },
    required: ['nodePath'],
  },
},
{
  name: 'game_await_signal',
  description: 'Await a signal with timeout and return args',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node' },
      signalName: { type: 'string', description: 'Signal name to await' },
      timeout: { type: 'number', minimum: 0.01, maximum: 30, description: 'Timeout in seconds. Default: 10' },
    },
    required: ['nodePath', 'signalName'],
  },
},
{
  name: 'game_script',
  description: 'Attach, detach, or get source of node scripts',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node' },
      action: { type: 'string', description: 'Action: attach, detach, get_source' },
      source: { type: 'string', description: 'GDScript source code (for attach)' },
      className: { type: 'string', description: 'Class the script extends' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_window',
  description: 'Get/set window size, fullscreen, title, position',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: get or set. Default: get' },
      width: { type: 'number', description: 'Window width' },
      height: { type: 'number', description: 'Window height' },
      fullscreen: { type: 'boolean', description: 'Fullscreen mode' },
      borderless: { type: 'boolean', description: 'Borderless mode' },
      title: { type: 'string', description: 'Window title' },
      position: { type: 'object', description: 'Window position {x, y}' },
      vsync: { type: 'boolean', description: 'Enable vsync' },
    },
    required: [],
  },
},
{
  name: 'game_os_info',
  description: 'Get platform, locale, screen, adapter, memory info',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
{
  name: 'game_time_scale',
  description: 'Get/set Engine.time_scale and timing info',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: get or set. Default: get' },
      timeScale: { type: 'number', description: 'Time scale value (for set)' },
    },
    required: [],
  },
},
{
  name: 'game_process_mode',
  description: 'Set node process mode (pausable/always/disabled)',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to the node' },
      mode: { type: 'string', description: 'Mode: inherit, pausable, when_paused, always, disabled' },
    },
    required: ['nodePath', 'mode'],
  },
},
{
  name: 'game_world_settings',
  description: 'Get/set gravity, physics FPS, and world settings',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: get or set. Default: get' },
      gravity: { type: 'number', description: 'Gravity magnitude' },
      gravityDirection: { type: 'object', description: 'Gravity direction vector {x,y,z}' },
      physicsFps: { type: 'number', description: 'Physics ticks per second' },
    },
    required: [],
  },
},
// Batch 2: 3D Rendering + Lighting + Sky + Physics
{
  name: 'game_csg',
  description: 'Create/configure CSG nodes with boolean operations',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      action: { type: 'string', description: 'Action: create or configure' },
      csgType: { type: 'string', description: 'CSG type: box, sphere, cylinder, mesh, combiner' },
      nodePath: { type: 'string', description: 'Node path (for configure)' },
      operation: { type: 'string', description: 'Boolean op: union, intersection, subtraction' },
      size: { type: 'object', description: 'Size {x,y,z} (box)' },
      radius: { type: 'number', description: 'Radius (sphere/cylinder)' },
      height: { type: 'number', description: 'Height (cylinder)' },
      material: { type: 'string', description: 'Material resource path' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_multimesh',
  description: 'Create/configure MultiMeshInstance3D for instancing',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      action: { type: 'string', description: 'Action: create, set_instance, get_info' },
      nodePath: { type: 'string', description: 'Node path (for set_instance/get_info)' },
      meshType: { type: 'string', description: 'Mesh: box, sphere, cylinder, quad' },
      count: { type: 'number', description: 'Instance count' },
      index: { type: 'number', description: 'Instance index (for set_instance)' },
      transform: { type: 'object', description: 'Transform {origin:{x,y,z}, rotation:{x,y,z}}' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_procedural_mesh',
  description: 'Generate meshes via ArrayMesh from vertex data',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      vertices: { type: 'array', description: 'Vertex positions [[x,y,z],...]' },
      normals: { type: 'array', description: 'Vertex normals [[x,y,z],...]' },
      uvs: { type: 'array', description: 'UV coordinates [[u,v],...]' },
      indices: { type: 'array', description: 'Triangle indices [i0,i1,i2,...]' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['parentPath', 'vertices'],
  },
},
{
  name: 'game_light_3d',
  description: 'Create/configure 3D lights (directional/omni/spot)',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      action: { type: 'string', description: 'Action: create or configure' },
      lightType: { type: 'string', description: 'Type: directional, omni, spot' },
      nodePath: { type: 'string', description: 'Node path (for configure)' },
      color: { type: 'object', description: 'Light color {r,g,b}' },
      energy: { type: 'number', description: 'Light energy/intensity' },
      range: { type: 'number', description: 'Light range (omni/spot)' },
      shadows: { type: 'boolean', description: 'Enable shadow casting' },
      spotAngle: { type: 'number', description: 'Spot cone angle in degrees' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_mesh_instance',
  description: 'Create MeshInstance3D with primitive meshes',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      meshType: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'capsule', 'plane', 'quad'], description: 'Mesh: box, sphere, cylinder, capsule, plane, quad' },
      size: { type: 'object', description: 'Mesh size {x,y,z}' },
      radius: { type: 'number', minimum: 0, description: 'Mesh radius' },
      height: { type: 'number', minimum: 0, description: 'Mesh height' },
      material: { type: 'string', description: 'Material resource path or color hex' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['parentPath', 'meshType'],
  },
},
{
  name: 'game_gridmap',
  description: 'GridMap set/get/clear cells and query used cells',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to GridMap node' },
      action: { type: 'string', description: 'Action: set_cell, get_cell, clear, get_used' },
      x: { type: 'number', description: 'Cell X coordinate' },
      y: { type: 'number', description: 'Cell Y coordinate' },
      z: { type: 'number', description: 'Cell Z coordinate' },
      item: { type: 'number', description: 'MeshLibrary item index' },
      orientation: { type: 'number', description: 'Cell orientation index' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_3d_effects',
  description: 'Create ReflectionProbe, Decal, or FogVolume',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      effectType: { type: 'string', description: 'Type: reflection_probe, decal, fog_volume' },
      size: { type: 'object', description: 'Effect size {x,y,z}' },
      intensity: { type: 'number', description: 'Effect intensity' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['parentPath', 'effectType'],
  },
},
{
  name: 'game_gi',
  description: 'Create/configure VoxelGI or LightmapGI',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      giType: { type: 'string', description: 'Type: voxel_gi or lightmap_gi' },
      size: { type: 'object', description: 'Extents size {x,y,z}' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['parentPath', 'giType'],
  },
},
{
  name: 'game_path_3d',
  description: 'Create Path3D/Curve3D and manage curve points',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      action: { type: 'string', enum: ['create', 'add_point', 'get_points', 'set_points'], description: 'Action: create, add_point, set_points, get_points' },
      nodePath: { type: 'string', description: 'Path3D node path (for add/set/get)' },
      points: { type: 'array', items: { type: 'object' }, description: 'Array of points [{x,y,z},...]' },
      point: { type: 'object', description: 'Single point {x,y,z}' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_sky',
  description: 'Create/configure Sky with procedural/physical sky',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: create or configure' },
      skyType: { type: 'string', description: 'Type: procedural or physical' },
      topColor: { type: 'object', description: 'Sky top color {r,g,b}' },
      bottomColor: { type: 'object', description: 'Horizon bottom color {r,g,b}' },
      sunEnergy: { type: 'number', description: 'Sun energy/brightness' },
      groundColor: { type: 'object', description: 'Ground color {r,g,b}' },
    },
    required: ['action'],
  },
},
{
  name: 'game_camera_attributes',
  description: 'Configure DOF, exposure, auto-exposure on camera',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: get or set' },
      dofBlurFar: { type: 'number', description: 'DOF far blur distance' },
      dofBlurNear: { type: 'number', description: 'DOF near blur distance' },
      dofBlurAmount: { type: 'number', description: 'DOF blur amount' },
      exposureMultiplier: { type: 'number', description: 'Exposure multiplier' },
      autoExposure: { type: 'boolean', description: 'Enable auto exposure' },
      autoExposureScale: { type: 'number', description: 'Auto exposure scale' },
    },
    required: [],
  },
},
{
  name: 'game_navigation_3d',
  description: 'Create/configure NavigationRegion3D and bake',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      action: { type: 'string', enum: ['create', 'bake'], description: 'Action: create or bake' },
      nodePath: { type: 'string', description: 'Node path (for bake/configure)' },
      cellSize: { type: 'number', description: 'Navigation cell size' },
      agentRadius: { type: 'number', description: 'Agent radius' },
      agentHeight: { type: 'number', description: 'Agent height' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_physics_3d',
  description: 'Area3D queries and point/shape intersection tests',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['ray', 'overlap', 'contacts', 'inspect_shape'], description: 'Action: ray, overlap, contacts, or inspect_shape' },
      nodePath: { type: 'string', description: 'Area3D/node path (for overlap)' },
      from: { type: 'object', description: 'Ray/point origin {x,y,z}' },
      to: { type: 'object', description: 'Ray end {x,y,z}' },
      collisionMask: { type: 'integer', description: 'Collision mask bitmask' },
    },
    required: ['action'],
  },
},
// Batch 3: 2D Systems + Animation Advanced + Audio Effects
{
  name: 'game_canvas',
  description: 'Create/configure CanvasLayer and CanvasModulate',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      action: { type: 'string', enum: ['create_layer', 'create_modulate', 'configure'], description: 'Action: create_layer, create_modulate, configure' },
      nodePath: { type: 'string', description: 'Node path (for configure)' },
      layer: { type: 'integer', description: 'Canvas layer number' },
      offset: { type: 'object', description: 'CanvasLayer offset {x,y} (for configure)' },
      visible: { type: 'boolean', description: 'CanvasLayer visibility (for configure)' },
      color: { type: 'object', description: 'Modulate color {r,g,b,a}' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_canvas_draw',
  description: '2D drawing: line/rect/circle/polygon/text/clear',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path for draw node' },
      action: { type: 'string', enum: ['line', 'rect', 'circle', 'polygon', 'text', 'clear'], description: 'Action: line, rect, circle, polygon, text, clear' },
      from: { type: 'object', description: 'Start point {x,y}' },
      to: { type: 'object', description: 'End point {x,y}' },
      center: { type: 'object', description: 'Center point {x,y}' },
      radius: { type: 'number', description: 'Circle radius' },
      rect: { type: 'object', description: 'Rectangle {x,y,w,h}' },
      points: { type: 'array', description: 'Polygon points [{x,y},...]' },
      position: { type: 'object', description: 'Text position {x,y} (baseline, for text)' },
      text: { type: 'string', description: 'Text to draw' },
      fontSize: { type: 'integer', description: 'Text font size. Default: 16' },
      color: { type: 'object', description: 'Draw color {r,g,b,a}' },
      width: { type: 'number', description: 'Line width. Default: 2' },
      filled: { type: 'boolean', description: 'Fill shape. Default: true' },
    },
    required: ['action'],
  },
},
{
  name: 'game_light_2d',
  description: 'Create/configure 2D lights and light occluders',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      action: { type: 'string', enum: ['create_point', 'create_directional', 'create_occluder'], description: 'Action: create_point, create_directional, create_occluder' },
      nodePath: { type: 'string', description: 'Node path (for configure)' },
      color: { type: 'object', description: 'Light color {r,g,b,a}' },
      energy: { type: 'number', description: 'Light energy' },
      range: { type: 'number', description: 'Light texture range' },
      points: { type: 'array', description: 'Occluder polygon points [{x,y},...] (for create_occluder)' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_parallax',
  description: 'Create/configure ParallaxBackground and layers',
  inputSchema: {
    type: 'object',
    properties: {
      parentPath: { type: 'string', description: 'Parent node path' },
      action: { type: 'string', enum: ['create_background', 'add_layer', 'configure'], description: 'Action: create_background, add_layer, configure' },
      nodePath: { type: 'string', description: 'Node path (for configure)' },
      motionScale: { type: 'object', description: 'Motion scale {x,y} (ParallaxLayer)' },
      motionOffset: { type: 'object', description: 'Motion offset {x,y} (ParallaxLayer)' },
      mirroring: { type: 'object', description: 'Mirroring {x,y} (ParallaxLayer)' },
      scrollOffset: { type: 'object', description: 'Scroll offset {x,y} (ParallaxBackground configure)' },
      scrollBaseOffset: { type: 'object', description: 'Scroll base offset {x,y} (ParallaxBackground configure)' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_shape_2d',
  description: 'Line2D/Polygon2D point manipulation',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to Line2D/Polygon2D node' },
      action: { type: 'string', enum: ['add_point', 'set_points', 'clear', 'get_points'], description: 'Action: add_point, set_points, clear, get_points' },
      points: { type: 'array', description: 'Array of points [{x,y},...]' },
      point: { type: 'object', description: 'Single point {x,y}' },
      width: { type: 'number', description: 'Line width' },
      color: { type: 'object', description: 'Color {r,g,b,a}' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_path_2d',
  description: 'Path2D and Curve2D point management',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'add_point', 'get_points'], description: 'Action: create, add_point, get_points' },
      parentPath: { type: 'string', description: 'Parent node path (for create)' },
      nodePath: { type: 'string', description: 'Path2D node path' },
      points: { type: 'array', description: 'Array of points [{x,y},...]' },
      point: { type: 'object', description: 'Single point {x,y}' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_physics_2d',
  description: 'Area2D queries and 2D point/shape intersections',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['ray', 'overlap', 'point_query', 'shape_query'], description: 'Action: overlap, point_query, shape_query, ray' },
      nodePath: { type: 'string', description: 'Area2D/node path (for overlap)' },
      from: { type: 'object', description: 'Origin point {x,y}' },
      to: { type: 'object', description: 'End point {x,y} (for ray)' },
      position: { type: 'object', description: 'Query position {x,y} (point_query/shape_query)' },
      radius: { type: 'number', description: 'Circle radius (shape_query circle)' },
      size: { type: 'object', description: 'Rectangle size {x,y} (shape_query rectangle)' },
      shapeType: { type: 'string', enum: ['circle', 'rectangle'], description: 'Shape: circle or rectangle (shape_query)' },
      maxResults: { type: 'integer', minimum: 1, description: 'Max results. Default: 32' },
      collisionMask: { type: 'integer', description: 'Collision mask bitmask' },
    },
    required: ['action'],
  },
},
{
  name: 'game_animation_tree',
  description: 'AnimationTree state machine travel and params',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to AnimationTree node' },
      action: { type: 'string', enum: ['travel', 'set_param', 'get_state'], description: 'State-machine action' },
      stateName: { type: 'string', description: 'State name (for travel)' },
      paramName: { type: 'string', description: 'Parameter name' },
      paramValue: { description: 'Parameter value' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_animation_control',
  description: 'AnimationPlayer seek/queue/speed/info control',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to AnimationPlayer node' },
      action: { type: 'string', enum: ['seek', 'queue', 'set_speed', 'stop', 'get_info'], description: 'Action: seek, queue, set_speed, get_info, stop' },
      animationName: { type: 'string', description: 'Animation name' },
      position: { type: 'number', description: 'Seek position in seconds' },
      speed: { type: 'number', description: 'Playback speed scale' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_skeleton_ik',
  description: 'SkeletonIK3D start/stop/set target position',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to SkeletonIK3D node' },
      action: { type: 'string', enum: ['start', 'stop', 'set_target'], description: 'IK action' },
      target: { type: 'object', description: 'Target position {x,y,z}' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_audio_effect',
  description: 'Add/remove/configure audio bus effects',
  inputSchema: {
    type: 'object',
    properties: {
      busName: { type: 'string', description: 'Audio bus name. Default: Master' },
      action: { type: 'string', enum: ['list', 'add', 'remove', 'configure'], description: 'Effect action' },
      effectType: { type: 'string', enum: ['reverb', 'delay', 'chorus', 'eq', 'compressor', 'limiter'], description: 'Effect type' },
      index: { type: 'integer', minimum: 0, description: 'Effect index' },
      properties: { type: 'object', description: 'Effect properties to set (for configure)' },
      enabled: { type: 'boolean', description: 'Enable/disable the effect (for configure)' },
    },
    required: ['action'],
  },
},
{
  name: 'game_audio_bus_layout',
  description: 'Create/remove audio buses and routing',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'move', 'set_send'], description: 'Action: add, remove, move, set_send, list' },
      busName: { type: 'string', description: 'Bus name' },
      sendTo: { type: 'string', description: 'Send target bus name' },
      index: { type: 'integer', minimum: 1, description: 'Destination bus index for move' },
    },
    required: ['action'],
  },
},
{
  name: 'game_audio_spatial',
  description: 'Configure AudioStreamPlayer3D spatial properties',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to AudioStreamPlayer3D' },
      action: { type: 'string', enum: ['configure', 'get_info'], description: 'Spatial-audio action' },
      maxDistance: { type: 'number', description: 'Maximum audible distance' },
      unitSize: { type: 'number', description: 'Unit size for distance attenuation' },
      maxDb: { type: 'number', description: 'Maximum volume in dB' },
      attenuationModel: { type: 'string', enum: ['inverse', 'inverse_square', 'logarithmic'], description: 'Distance attenuation model' },
    },
    required: ['nodePath', 'action'],
  },
},
// Batch 4: Editor/Headless + Localization + Resource
{
  name: 'rename_file',
  description: 'Rename or move a file within the project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      filePath: { type: 'string', description: 'Current file path (relative to project)' },
      newPath: { type: 'string', description: 'New file path (relative to project)' },
    },
    required: ['projectPath', 'filePath', 'newPath'],
  },
},
{
  name: 'manage_resource',
  description: 'Read or modify .tres/.res resource files',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      resourcePath: { type: 'string', description: 'Resource file path (relative to project)' },
      action: { type: 'string', description: 'Action: read or modify' },
      properties: { type: 'object', description: 'Properties to modify' },
    },
    required: ['projectPath', 'resourcePath', 'action'],
  },
},
{
  name: 'validate_script',
  description: 'Check a GDScript file for syntax/type errors (headless, no run)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      scriptPath: { type: 'string', description: 'GDScript file path relative to project (e.g. "scripts/player.gd")' },
    },
    required: ['projectPath', 'scriptPath'],
  },
},
{
  name: 'validate_scripts',
  description: 'Batch-check GDScript files (git-changed by default, or all)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      scope: { type: 'string', enum: ['changed', 'all'], description: '"changed" = git-changed .gd (default); "all" = every .gd in project' },
      scriptPaths: { type: 'array', items: { type: 'string' }, description: 'Optional explicit list of .gd paths to check (overrides scope)' },
    },
    required: ['projectPath'],
  },
},
{
  name: 'create_script',
  description: 'Create a GDScript file from a template',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      scriptPath: { type: 'string', description: 'Script file path (relative to project)' },
      extends: { type: 'string', description: 'Base class to extend. Default: Node' },
      className: { type: 'string', description: 'Optional class_name' },
      methods: { type: 'array', description: 'Method stubs to include' },
      source: { type: 'string', description: 'Full source code (overrides template)' },
    },
    required: ['projectPath', 'scriptPath'],
  },
},
{
  name: 'manage_scene_signals',
  description: 'List/add/remove signal connections in .tscn files',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      scenePath: { type: 'string', description: 'Scene file path (relative to project)' },
      action: { type: 'string', description: 'Action: list, add, remove' },
      signalName: { type: 'string', description: 'Signal name' },
      sourcePath: { type: 'string', description: 'Source node path' },
      targetPath: { type: 'string', description: 'Target node path' },
      method: { type: 'string', description: 'Target method name' },
    },
    required: ['projectPath', 'scenePath', 'action'],
  },
},
{
  name: 'manage_layers',
  description: 'List/set named layer definitions in project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', description: 'Action: list or set' },
      layerType: { type: 'string', description: 'Type: render, physics_2d, physics_3d, navigation' },
      layer: { type: 'number', description: 'Layer number (1-32)' },
      name: { type: 'string', description: 'Layer name' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'manage_plugins',
  description: 'List/enable/disable editor plugins',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', description: 'Action: list, enable, disable' },
      pluginName: { type: 'string', description: 'Plugin name' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'manage_shader',
  description: 'Create or read .gdshader files',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      shaderPath: { type: 'string', description: 'Shader file path (relative to project)' },
      action: { type: 'string', description: 'Action: create or read' },
      shaderType: { type: 'string', description: 'Type: spatial, canvas_item, particles, sky' },
      source: { type: 'string', description: 'Shader source code (for create)' },
    },
    required: ['projectPath', 'shaderPath', 'action'],
  },
},
{
  name: 'manage_theme_resource',
  description: 'Create/read/modify Theme .tres resources',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      resourcePath: { type: 'string', description: 'Theme file path (relative to project)' },
      action: { type: 'string', description: 'Action: create, read, modify' },
      properties: { type: 'object', description: 'Theme properties to set' },
    },
    required: ['projectPath', 'resourcePath', 'action'],
  },
},
{
  name: 'set_main_scene',
  description: 'Set the main scene in project.godot',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      scenePath: { type: 'string', description: 'Scene path (relative to project)' },
    },
    required: ['projectPath', 'scenePath'],
  },
},
{
  name: 'manage_scene_structure',
  description: 'Rename/duplicate/move nodes within .tscn scenes',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      scenePath: { type: 'string', description: 'Scene file path (relative to project)' },
      action: { type: 'string', description: 'Action: rename, duplicate, move' },
      nodePath: { type: 'string', description: 'Source node path in scene' },
      newName: { type: 'string', description: 'New name (for rename)' },
      newParentPath: { type: 'string', description: 'New parent path (for move)' },
    },
    required: ['projectPath', 'scenePath', 'action', 'nodePath'],
  },
},
{
  name: 'manage_translations',
  description: 'List/add/remove translation files in project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path' },
      action: { type: 'string', description: 'Action: list, add, remove' },
      translationPath: { type: 'string', description: 'Translation file path' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'game_locale',
  description: 'Set/get locale and translate strings at runtime',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: get, set, translate' },
      locale: { type: 'string', description: 'Locale code (e.g. en, es, fr)' },
      key: { type: 'string', description: 'Translation key (for translate)' },
    },
    required: ['action'],
  },
},
// Batch 5: UI Controls + Rendering + Resource Runtime
{
  name: 'game_ui_control',
  description: 'Set focus, anchors, tooltip, mouse filter on Control',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to Control node' },
      action: { type: 'string', enum: ['grab_focus', 'release_focus', 'configure', 'get_info'], description: 'Action: configure, grab_focus, release_focus, get_info' },
      anchorPreset: {
        oneOf: [
          { type: 'integer', minimum: 0, maximum: 15 },
          { type: 'string', enum: ['top_left', 'top_right', 'bottom_left', 'bottom_right', 'center_left', 'center_top', 'center_right', 'center_bottom', 'center', 'left_wide', 'top_wide', 'right_wide', 'bottom_wide', 'vcenter_wide', 'hcenter_wide', 'full_rect'] },
        ],
        description: 'Anchor preset value or name',
      },
      tooltip: { type: 'string', description: 'Tooltip text' },
      mouseFilter: { type: 'string', enum: ['stop', 'pass', 'ignore'], description: 'Mouse filter: stop, pass, ignore' },
      minSize: { type: 'object', description: 'Minimum size {x,y}' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_ui_text',
  description: 'LineEdit/TextEdit/RichTextLabel text operations',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to text control' },
      action: { type: 'string', enum: ['get', 'set', 'append', 'clear', 'bbcode'], description: 'Action: get, set, append, clear, bbcode' },
      text: { type: 'string', description: 'Text content' },
      caretPosition: { type: 'integer', minimum: 0, description: 'Caret column position' },
      selectionFrom: { type: 'integer', minimum: 0, description: 'Selection start' },
      selectionTo: { type: 'integer', minimum: 0, description: 'Selection end' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_ui_popup',
  description: 'Show/hide/popup for Popup/Dialog/Window nodes',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to Popup/Dialog/Window' },
      action: { type: 'string', enum: ['popup_centered', 'popup', 'hide', 'get_info'], description: 'Action: popup_centered, popup, hide, get_info' },
      size: { type: 'object', description: 'Popup size {x,y}' },
      title: { type: 'string', description: 'Dialog title text' },
      text: { type: 'string', description: 'Dialog body text' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_ui_tree',
  description: 'Tree control: get/select/collapse/add/remove items',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to Tree control' },
      action: { type: 'string', enum: ['get_items', 'add', 'select', 'collapse', 'expand', 'remove'], description: 'Action: get_items, select, collapse, expand, add, remove' },
      itemPath: { type: 'string', description: 'Item path (slash-separated indices)' },
      text: { type: 'string', description: 'Item text (for add)' },
      column: { type: 'integer', minimum: 0, description: 'Column index. Default: 0' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_ui_item_list',
  description: 'ItemList/OptionButton: get/select/add/remove items',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to ItemList/OptionButton' },
      action: { type: 'string', enum: ['get_items', 'select', 'add', 'remove', 'clear'], description: 'Action: get_items, select, add, remove, clear' },
      index: { type: 'integer', minimum: 0, description: 'Item index' },
      text: { type: 'string', description: 'Item text (for add)' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_ui_tabs',
  description: 'TabContainer/TabBar: get/set current tab',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to TabContainer/TabBar' },
      action: { type: 'string', enum: ['get_tabs', 'set_current', 'set_title'], description: 'Action: get_tabs, set_current, set_title' },
      index: { type: 'integer', minimum: 0, description: 'Tab index' },
      title: { type: 'string', description: 'Tab title' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_ui_menu',
  description: 'PopupMenu: add/remove/get menu items and shortcuts',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to PopupMenu/MenuBar' },
      action: { type: 'string', enum: ['get_items', 'add', 'remove', 'set_checked', 'clear'], description: 'Action: get_items, add, remove, set_checked, clear' },
      index: { type: 'integer', minimum: 0, description: 'Item index' },
      text: { type: 'string', description: 'Item text (for add)' },
      checked: { type: 'boolean', description: 'Checked state' },
      id: { type: 'integer', description: 'Item ID' },
      shortcutKey: { type: 'string', description: 'Keyboard shortcut key name for a new item' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_ui_range',
  description: 'ProgressBar/Slider/SpinBox/ColorPicker get/set',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'Path to Range/ColorPicker node' },
      action: { type: 'string', enum: ['get', 'set'], description: 'Action: get or set' },
      value: { type: 'number', description: 'Value (for Range nodes)' },
      minValue: { type: 'number', description: 'Minimum value' },
      maxValue: { type: 'number', description: 'Maximum value' },
      step: { type: 'number', description: 'Step value' },
      color: { type: 'object', description: 'Color {r,g,b,a} (for ColorPicker)' },
    },
    required: ['nodePath', 'action'],
  },
},
{
  name: 'game_render_settings',
  description: 'Get/set MSAA, FXAA, TAA, scaling mode/scale',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: get or set' },
      msaa2d: { type: 'number', description: 'MSAA 2D mode (0-3)' },
      msaa3d: { type: 'number', description: 'MSAA 3D mode (0-3)' },
      fxaa: { type: 'boolean', description: 'Enable FXAA' },
      taa: { type: 'boolean', description: 'Enable TAA' },
      scalingMode: { type: 'number', description: 'Scaling mode (0=bilinear, 1=FSR1, 2=FSR2)' },
      scalingScale: { type: 'number', description: 'Render scale (0.0-1.0)' },
    },
    required: [],
  },
},
{
  name: 'game_resource',
  description: 'Load, threaded-preload, save, or inspect project resources at runtime',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['load', 'preload', 'save', 'exists'], description: 'Action: load, preload, save, or exists' },
      path: { type: 'string', description: 'Resource path (res://)' },
      nodePath: { type: 'string', description: 'Node path whose resource property is saved' },
      property: { type: 'string', description: 'Resource-valued property to save' },
    },
    required: ['action', 'path'],
  },
},
// Batch 6: Visual Shader + Terrain + Video + CI/CD
{
  name: 'game_visual_shader',
  description: 'Create and edit VisualShader graphs: add/connect/disconnect nodes',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'add_node', 'connect', 'disconnect', 'get_nodes', 'apply'], description: 'Action: create, add_node, connect, disconnect, get_nodes, apply' },
      nodePath: { type: 'string', description: 'Target node path (for apply)' },
      shaderType: { type: 'string', description: 'Shader type: spatial, canvas_item, particles, sky, fog' },
      nodeClass: { type: 'string', description: 'VisualShaderNode class name (for add_node)' },
      position: { type: 'object', description: 'Node position {x, y} (for add_node)' },
      fromNode: { type: 'integer', minimum: 0, description: 'Source node ID (for connect/disconnect)' },
      fromPort: { type: 'integer', minimum: 0, description: 'Source port index' },
      toNode: { type: 'integer', minimum: 0, description: 'Destination node ID (for connect/disconnect)' },
      toPort: { type: 'integer', minimum: 0, description: 'Destination port index' },
      shaderId: { type: 'integer', minimum: 1, description: 'Shader resource ID (for multi-shader scenes)' },
    },
    required: ['action'],
  },
},
{
  name: 'game_terrain',
  description: 'Create/modify terrain meshes from heightmap data',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'get_height', 'modify', 'paint'], description: 'Action: create, modify, get_height, paint' },
      parentPath: { type: 'string', description: 'Parent node path' },
      nodePath: { type: 'string', description: 'Terrain node path' },
      heightData: { type: 'array', description: 'Array of float height values (for create)', items: { type: 'number' } },
      width: { type: 'integer', minimum: 2, description: 'Terrain width in vertices' },
      depth: { type: 'integer', minimum: 2, description: 'Terrain depth in vertices' },
      maxHeight: { type: 'number', description: 'Maximum terrain height' },
      x: { type: 'number', description: 'X position (for modify/get_height/paint)' },
      z: { type: 'number', description: 'Z position (for modify/get_height/paint)' },
      radius: { type: 'number', minimum: 0, description: 'Brush radius (for modify/paint)' },
      heightDelta: { type: 'number', description: 'Height change amount (for modify)' },
      color: { type: 'object', description: 'Vertex color {r,g,b,a} (for paint)' },
      name: { type: 'string', description: 'Node name' },
    },
    required: ['action'],
  },
},
{
  name: 'game_video',
  description: 'Video playback control: play, pause, stop, seek on VideoStreamPlayer',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: create, play, pause, stop, seek, get_status' },
      nodePath: { type: 'string', description: 'Path to VideoStreamPlayer node' },
      parentPath: { type: 'string', description: 'Parent node path (for create)' },
      videoPath: { type: 'string', description: 'res:// path to video file' },
      position: { type: 'number', description: 'Seek position in seconds' },
      volume: { type: 'number', description: 'Volume (linear 0-1)' },
      loop: { type: 'boolean', description: 'Enable looping' },
      autoplay: { type: 'boolean', description: 'Auto-play on ready' },
      name: { type: 'string', description: 'Node name (for create)' },
    },
    required: ['action'],
  },
},
{
  name: 'manage_ci_pipeline',
  description: 'Create/read GitHub Actions workflow for automated Godot exports',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Absolute path to Godot project' },
      action: { type: 'string', enum: ['create', 'read'], description: 'Action: create or read' },
      platforms: { type: 'array', description: 'Target platforms: windows, linux, macos, web', items: { type: 'string', enum: ['windows', 'linux', 'macos', 'web'] } },
      godotVersion: { type: 'string', pattern: '^4\\.(?:[7-9]|\\d{2,})(?:\\.\\d+)?(?:-stable)?$', description: 'Supported Godot 4.7+ version (e.g. 4.7-stable)' },
    },
    required: ['projectPath', 'action'],
  },
},
{
  name: 'manage_docker_export',
  description: 'Create Dockerfile for headless Godot export',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Absolute path to Godot project' },
      action: { type: 'string', enum: ['create', 'read'], description: 'Action: create or read' },
      godotVersion: { type: 'string', pattern: '^4\\.(?:[7-9]|\\d{2,})(?:\\.\\d+)?(?:-stable)?$', description: 'Supported Godot 4.7+ version (e.g. 4.7-stable)' },
      exportPreset: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9 _./-]{0,127}$', description: 'Export preset name (letters, digits, spaces, _, ., /, and -)' },
      baseImage: { type: 'string', enum: ['ubuntu:22.04', 'ubuntu:24.04'], description: 'Supported base Docker image (default: ubuntu:22.04)' },
    },
    required: ['projectPath', 'action'],
  },
},
] as const satisfies readonly ToolDefinition[];

export type ToolName = (typeof rawToolDefinitions)[number]['name'];

interface ActionFieldContract {
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
}

type ActionFieldContracts = Partial<Record<ToolName, Readonly<Record<string, ActionFieldContract>>>>;

/**
 * Reviewed handler contracts. Fields omitted from one action's allowed set are
 * rejected for that action, so conditionally irrelevant arguments never reach
 * a project service or the Godot runtime.
 */
const ACTION_FIELD_CONTRACTS: ActionFieldContracts = {
  editor_session: {
    ensure: { optional: ['launchIfNeeded', 'timeoutSeconds'] },
    status: {},
    disconnect: {},
  },
  run_project_tests: {
    discover: { optional: ['framework', 'testPaths'] },
    run: { optional: ['framework', 'testPaths', 'artifactPaths', 'timeoutSeconds', 'failFast'] },
  },
  manage_import_pipeline: {
    inspect: { required: ['sourcePath'] },
    change: { required: ['sourcePath', 'settings'], optional: ['timeoutSeconds'] },
    reimport: { optional: ['timeoutSeconds'] },
    dependencies: { required: ['sourcePath'] },
  },
  analyze_project_integrity: {
    analyze: { optional: ['maxFiles', 'allowProceduralMainScene'] },
    preview_rename: { required: ['sourcePath', 'destinationPath'], optional: ['maxFiles'] },
    assets: { optional: ['maxFiles'] },
    localization: { optional: ['maxFiles'] },
    accessibility: { optional: ['maxFiles'] },
    extensions: { optional: ['maxFiles'] },
    leaks: { optional: ['maxFiles'] },
  },
  verify_export_readiness: {
    inspect: { optional: ['debug', 'timeoutSeconds'] },
    export_smoke: {
      required: ['outputPath'],
      optional: ['debug', 'smoke', 'expectedOutput', 'timeoutSeconds', 'smokeTimeoutSeconds'],
    },
  },
  verify_dotnet_project: {
    inspect: { optional: ['csprojPath'] },
    restore: { optional: ['csprojPath', 'timeoutSeconds'] },
    build: { optional: ['csprojPath', 'configuration', 'expectedOutput', 'timeoutSeconds'] },
    run: { optional: ['csprojPath', 'configuration', 'expectedOutput', 'timeoutSeconds', 'runTimeoutSeconds'] },
  },
  manage_addon: {
    inspect: {},
    install: { required: ['sourcePath', 'expectedSha256'], optional: ['enable', 'expectedOutput'] },
    update: { required: ['sourcePath', 'expectedSha256'], optional: ['enable', 'expectedOutput'] },
    remove: { optional: ['expectedOutput'] },
    enable: { optional: ['expectedOutput'] },
    disable: { optional: ['expectedOutput'] },
  },
  manage_autoloads: {
    list: {},
    add: { required: ['name', 'path'] },
    remove: { required: ['name'] },
  },
  manage_input_map: {
    list: {},
    add: { required: ['actionName'], optional: ['key', 'deadzone'] },
    remove: { required: ['actionName'] },
  },
  manage_export_presets: {
    list: {},
    add: { required: ['name', 'platform'], optional: ['runnable'] },
    remove: { required: ['name'] },
  },
  manage_resource: {
    read: {},
    modify: { required: ['properties'] },
  },
  manage_scene_signals: {
    list: {},
    add: { required: ['signalName', 'sourcePath', 'targetPath', 'method'] },
    remove: { required: ['signalName'] },
  },
  manage_layers: {
    list: {},
    set: { required: ['layerType', 'layer', 'name'] },
  },
  manage_plugins: {
    list: {},
    enable: { required: ['pluginName'] },
    disable: { required: ['pluginName'] },
  },
  manage_shader: {
    read: {},
    create: { optional: ['shaderType', 'source'] },
  },
  manage_theme_resource: {
    create: { optional: ['properties'] },
    read: {},
    modify: { required: ['properties'] },
  },
  manage_scene_structure: {
    rename: { required: ['newName'] },
    duplicate: {},
    move: { required: ['newParentPath'] },
  },
  manage_translations: {
    list: {},
    add: { required: ['translationPath'] },
    remove: { required: ['translationPath'] },
  },
  manage_ci_pipeline: {
    create: { optional: ['platforms', 'godotVersion'] },
    read: {},
  },
  manage_docker_export: {
    create: { optional: ['godotVersion', 'exportPreset', 'baseImage'] },
    read: {},
  },
  game_visual_regression: {
    capture_baseline: {},
    compare: { optional: ['maskPath', 'diffArtifactPath', 'channelTolerance', 'maxDifferentPixelRatio'] },
  },
  game_performance: {
    sample: { optional: ['sampleCount'] }, start: {}, stop: {}, report: {}, leaks: {},
    stress: { optional: ['sampleCount'] },
  },
  game_play_animation: {
    play: { required: ['animation'] }, stop: {}, pause: {}, get_list: {},
  },
  game_audio_play: {
    play: { optional: ['stream', 'volume', 'pitch', 'bus', 'fromPosition'] },
    stop: {}, pause: {}, resume: {},
  },
  game_tilemap: {
    set_cells: { required: ['cells'] },
    get_cell: { required: ['x', 'y'] },
    erase_cells: { required: ['cells'] },
    get_used_cells: { optional: ['sourceId'] },
  },
  game_environment: {
    get: {},
    set: { optional: [
      'backgroundMode', 'backgroundColor', 'ambientLightColor', 'ambientLightEnergy',
      'fogEnabled', 'fogDensity', 'fogLightColor', 'glowEnabled', 'glowIntensity',
      'glowBloom', 'tonemapMode', 'ssaoEnabled', 'ssaoRadius', 'ssaoIntensity',
      'ssrEnabled', 'brightness', 'contrast', 'saturation',
    ] },
  },
  game_manage_group: {
    add: { required: ['nodePath', 'group'] },
    remove: { required: ['nodePath', 'group'] },
    get_groups: { required: ['nodePath'] },
  },
  game_serialize_state: {
    save: { optional: ['nodePath', 'maxDepth'] },
    load: { required: ['data'], optional: ['nodePath', 'maxDepth'] },
  },
  game_bone_pose: {
    list: {},
    get: { optional: ['boneIndex', 'boneName'] },
    set: { optional: ['boneIndex', 'boneName', 'position', 'rotation', 'scale'] },
  },
  game_viewport: {
    create: { optional: ['parentPath', 'width', 'height', 'msaa', 'transparentBg', 'name'] },
    configure: { required: ['nodePath'], optional: ['width', 'height', 'msaa', 'transparentBg'] },
    get: { required: ['nodePath'] },
  },
  game_debug_draw: {
    line: { required: ['from', 'to'], optional: ['color', 'duration'] },
    sphere: { optional: ['center', 'radius', 'color', 'duration'] },
    box: { required: ['center', 'size'], optional: ['color', 'duration'] },
    clear: {},
  },
  game_websocket: {
    connect: { required: ['url'], optional: ['timeout'] }, disconnect: {},
    send: { required: ['message'] }, receive: { optional: ['timeout'] }, status: {},
  },
  game_multiplayer: {
    create_server: { optional: ['port', 'maxClients'] },
    create_client: { required: ['address'], optional: ['port'] },
    disconnect: {}, status: {},
  },
  game_rpc: {
    call: { optional: ['args', 'peerId'] },
    configure: { optional: ['mode', 'sync', 'transferMode', 'channel'] },
  },
  game_touch: {
    press: { optional: ['index'] }, release: { optional: ['index'] },
    drag: { required: ['toX', 'toY'], optional: ['index', 'steps'] },
  },
  game_input_state: {
    query: { optional: ['keys', 'actions', 'mouseButtons'] },
    warp_mouse: { required: ['x', 'y'] },
    set_mouse_mode: { required: ['mouseMode'] },
  },
  game_input_action: {
    set_strength: { required: ['actionName', 'strength'] },
    add_action: { required: ['actionName'], optional: ['key'] },
    remove_action: { required: ['actionName'] }, list: {},
  },
  game_script: {
    get_source: {}, attach: { required: ['source'], optional: ['className'] }, detach: {},
  },
  game_window: {
    get: {},
    set: { optional: ['width', 'height', 'fullscreen', 'borderless', 'title', 'position', 'vsync'] },
  },
  game_time_scale: { get: {}, set: { required: ['timeScale'] } },
  game_world_settings: {
    get: {}, set: { optional: ['gravity', 'gravityDirection', 'physicsFps'] },
  },
  game_csg: {
    create: { required: ['parentPath', 'csgType'], optional: ['operation', 'size', 'radius', 'height', 'material', 'name'] },
    configure: { required: ['nodePath'], optional: ['operation', 'size', 'radius', 'height', 'material'] },
  },
  game_multimesh: {
    create: { required: ['parentPath', 'meshType', 'count'], optional: ['name'] },
    set_instance: { required: ['nodePath', 'index', 'transform'] },
    get_info: { required: ['nodePath'] },
  },
  game_light_3d: {
    create: { required: ['parentPath', 'lightType'], optional: ['color', 'energy', 'range', 'shadows', 'spotAngle', 'name'] },
    configure: { required: ['nodePath'], optional: ['color', 'energy', 'range', 'shadows', 'spotAngle'] },
  },
  game_gridmap: {
    set_cell: { required: ['x', 'y', 'z', 'item'], optional: ['orientation'] },
    get_cell: { required: ['x', 'y', 'z'] }, clear: {}, get_used: {},
  },
  game_path_3d: {
    create: { required: ['parentPath'], optional: ['points', 'name'] },
    add_point: { required: ['nodePath', 'point'] },
    get_points: { required: ['nodePath'] },
    set_points: { required: ['nodePath', 'points'] },
  },
  game_sky: {
    create: { optional: ['skyType', 'topColor', 'bottomColor', 'sunEnergy', 'groundColor'] },
  },
  game_camera_attributes: {
    get: {},
    set: { optional: ['dofBlurFar', 'dofBlurNear', 'dofBlurAmount', 'exposureMultiplier', 'autoExposure', 'autoExposureScale'] },
  },
  game_navigation_3d: {
    create: { required: ['parentPath'], optional: ['cellSize', 'agentRadius', 'agentHeight', 'name'] },
    bake: { required: ['nodePath'] },
  },
  game_physics_3d: {
    ray: { required: ['from', 'to'], optional: ['collisionMask'] },
    overlap: { required: ['nodePath'], optional: ['collisionMask'] },
    contacts: { required: ['nodePath'] }, inspect_shape: { required: ['nodePath'] },
  },
  game_canvas: {
    create_layer: { optional: ['parentPath', 'layer', 'name'] },
    create_modulate: { optional: ['parentPath', 'color', 'name'] },
    configure: { required: ['nodePath'], optional: ['layer', 'offset', 'visible', 'color'] },
  },
  game_canvas_draw: {
    line: { required: ['from', 'to'], optional: ['parentPath', 'color', 'width'] },
    rect: { required: ['rect'], optional: ['parentPath', 'color', 'width', 'filled'] },
    circle: { required: ['center', 'radius'], optional: ['parentPath', 'color', 'width', 'filled'] },
    polygon: { required: ['points'], optional: ['parentPath', 'color'] },
    text: { required: ['position', 'text'], optional: ['parentPath', 'fontSize', 'color'] },
    clear: { optional: ['parentPath'] },
  },
  game_light_2d: {
    create_point: { optional: ['parentPath', 'color', 'energy', 'range', 'name'] },
    create_directional: { optional: ['parentPath', 'color', 'energy', 'name'] },
    create_occluder: { required: ['points'], optional: ['parentPath', 'name'] },
  },
  game_parallax: {
    create_background: { optional: ['parentPath', 'scrollOffset', 'scrollBaseOffset', 'name'] },
    add_layer: { required: ['parentPath'], optional: ['motionScale', 'motionOffset', 'mirroring', 'name'] },
    configure: { required: ['nodePath'], optional: ['motionScale', 'motionOffset', 'mirroring', 'scrollOffset', 'scrollBaseOffset'] },
  },
  game_shape_2d: {
    add_point: { required: ['point'], optional: ['width', 'color'] },
    set_points: { required: ['points'], optional: ['width', 'color'] },
    clear: {}, get_points: {},
  },
  game_path_2d: {
    create: { required: ['parentPath'], optional: ['points', 'name'] },
    add_point: { required: ['nodePath', 'point'] },
    get_points: { required: ['nodePath'] },
  },
  game_physics_2d: {
    ray: { required: ['from', 'to'], optional: ['collisionMask'] },
    overlap: { required: ['nodePath'] },
    point_query: { required: ['position'], optional: ['collisionMask', 'maxResults'] },
    shape_query: { required: ['position', 'shapeType'], optional: ['radius', 'size', 'collisionMask', 'maxResults'] },
  },
  game_animation_tree: {
    travel: { required: ['stateName'] },
    set_param: { required: ['paramName', 'paramValue'] }, get_state: {},
  },
  game_animation_control: {
    seek: { required: ['position'] }, queue: { required: ['animationName'] },
    set_speed: { required: ['speed'] }, stop: {}, get_info: {},
  },
  game_skeleton_ik: {
    start: { optional: ['target'] }, stop: {}, set_target: { required: ['target'] },
  },
  game_audio_effect: {
    list: { optional: ['busName'] }, add: { required: ['effectType'], optional: ['busName', 'properties', 'enabled'] },
    remove: { required: ['index'], optional: ['busName'] },
    configure: { required: ['index'], optional: ['busName', 'properties', 'enabled'] },
  },
  game_audio_bus_layout: {
    list: {}, add: { required: ['busName'], optional: ['index'] },
    remove: { required: ['busName'] }, move: { required: ['busName', 'index'] },
    set_send: { required: ['busName', 'sendTo'] },
  },
  game_audio_spatial: {
    get_info: {},
    configure: { optional: ['maxDistance', 'unitSize', 'maxDb', 'attenuationModel'] },
  },
  game_locale: {
    get: {}, set: { required: ['locale'] }, translate: { required: ['key'], optional: ['locale'] },
  },
  game_ui_control: {
    grab_focus: {}, release_focus: {},
    configure: { optional: ['anchorPreset', 'tooltip', 'mouseFilter', 'minSize'] }, get_info: {},
  },
  game_ui_text: {
    get: {}, set: { required: ['text'], optional: ['caretPosition', 'selectionFrom', 'selectionTo'] },
    append: { required: ['text'], optional: ['caretPosition', 'selectionFrom', 'selectionTo'] },
    clear: {}, bbcode: { required: ['text'] },
  },
  game_ui_popup: {
    popup_centered: { optional: ['size', 'title', 'text'] },
    popup: { optional: ['size', 'title', 'text'] }, hide: {}, get_info: {},
  },
  game_ui_tree: {
    get_items: {}, add: { required: ['text'], optional: ['itemPath', 'column'] },
    select: { required: ['itemPath'], optional: ['column'] },
    collapse: { required: ['itemPath'] }, expand: { required: ['itemPath'] }, remove: { required: ['itemPath'] },
  },
  game_ui_item_list: {
    get_items: {}, select: { required: ['index'] }, add: { required: ['text'] },
    remove: { required: ['index'] }, clear: {},
  },
  game_ui_tabs: {
    get_tabs: {}, set_current: { required: ['index'] }, set_title: { required: ['index', 'title'] },
  },
  game_ui_menu: {
    get_items: {}, add: { required: ['text'], optional: ['id', 'shortcutKey'] },
    remove: { required: ['index'] }, set_checked: { required: ['index', 'checked'] }, clear: {},
  },
  game_ui_range: {
    get: {}, set: { optional: ['value', 'minValue', 'maxValue', 'step', 'color'] },
  },
  game_render_settings: {
    get: {}, set: { optional: ['msaa2d', 'msaa3d', 'fxaa', 'taa', 'scalingMode', 'scalingScale'] },
  },
  game_resource: {
    load: {}, preload: {}, exists: {}, save: { required: ['nodePath', 'property'] },
  },
  game_visual_shader: {
    create: { optional: ['shaderType'] },
    add_node: { required: ['nodeClass'], optional: ['shaderId', 'position'] },
    connect: { required: ['fromNode', 'fromPort', 'toNode', 'toPort'], optional: ['shaderId'] },
    disconnect: { required: ['fromNode', 'fromPort', 'toNode', 'toPort'], optional: ['shaderId'] },
    get_nodes: { optional: ['shaderId'] }, apply: { required: ['nodePath'], optional: ['shaderId'] },
  },
  game_terrain: {
    create: { required: ['parentPath'], optional: ['heightData', 'width', 'depth', 'maxHeight', 'name'] },
    get_height: { required: ['nodePath', 'x', 'z'] },
    modify: { required: ['nodePath', 'x', 'z', 'radius', 'heightDelta'] },
    paint: { required: ['nodePath', 'x', 'z', 'radius', 'color'] },
  },
  game_video: {
    create: { required: ['parentPath', 'videoPath'], optional: ['volume', 'loop', 'autoplay', 'name'] },
    play: { required: ['nodePath'], optional: ['volume', 'loop'] },
    pause: { required: ['nodePath'] }, resume: { required: ['nodePath'] }, stop: { required: ['nodePath'] },
    seek: { required: ['nodePath', 'position'] }, get_status: { required: ['nodePath'] },
  },
};

const DEFAULT_ACTIONS: Partial<Record<ToolName, string>> = {
  game_performance: 'sample', game_audio_play: 'play', game_environment: 'set',
  game_serialize_state: 'save', game_bone_pose: 'list', game_viewport: 'create',
  game_input_state: 'query', game_window: 'get', game_time_scale: 'get',
  game_world_settings: 'get', game_camera_attributes: 'get', game_render_settings: 'get',
};

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * The authored schemas are normalized once and the resulting objects are used
 * for both MCP advertisement and runtime validation. Declared objects are
 * closed recursively; intentionally free-form Dictionary/Variant objects have
 * no `properties` and therefore remain open.
 */
export const toolDefinitions: readonly (ToolDefinition & { readonly name: ToolName })[] = rawToolDefinitions.map(definition => {
  const inputSchema = closeDeclaredObjects({
    ...addManifestActionContracts(definition.name, addConditionalContracts(
      definition.name, addManifestActionEnum(definition.name, definition.inputSchema),
    )),
    $schema: JSON_SCHEMA_DIALECT,
  });
  return {
    ...definition,
    title: humanizeToolName(definition.name),
    inputSchema: addToolExamples(definition.name, inputSchema),
    outputSchema: structuredResultSchemaFor(definition.name),
  };
});

function humanizeToolName(name: string): string {
  const initialisms = new Map([
    ['2d', '2D'], ['3d', '3D'], ['ai', 'AI'], ['ci', 'CI'], ['csharp', 'C#'],
    ['dotnet', '.NET'], ['gi', 'GI'], ['http', 'HTTP'], ['mcp', 'MCP'], ['os', 'OS'],
    ['rpc', 'RPC'], ['ui', 'UI'], ['uid', 'UID'], ['url', 'URL'], ['websocket', 'WebSocket'],
  ]);
  return name.split('_').map((part, index) => {
    const known = initialisms.get(part);
    if (known) return known;
    return index === 0 || part.length > 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part;
  }).join(' ');
}

/**
 * The traceability manifest is the complete, audited action inventory. Reuse
 * it for action discriminators that older authored schemas left as an
 * unconstrained string, while preserving data-valued `action` fields such as
 * InputMap action names.
 */
function addManifestActionEnum(name: ToolName, schema: ToolPropertySchema): ToolPropertySchema {
  const actions = toolManifest[name].actions;
  const action = schema.properties?.action;
  if (!actions || !action || action.enum !== undefined) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      action: { ...action, enum: actions },
    },
  };
}

function closeDeclaredObjects(input: ToolPropertySchema, fallbackDescription?: string): ToolPropertySchema {
  const schema = normalizeUndeclaredObject(input);
  const properties = schema.properties === undefined
    ? undefined
    : Object.fromEntries(Object.entries(schema.properties).map(
      ([name, property]) => [name, closeDeclaredObjects(property, `${humanizeToolName(name)} value`)],
    ));
  const closed: ToolPropertySchema = {
    ...schema,
    ...(schema.description === undefined && fallbackDescription
      ? { description: fallbackDescription }
      : {}),
    ...(properties === undefined ? {} : { properties }),
    ...(schema.items === undefined ? {} : { items: closeDeclaredObjects(schema.items, 'Array item') }),
    ...(schema.oneOf === undefined ? {} : {
      oneOf: schema.oneOf.map((branch, index) => closeDeclaredObjects(branch, `Allowed option ${index + 1}`)),
    }),
    ...(schema.anyOf === undefined ? {} : {
      anyOf: schema.anyOf.map((branch, index) => closeDeclaredObjects(branch, `Allowed alternative ${index + 1}`)),
    }),
    ...(schema.allOf === undefined ? {} : {
      allOf: schema.allOf.map((branch, index) => closeDeclaredObjects(branch, `Required rule ${index + 1}`)),
    }),
    ...(schema.not === undefined ? {} : { not: closeDeclaredObjects(schema.not, 'Forbidden shape') }),
    ...(schema.type === 'object' && properties !== undefined && schema.additionalProperties === undefined
      ? { additionalProperties: false }
      : {}),
  };
  return closed.examples === undefined && (closed.type === 'object' || closed.type === 'array')
    ? { ...closed, examples: [schemaExample(closed)] }
    : closed;
}

function addToolExamples(name: ToolName, schema: ToolPropertySchema): ToolPropertySchema {
  const actions = toolManifest[name].actions;
  const examples = actions
    ? actions.map(action => schemaExample(schema, action))
    : [schemaExample(schema)];
  const invalidExamples: ToolSchemaInvalidExample[] = actions
    ? [
        {
          value: { ...(examples[0] as Record<string, unknown>), action: '__invalid__' },
          path: 'arguments.action', keyword: 'enum',
        },
        ...actions.map((action, index) => actionInvalidExample(schema, action, examples[index])),
      ]
    : [{
        value: { ...(examples[0] as Record<string, unknown>), unexpected: true },
        path: 'arguments.unexpected', keyword: 'additionalProperties',
      }];
  return {
    ...schema,
    examples,
    'x-invalidExamples': invalidExamples,
  };
}

function actionInvalidExample(
  schema: ToolPropertySchema,
  action: string,
  example: unknown,
): ToolSchemaInvalidExample {
  const value = { ...(example as Record<string, unknown>) };
  const branch = schema.oneOf?.find(candidate => candidate.properties?.action?.const === action);
  const missing = branch?.required?.find(field => field !== 'action' && !(schema.required ?? []).includes(field));
  if (missing) {
    const withoutMissing = Object.fromEntries(Object.entries(value).filter(([field]) => field !== missing));
    return { action, value: withoutMissing, path: `arguments.${missing}`, keyword: 'required' };
  }
  const forbidden = Object.entries(branch?.properties ?? {}).find(([field, property]) =>
    field !== 'action' && property.not !== undefined && Object.keys(property.not).length === 0);
  if (forbidden) {
    const [field] = forbidden;
    value[field] = schemaExample(schema.properties?.[field] ?? {});
    return { action, value, path: `arguments.${field}`, keyword: 'not' };
  }
  value.unexpected = true;
  return { action, value, path: 'arguments.unexpected', keyword: 'additionalProperties' };
}

function schemaExample(schema: ToolPropertySchema, requestedAction?: string): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.anyOf && schema.anyOf.length > 0) return schemaExample(schema.anyOf[0], requestedAction);
  if (schema.type === 'object') return objectExample(schema, requestedAction);
  if (schema.enum && schema.enum.length > 0) {
    return requestedAction !== undefined && schema.enum.includes(requestedAction)
      ? requestedAction
      : schema.enum[0];
  }
  if (schema.oneOf && schema.oneOf.length > 0) return schemaExample(schema.oneOf[0], requestedAction);
  if (schema.type === 'array') {
    const length = Math.max(1, schema.minItems ?? 0);
    return Array.from({ length }, () => schemaExample(schema.items ?? {}));
  }
  if (schema.type === 'boolean') return true;
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'string') {
    if (schema.pattern?.includes('https?://')) return 'http://127.0.0.1';
    if (schema.pattern?.startsWith('^4\\.')) return '4.7-stable';
    if (schema.pattern?.includes('a-fA-F0-9') && schema.pattern.includes('{64}')) return '0'.repeat(64);
    return 'value';
  }
  return null;
}

function objectExample(schema: ToolPropertySchema, requestedAction?: string): Record<string, unknown> {
  const branch = selectExampleBranch(schema, requestedAction);
  const properties = { ...(schema.properties ?? {}), ...(branch?.properties ?? {}) };
  const required = new Set([...(schema.required ?? []), ...(branch?.required ?? [])]);
  if (requestedAction !== undefined && schema.properties?.action) required.add('action');
  return Object.fromEntries([...required].map(name => [
    name,
    name === 'action' && requestedAction !== undefined
      ? requestedAction
      : schemaExample(properties[name] ?? {}),
  ]));
}

function selectExampleBranch(
  schema: ToolPropertySchema,
  requestedAction?: string,
): ToolPropertySchema | undefined {
  if (!schema.oneOf || schema.oneOf.length === 0) return undefined;
  if (requestedAction !== undefined) {
    return schema.oneOf.find(branch => branch.properties?.action?.const === requestedAction)
      ?? schema.oneOf[0];
  }
  return schema.oneOf[0];
}

function normalizeUndeclaredObject(schema: ToolPropertySchema): ToolPropertySchema {
  if (schema.type !== 'object' || schema.properties !== undefined
    || schema.additionalProperties !== undefined || schema.anyOf !== undefined) return schema;
  const compact = (schema.description ?? '').replace(/\s+/g, '').toLowerCase();
  if (compact.includes('particleprocessmaterial')) return explicitlyOpen(schema);
  if (compact.includes('{origin:{x,y,z},rotation:{x,y,z}}')) {
    return componentObject(schema, {
      origin: vectorObject('Transform origin', ['x', 'y', 'z']),
      rotation: vectorObject('Euler rotation in degrees', ['x', 'y', 'z']),
    }, ['origin']);
  }
  if (compact.includes('{x,y}or{x,y,z}')) {
    return {
      ...schema,
      anyOf: [
        vectorObject('2D component shape', ['x', 'y']),
        vectorObject('3D component shape', ['x', 'y', 'z']),
      ],
      examples: [{ x: 1, y: 2 }, { x: 1, y: 2, z: 3 }],
    };
  }
  if (compact.includes('{x,y,w,h}')) {
    return componentObject(schema, numericProperties(['x', 'y', 'w', 'h']), ['x', 'y', 'w', 'h']);
  }
  if (compact.includes('{x,y,z,w}')) {
    return componentObject(schema, numericProperties(['x', 'y', 'z', 'w']), ['x', 'y', 'z', 'w']);
  }
  if (compact.includes('{r,g,b,a}') || compact.includes('{r,g,b}')) {
    return componentObject(schema, numericProperties(['r', 'g', 'b', 'a']), ['r', 'g', 'b']);
  }
  if (compact.includes('{x,y,z}')) {
    return componentObject(schema, numericProperties(['x', 'y', 'z']), ['x', 'y', 'z']);
  }
  if (compact.includes('{x,y}')) {
    return componentObject(schema, numericProperties(['x', 'y']), ['x', 'y']);
  }
  if ((schema.description ?? '').includes('game_wait_until-compatible')) return schema;
  return explicitlyOpen(schema);
}

function explicitlyOpen(schema: ToolPropertySchema): ToolPropertySchema {
  return {
    ...schema,
    description: `${schema.description ?? 'Godot value dictionary'}. Intentionally open: keys depend on the selected Godot property or action and values may be nested Variants.`,
    additionalProperties: true,
    examples: [{}],
  };
}

function numericProperties(names: readonly string[]): Record<string, ToolPropertySchema> {
  return Object.fromEntries(names.map(name => [name, {
    type: 'number', description: `${name.toUpperCase()} numeric component`,
  }]));
}

function vectorObject(description: string, names: readonly string[]): ToolPropertySchema {
  return componentObject({ type: 'object', description }, numericProperties(names), names);
}

function componentObject(
  schema: ToolPropertySchema,
  properties: Record<string, ToolPropertySchema>,
  required: readonly string[],
): ToolPropertySchema {
  return {
    ...schema,
    properties,
    required,
    additionalProperties: false,
    examples: [Object.fromEntries(required.map(name => [name, schemaExample(properties[name] ?? {})]))],
  };
}

function selectorBranch(
  property: string,
  value: string,
  required: readonly string[] = [],
  forbidden: readonly string[] = [],
): ToolPropertySchema {
  return {
    type: 'object',
    properties: {
      [property]: { const: value },
      ...Object.fromEntries(forbidden.map(name => [name, {
        description: `${humanizeToolName(name)} is forbidden for ${property}=${value}.`,
        not: {},
      }])),
    },
    required: [property, ...required],
    additionalProperties: true,
  };
}

function addManifestActionContracts(name: ToolName, schema: ToolPropertySchema): ToolPropertySchema {
  if (schema.oneOf !== undefined) return schema;
  const contracts = ACTION_FIELD_CONTRACTS[name];
  const actions = toolManifest[name].actions;
  if (!contracts || !actions) return schema;
  const fields = Object.keys(schema.properties ?? {}).filter(field => field !== 'action');
  const common = new Set((schema.required ?? []).filter(field => field !== 'action'));
  return {
    ...schema,
    oneOf: actions.map(action => {
      const contract = contracts[action] ?? {};
      const required = contract.required ?? [];
      const allowed = new Set([...common, ...required, ...(contract.optional ?? [])]);
      const branch = selectorBranch('action', action, required, fields.filter(field => !allowed.has(field)));
      return DEFAULT_ACTIONS[name] === action && !schema.required?.includes('action')
        ? { ...branch, required: required.filter(field => field !== 'action') }
        : branch;
    }),
  };
}

function exactlyOneBranch(required: string, forbidden: readonly string[]): ToolPropertySchema {
  return {
    type: 'object',
    required: [required],
    additionalProperties: true,
    not: { anyOf: forbidden.map(name => ({ required: [name] })) },
  };
}

function waitConditionBranches(): ToolPropertySchema[] {
  return [
    selectorBranch('condition', 'connection', [], WAIT_CONDITION_FIELDS),
    selectorBranch('condition', 'node', ['nodePath'], ['property', 'value', 'signal', 'text', 'scenePath']),
    selectorBranch('condition', 'property', ['nodePath', 'property', 'value'], ['signal', 'text', 'scenePath']),
    selectorBranch('condition', 'signal', ['nodePath', 'signal'], ['property', 'value', 'text', 'scenePath']),
    selectorBranch('condition', 'log', ['text'], ['nodePath', 'property', 'value', 'signal', 'scenePath']),
    selectorBranch('condition', 'scene', ['scenePath'], ['nodePath', 'property', 'value', 'signal', 'text']),
  ];
}

function scenarioConditionSchema(description: string): ToolPropertySchema {
  return {
    type: 'object',
    description,
    properties: {
      condition: { type: 'string', enum: ['connection', 'node', 'property', 'signal', 'log', 'scene'], description: 'Condition discriminator.' },
      nodePath: { type: 'string', description: 'Runtime node path for node, property, or signal conditions.' },
      property: { type: 'string', description: 'Property name for a property condition.' },
      value: { description: 'Expected canonical Godot Variant value for a property condition.' },
      signal: { type: 'string', description: 'Signal name for a signal condition.' },
      text: { type: 'string', maxLength: 1000, description: 'Required bounded substring for a log condition.' },
      scenePath: { type: 'string', description: 'Expected current scene resource path for a scene condition.' },
      timeoutSeconds: { type: 'number', minimum: 0.05, maximum: 60, description: 'Maximum wait for this condition.' },
      pollIntervalMs: { type: 'integer', minimum: 20, maximum: 1000, description: 'Bounded polling interval.' },
    },
    required: ['condition'],
    oneOf: waitConditionBranches(),
  };
}

function scenarioStepBranch(
  type: string,
  required: readonly string[] = [],
  forbidden: readonly string[] = [],
  allowedTools?: readonly string[],
): ToolPropertySchema {
  const branch = selectorBranch('type', type, required, forbidden);
  return allowedTools
    ? {
        ...branch,
        properties: {
          ...branch.properties,
          tool: { type: 'string', enum: allowedTools, description: `Safe ${type} tool allowlist.` },
        },
      }
    : branch;
}

function addConditionalContracts(name: string, inputSchema: ToolPropertySchema): ToolPropertySchema {
  if (name === 'godot_catalog') {
    return {
      ...inputSchema,
      oneOf: [
        selectorBranch('action', 'search'),
        selectorBranch('action', 'describe', ['toolName']),
      ],
    };
  }
  if (name === 'godot_tools') {
    return {
      ...inputSchema,
      oneOf: [
        selectorBranch('action', 'search'),
        selectorBranch('action', 'describe', ['toolName']),
        selectorBranch('action', 'call', ['toolName']),
      ],
    };
  }
  if (name === 'game_key_press') {
    return {
      ...inputSchema,
      oneOf: [
        exactlyOneBranch('key', ['action', 'text']),
        exactlyOneBranch('action', ['key', 'text']),
        exactlyOneBranch('text', ['key', 'action', 'pressed', 'physical']),
      ],
    };
  }
  if (name === 'game_key_hold' || name === 'game_key_release') {
    return {
      ...inputSchema,
      oneOf: [
        exactlyOneBranch('key', ['action']),
        exactlyOneBranch('action', ['key']),
      ],
    };
  }
  if (name === 'editor_control') {
    const fields = ['nodePaths', 'scenePath', 'nodePath', 'property', 'value', 'name'] as const;
    const branch = (action: string, required: readonly string[] = []) => selectorBranch(
      'action', action, required, fields.filter(field => !required.includes(field)),
    );
    return {
      ...inputSchema,
      oneOf: [
        branch('inspect'),
        branch('select', ['nodePaths']),
        branch('save'),
        branch('reload', ['scenePath']),
        branch('open_scene', ['scenePath']),
        branch('set_property', ['nodePath', 'property', 'value']),
        branch('rename_node', ['nodePath', 'name']),
        branch('undo'),
        branch('redo'),
      ],
    };
  }
  if (name === 'game_wait_until') {
    return {
      ...inputSchema,
      oneOf: waitConditionBranches(),
    };
  }
  if (name === 'editor_transaction') {
    const operation = inputSchema.properties?.operations;
    const items = operation?.items;
    if (operation && items) {
      const operationFields = [
        'nodePath', 'parentPath', 'newParentPath', 'nodeType', 'nodeName', 'name',
        'properties', 'property', 'value', 'scenePath', 'scriptPath', 'resourcePath',
        'keepGlobalTransform',
      ] as const;
      const requirements: readonly (readonly [string, readonly string[], readonly string[]])[] = [
        ['add_node', ['nodeType', 'nodeName'], ['parentPath', 'nodeType', 'nodeName', 'properties']],
        ['remove_node', ['nodePath'], ['nodePath']],
        ['rename_node', ['nodePath', 'name'], ['nodePath', 'name']],
        ['duplicate_node', ['nodePath'], ['nodePath', 'nodeName']],
        ['reparent_node', ['nodePath', 'newParentPath'], ['nodePath', 'newParentPath', 'keepGlobalTransform']],
        ['set_properties', ['nodePath', 'properties'], ['nodePath', 'properties']],
        ['instantiate_scene', ['scenePath'], ['parentPath', 'scenePath', 'nodeName']],
        ['attach_script', ['nodePath', 'scriptPath'], ['nodePath', 'scriptPath']],
        ['assign_resource', ['nodePath', 'property', 'resourcePath'], ['nodePath', 'property', 'resourcePath']],
        ['save', [], []],
      ];
      return {
        ...inputSchema,
        properties: {
          ...inputSchema.properties,
          operations: {
            ...operation,
            items: {
              ...items,
              oneOf: requirements.map(([op, required, allowed]) => selectorBranch(
                'op', op, required, operationFields.filter(field => !allowed.includes(field)),
              )),
            },
          },
        },
      };
    }
  }
  if (name === 'game_scenario') {
    const steps = inputSchema.properties?.steps;
    const items = steps?.items;
    if (steps && items) {
      const condition = scenarioConditionSchema('Bounded game_wait_until-compatible condition for wait or assert.');
      return {
        ...inputSchema,
        properties: {
          ...inputSchema.properties,
          steps: {
            ...steps,
            items: {
              ...items,
              properties: { ...items.properties, condition },
              oneOf: [
                scenarioStepBranch('input', ['tool', 'arguments'], ['condition'], SCENARIO_INPUT_TOOLS),
                scenarioStepBranch('wait', ['condition'], ['tool', 'arguments']),
                scenarioStepBranch('observe', ['tool'], ['condition'], SCENARIO_OBSERVE_TOOLS),
                scenarioStepBranch('assert', ['condition'], ['tool', 'arguments']),
                scenarioStepBranch('screenshot', [], ['tool', 'arguments', 'condition']),
                scenarioStepBranch('performance', [], ['tool', 'arguments', 'condition']),
              ],
            },
          },
        },
      };
    }
  }
  return inputSchema;
}
