import { toolManifest } from './tool-manifest.js';
import { structuredResultSchemaFor } from './tool-output-schema.js';

const WAIT_CONDITION_FIELDS = ['nodePath', 'property', 'value', 'signal', 'text', 'scenePath', 'fresh'] as const;
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
  'x-privilege-group'?: 'reflection' | 'code-execution';
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
      backend: { type: 'string', enum: ['process', 'subprocess', 'runtime', 'runtime-buffer', 'godot-cli', 'local'], description: 'Optional execution-backend filter' },
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
      timeoutSeconds: { type: 'number', minimum: 0, maximum: 30, description: 'For action=ensure only: bounded discovery/attach wait. Do not pass it to status or disconnect. Default: 2' },
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
  description: 'Discover or run native, GUT, and GdUnit4 project tests with structured results. action=discover accepts only projectPath, action, framework, and testPaths; action=run also accepts artifactPaths, timeoutSeconds, and failFast.',
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
  description: 'Stop the currently running Godot project. This process-global tool takes no arguments; do not pass projectPath.',
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
  description: 'Get a bounded list of visible UI elements from the running game',
  inputSchema: {
    type: 'object',
    properties: {
      rootPath: { type: 'string', description: 'Optional runtime subtree root, such as "/root/Main/HUD"' },
      maxElements: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum controls returned. Default: 200' },
    },
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
  description: 'Get compact or full node info; use compact with propertyNames for small reads',
  inputSchema: {
    type: 'object',
    properties: {
      nodePath: {
        type: 'string',
        description: 'Path to the node (e.g., "/root/Player")',
      },
      detail: { type: 'string', enum: ['compact', 'full'], description: 'Compact omits methods and signals and returns only named properties. Default: full for compatibility' },
      propertyNames: { type: 'array', items: { type: 'string' }, maxItems: 64, description: 'Exact properties to include; use with detail=compact for a small response' },
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
  description: 'Property waits need reflection; wait once for a bounded runtime condition and return the last observation. For a log event, set fresh=true to ignore output emitted before the wait started.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Godot project path for trace correlation' },
      condition: { type: 'string', enum: ['connection', 'node', 'property', 'signal', 'log', 'scene'], description: 'Property waits need reflection; select the condition kind' },
      nodePath: { type: 'string', description: 'Runtime node path for node, property, or signal conditions' },
      property: { type: 'string', description: 'Property name for a property condition' },
      value: { description: 'Expected canonical Godot Variant value for a property condition' },
      signal: { type: 'string', description: 'Signal name for a signal condition' },
      text: { type: 'string', maxLength: 1000, description: 'Required bounded substring for a log condition' },
      fresh: { type: 'boolean', description: 'For log conditions, require the text to be emitted after this wait starts. Use this for event or transition proof; default: false' },
      scenePath: { type: 'string', description: 'Expected current scene resource path for a scene condition' },
      timeoutSeconds: { type: 'number', minimum: 0.05, maximum: 60, description: 'Maximum wait. Default: 10' },
      pollIntervalMs: { type: 'integer', minimum: 20, maximum: 1000, description: 'Internal poll interval. Default: 100' },
    },
    required: ['condition'],
  },
},
{
  name: 'game_scenario',
  description: 'Property waits need reflection; run bounded input, wait, assertion, screenshot, and performance steps. Put input fields inside each step arguments object. Set fresh=true on log conditions that must prove a new event.',
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
            tool: { type: 'string', description: 'Allowlisted runtime tool for input or observation steps only; wait and assert steps use condition directly' },
            arguments: { type: 'object', description: 'Arguments for the selected scenario tool, nested here; for example {"action":"move_right"} for game_key_hold. game_key_hold has no duration field.' },
            condition: { type: 'object', description: 'Put the game_wait_until-compatible condition directly on wait or assert steps; do not add game_wait_until as their tool' },
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
// File I/O tools
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
  description: 'Get new print output from the running game since the last call. This is a cursor read; it does not define the start point for a log wait.',
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
  description: 'Hold exactly one key or input action without auto-releasing. It has no duration field and returns at once; in a scenario, use a short engine-side wait or observation, then game_key_release.',
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
  description: 'Release exactly one previously held key or input action',
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
// Batch 1: Networking + Input + System + Signals + Script
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
  name: 'game_os_info',
  description: 'Get platform, locale, screen, adapter, memory info',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
// Batch 2: 3D Rendering + Lighting + Sky + Physics
// Batch 3: 2D Systems + Animation Advanced + Audio Effects
// Batch 4: Editor/Headless + Localization + Resource
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
// Batch 5: UI Controls + Rendering + Resource Runtime
// Batch 6: Visual Shader + Terrain + Video + CI/CD
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
  game_visual_regression: {
    capture_baseline: {},
    compare: { optional: ['maskPath', 'diffArtifactPath', 'channelTolerance', 'maxDifferentPixelRatio'] },
  },
  game_performance: {
    sample: { optional: ['sampleCount'] }, start: {}, stop: {}, report: {}, leaks: {},
    stress: { optional: ['sampleCount'] },
  },
  game_manage_group: {
    add: { required: ['nodePath', 'group'] },
    remove: { required: ['nodePath', 'group'] },
    get_groups: { required: ['nodePath'] },
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
};

const DEFAULT_ACTIONS: Partial<Record<ToolName, string>> = {
  game_performance: 'sample',
  game_input_state: 'query',
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
    selectorBranch('condition', 'node', ['nodePath'], ['property', 'value', 'signal', 'text', 'scenePath', 'fresh']),
    {
      ...selectorBranch('condition', 'property', ['nodePath', 'property', 'value'], ['signal', 'text', 'scenePath', 'fresh']),
      'x-privilege-group': 'reflection',
    },
    selectorBranch('condition', 'signal', ['nodePath', 'signal'], ['property', 'value', 'text', 'scenePath', 'fresh']),
    selectorBranch('condition', 'log', ['text'], ['nodePath', 'property', 'value', 'signal', 'scenePath']),
    selectorBranch('condition', 'scene', ['scenePath'], ['nodePath', 'property', 'value', 'signal', 'text', 'fresh']),
  ];
}

function scenarioConditionSchema(description: string): ToolPropertySchema {
  return {
    type: 'object',
    description,
    properties: {
      condition: { type: 'string', enum: ['connection', 'node', 'property', 'signal', 'log', 'scene'], description: 'Property waits and asserts need reflection; select the condition kind.' },
      nodePath: { type: 'string', description: 'Runtime node path for node, property, or signal conditions.' },
      property: { type: 'string', description: 'Property name for a property condition.' },
      value: { description: 'Expected canonical Godot Variant value for a property condition.' },
      signal: { type: 'string', description: 'Signal name for a signal condition.' },
      text: { type: 'string', maxLength: 1000, description: 'Required bounded substring for a log condition.' },
      fresh: { type: 'boolean', description: 'For log conditions, require the text to be emitted after this wait starts.' },
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
