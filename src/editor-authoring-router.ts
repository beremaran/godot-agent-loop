import type { HeadlessOperationResult } from './headless-operation-runner.js';
import type { PublicEditorSession } from './editor-session-registry.js';
import type { OperationParams } from './utils.js';

export interface EditorAuthoringAttempt {
  handled: boolean;
  result?: HeadlessOperationResult;
  fallbackReason?: string;
}

export interface EditorAuthoringRouterOptions {
  status(projectPath: string): Promise<PublicEditorSession>;
  send(
    projectPath: string,
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;
}

interface EditorTransactionRequest extends Record<string, unknown> {
  scene_path: string;
  name: string;
  operations: Record<string, unknown>[];
  save: boolean;
  root_type?: string;
  focus_path?: string;
}

/** Maps legacy authoring commands onto atomic, undoable editor transactions. */
export class EditorAuthoringRouter {
  constructor(private readonly options: EditorAuthoringRouterOptions) {}

  async tryExecute(
    command: string,
    params: OperationParams,
    projectPath: string,
  ): Promise<EditorAuthoringAttempt> {
    const resourceRequest = editorResourceTransactionFor(command, params);
    const request = resourceRequest ?? editorTransactionFor(command, params);
    if (!request) {
      return {
        handled: false,
        fallbackReason: `The editor backend does not support ${command}; using the declared authoring fallback`,
      };
    }
    const session = await this.options.status(projectPath);
    if (!session.connected) {
      return {
        handled: false,
        fallbackReason: `Editor session unavailable (${session.state})${session.reason ? `: ${session.reason}` : ''}`,
      };
    }
    try {
      const response = await this.options.send(
        projectPath,
        resourceRequest ? 'resource_transaction' : 'transaction',
        request,
        30_000,
      );
      if (typeof response.error === 'string' && response.error.length > 0) {
        return failedAttempt(`Editor transaction failed: ${response.error}`, response);
      }
      if (response.success !== true) {
        return failedAttempt('Editor transaction returned an invalid result', response);
      }
      return {
        handled: true,
        result: {
          stdout: JSON.stringify({
            ...response,
            backend: 'editor',
            sync_status: 'acknowledged',
            editor_session: session,
            fallback_reason: null,
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
        },
      };
    } catch (error: unknown) {
      // The transaction may already have reached Godot. Never retry it through
      // another backend, because doing so could duplicate a partial mutation.
      return failedAttempt(
        `Editor transaction transport failed after dispatch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function editorResourceTransactionFor(
  command: string,
  params: OperationParams,
): Record<string, unknown> | null {
  const resourcePath = stringParam(params, 'resourcePath');
  if (!resourcePath) return null;
  if (command === 'authoring_create_resource') {
    const resourceType = stringParam(params, 'resourceType');
    if (!resourceType) return null;
    return {
      resource_path: toResourcePath(resourcePath),
      resource_type: resourceType,
      name: `Create ${resourceType}`,
      properties: objectParam(params, 'properties') ?? {},
    };
  }
  if (command === 'authoring_manage_resource' && params.action === 'modify') {
    return {
      resource_path: toResourcePath(resourcePath),
      name: `Modify ${resourcePath.split('/').at(-1) ?? 'resource'}`,
      properties: objectParam(params, 'properties') ?? {},
    };
  }
  return null;
}

function failedAttempt(message: string, details?: Record<string, unknown>): EditorAuthoringAttempt {
  return {
    handled: true,
    result: {
      stdout: '',
      stderr: details ? `${message}: ${JSON.stringify(details)}` : message,
      exitCode: 1,
      signal: null,
    },
  };
}

function editorTransactionFor(command: string, params: OperationParams): EditorTransactionRequest | null {
  const scenePath = stringParam(params, 'scenePath');
  if (!scenePath) return null;
  const base = {
    scene_path: toResourcePath(scenePath),
    save: true,
  };
  switch (command) {
    case 'authoring_create_scene':
      return {
        ...base,
        name: 'Create scene',
        root_type: stringParam(params, 'rootNodeType') ?? 'Node2D',
        operations: [{ op: 'save' }],
        focus_path: '.',
      };
    case 'authoring_add_node': {
      const nodeName = stringParam(params, 'nodeName');
      const parentPath = normalizeNodePath(stringParam(params, 'parentNodePath') ?? '.');
      if (!nodeName) return null;
      return {
        ...base,
        name: `Add ${nodeName}`,
        operations: [{
          op: 'add_node',
          parent_path: parentPath,
          node_type: stringParam(params, 'nodeType') ?? 'Node',
          node_name: nodeName,
          properties: objectParam(params, 'properties') ?? {},
        }],
        focus_path: joinNodePath(parentPath, nodeName),
      };
    }
    case 'authoring_modify_node': {
      const nodePath = normalizeNodePath(stringParam(params, 'nodePath') ?? '.');
      return {
        ...base,
        name: `Modify ${nodePath}`,
        operations: [{ op: 'set_properties', node_path: nodePath, properties: objectParam(params, 'properties') ?? {} }],
        focus_path: nodePath,
      };
    }
    case 'authoring_remove_node': {
      const nodePath = normalizeNodePath(stringParam(params, 'nodePath') ?? '.');
      return {
        ...base,
        name: `Remove ${nodePath}`,
        operations: [{ op: 'remove_node', node_path: nodePath }],
        focus_path: parentNodePath(nodePath),
      };
    }
    case 'authoring_attach_script': {
      const nodePath = normalizeNodePath(stringParam(params, 'nodePath') ?? '.');
      const scriptPath = stringParam(params, 'scriptPath');
      if (!scriptPath) return null;
      return {
        ...base,
        name: `Attach script to ${nodePath}`,
        operations: [{ op: 'attach_script', node_path: nodePath, script_path: toResourcePath(scriptPath) }],
        focus_path: nodePath,
      };
    }
    case 'authoring_save_scene':
      if (stringParam(params, 'newPath')) return null;
      return { ...base, name: 'Save scene', operations: [{ op: 'save' }], focus_path: '.' };
    case 'authoring_manage_scene_structure':
      return manageStructureTransaction(base, params);
    default:
      return null;
  }
}

function manageStructureTransaction(
  base: Pick<EditorTransactionRequest, 'scene_path' | 'save'>,
  params: OperationParams,
): EditorTransactionRequest | null {
  const action = stringParam(params, 'action');
  const nodePath = normalizeNodePath(stringParam(params, 'nodePath') ?? '.');
  if (action === 'rename') {
    const newName = stringParam(params, 'newName');
    if (!newName) return null;
    return {
      ...base,
      name: `Rename ${nodePath}`,
      operations: [{ op: 'rename_node', node_path: nodePath, name: newName }],
      focus_path: joinNodePath(parentNodePath(nodePath), newName),
    };
  }
  if (action === 'duplicate') {
    return {
      ...base,
      name: `Duplicate ${nodePath}`,
      operations: [{ op: 'duplicate_node', node_path: nodePath }],
    };
  }
  if (action === 'move') {
    const newParentPath = stringParam(params, 'newParentPath');
    if (!newParentPath) return null;
    const normalizedParent = normalizeNodePath(newParentPath);
    return {
      ...base,
      name: `Move ${nodePath}`,
      operations: [{ op: 'reparent_node', node_path: nodePath, new_parent_path: normalizedParent }],
      focus_path: joinNodePath(normalizedParent, nodePath.split('/').at(-1) ?? nodePath),
    };
  }
  return null;
}

function stringParam(params: OperationParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function objectParam(params: OperationParams, key: string): Record<string, unknown> | undefined {
  const value = params[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toResourcePath(path: string): string {
  return path.startsWith('res://') ? path : `res://${path.replace(/^\/+/, '')}`;
}

function normalizeNodePath(path: string): string {
  const normalized = path.replace(/^\/?root\/?/, '').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized.length > 0 ? normalized : '.';
}

function parentNodePath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash);
}

function joinNodePath(parent: string, child: string): string {
  return parent === '.' ? child : `${parent.replace(/\/$/, '')}/${child}`;
}
