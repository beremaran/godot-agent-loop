import { isToolCallAllowedWhilePaused, isToolCallMutating } from './tool-mutation-policy.js';
import { isAbortError, setToolResultMetadata, type ToolExecutionContext } from './execution-context.js';
import { createErrorResponse, type ToolArguments, type ToolResponse } from './utils.js';
import { EditorBridgeCompatibilityError } from './editor-connection.js';

export const EDITOR_DRIVER_STATE_COMMAND = 'driver_state';
export const EDITOR_DRIVER_STATE_TIMEOUT_MS = 500;
export const AGENT_MUTATIONS_PAUSED_MESSAGE =
  'Agent mutation refused: mutations are paused in the Godot editor. Use Resume Agent in the Agent Activity dock to continue.';

export type ReadEditorDriverState = (
  projectPath: string,
  command: typeof EDITOR_DRIVER_STATE_COMMAND,
  params: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

/** Cooperative, editor-owned gate applied after validation and before dispatch. */
export class EditorMutationGuard {
  constructor(
    private readonly readDriverState: ReadEditorDriverState,
    private readonly hasAttachedEditor: (projectPath: string) => boolean = () => false,
  ) {}

  async check(name: string, args: ToolArguments, context?: ToolExecutionContext): Promise<ToolResponse | undefined> {
    if (!isToolCallMutating(name, args)) return undefined;
    if (context?.safeWhilePaused === true || isToolCallAllowedWhilePaused(name, args)) return undefined;
    const projectPath = context?.projectPath ?? (typeof args.projectPath === 'string' ? args.projectPath : undefined);
    if (!projectPath) return undefined;
    const attachedBeforeCheck = this.hasAttachedEditor(projectPath);

    try {
      const state = await this.readDriverState(
        projectPath,
        EDITOR_DRIVER_STATE_COMMAND,
        {},
        EDITOR_DRIVER_STATE_TIMEOUT_MS,
        context?.signal,
      );
      if (state.paused === true) {
        return setToolResultMetadata(createErrorResponse(AGENT_MUTATIONS_PAUSED_MESSAGE), { outcome: 'paused' });
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof EditorBridgeCompatibilityError) {
        return setToolResultMetadata(createErrorResponse(`Agent mutation refused: ${error.message}`), { outcome: 'failure' });
      }
      if (attachedBeforeCheck) {
        const reason = error instanceof Error ? error.message : String(error);
        return setToolResultMetadata(createErrorResponse(
          `Agent mutation refused: the attached editor's pause state could not be confirmed (${reason}). Reconnect the editor session or explicitly disconnect it before retrying.`,
        ), { outcome: 'failure' });
      }
      // The addon is optional. No reachable editor means there is no human-held
      // cooperative lock to honor, so normal unattended operation continues.
    }
    return undefined;
  }
}
