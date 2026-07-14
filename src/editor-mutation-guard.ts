import { isToolCallMutating } from './tool-mutation-policy.js';
import { createErrorResponse, type ToolArguments, type ToolResponse } from './utils.js';
import { EditorBridgeCompatibilityError } from './editor-connection.js';

export const EDITOR_DRIVER_STATE_COMMAND = 'driver_state';
export const EDITOR_DRIVER_STATE_TIMEOUT_MS = 500;
export const AGENT_MUTATIONS_PAUSED_MESSAGE =
  'Agent mutation refused: mutations are paused in the Godot editor. Use Resume Agent in the Agent Activity dock to continue.';

export type ReadEditorDriverState = (
  command: typeof EDITOR_DRIVER_STATE_COMMAND,
  params: Record<string, unknown>,
  timeoutMs: number,
) => Promise<Record<string, unknown>>;

/** Cooperative, editor-owned gate applied after validation and before dispatch. */
export class EditorMutationGuard {
  constructor(private readonly readDriverState: ReadEditorDriverState) {}

  async check(name: string, args: ToolArguments): Promise<ToolResponse | undefined> {
    if (!isToolCallMutating(name, args)) return undefined;

    try {
      const state = await this.readDriverState(
        EDITOR_DRIVER_STATE_COMMAND,
        {},
        EDITOR_DRIVER_STATE_TIMEOUT_MS,
      );
      if (state.paused === true) return createErrorResponse(AGENT_MUTATIONS_PAUSED_MESSAGE);
    } catch (error) {
      if (error instanceof EditorBridgeCompatibilityError) {
        return createErrorResponse(`Agent mutation refused: ${error.message}`);
      }
      // The addon is optional. No reachable editor means there is no human-held
      // cooperative lock to honor, so normal unattended operation continues.
    }
    return undefined;
  }
}
