import type { PublicEditorSession } from './editor-session-registry.js';
import { EditorSessionUnavailableError } from './editor-session-registry.js';
import type { AuthoringProjectWrite } from './authoring-session-manager.js';

export type EditorSyncStatus = 'acknowledged' | 'detached' | 'timeout' | 'conflict' | 'failed';

export interface EditorSyncResult extends Record<string, unknown> {
  sync_status: EditorSyncStatus;
  editor_session: PublicEditorSession | null;
  fallback_reason: string | null;
  observed_target_state: Record<string, unknown> | null;
  attempts: number;
}

interface PendingBatch {
  events: AuthoringProjectWrite[];
  resolvers: ((result: EditorSyncResult) => void)[];
  timer: NodeJS.Timeout;
}

export interface EditorSyncQueueOptions {
  send: (projectPath: string, params: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>;
  status: (projectPath: string) => Promise<PublicEditorSession>;
  debounceMs?: number;
  timeoutMs?: number;
}

/** Debounces writes and serializes acknowledged filesystem synchronization per project. */
export class EditorSyncQueue {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly debounceMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: EditorSyncQueueOptions) {
    this.debounceMs = options.debounceMs ?? 40;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async enqueue(event: AuthoringProjectWrite): Promise<EditorSyncResult> {
    try {
      const editorSession = await this.options.status(event.project_path);
      if (!editorSession.connected) return detachedResult(editorSession);
    } catch (error) {
      if (error instanceof EditorSessionUnavailableError) return detachedResult(error.session);
      return {
        sync_status: 'failed', editor_session: null, fallback_reason: errorMessage(error),
        observed_target_state: null, attempts: 1,
      };
    }
    return new Promise(resolve => {
      const existing = this.pending.get(event.project_path);
      if (existing) {
        existing.events.push(event);
        existing.resolvers.push(resolve);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => { this.flush(event.project_path); }, this.debounceMs);
        return;
      }
      const batch: PendingBatch = {
        events: [event],
        resolvers: [resolve],
        timer: setTimeout(() => { this.flush(event.project_path); }, this.debounceMs),
      };
      this.pending.set(event.project_path, batch);
    });
  }

  private flush(projectPath: string): void {
    const batch = this.pending.get(projectPath);
    if (!batch) return;
    this.pending.delete(projectPath);
    const previous = this.tails.get(projectPath) ?? Promise.resolve();
    const operation = previous.then(() => this.synchronize(projectPath, batch.events));
    const settled = operation.then(result => {
      for (const resolve of batch.resolvers) resolve(result);
    }, error => {
      const result: EditorSyncResult = {
        sync_status: 'failed', editor_session: null, fallback_reason: errorMessage(error),
        observed_target_state: null, attempts: 1,
      };
      for (const resolve of batch.resolvers) resolve(result);
    });
    const tail = settled.then(() => undefined, () => undefined);
    this.tails.set(projectPath, tail);
    void tail.finally(() => {
      if (this.tails.get(projectPath) === tail) this.tails.delete(projectPath);
    });
  }

  private async synchronize(projectPath: string, events: AuthoringProjectWrite[]): Promise<EditorSyncResult> {
    const final = events.at(-1)!;
    const params = {
      project_path: projectPath,
      command: final.command,
      changes: events.map(event => ({
        command: event.command,
        scene_path: event.scene_path ?? null,
        resource_path: event.resource_path ?? null,
        focus_path: event.focus_path ?? null,
      })),
      ...(final.scene_path ? { scene_path: final.scene_path } : {}),
      ...(final.resource_path ? { resource_path: final.resource_path } : {}),
      ...(final.focus_path ? { focus_path: final.focus_path } : {}),
    };
    try {
      const initialSession = await this.options.status(projectPath);
      if (!initialSession.connected) {
        return detachedResult(initialSession);
      }
      const response = await this.options.send(projectPath, params, this.timeoutMs);
      const editorSession = await this.options.status(projectPath);
      const conflict = response.error === 'unsaved_conflict' || response.state === 'unsaved_conflict';
      return {
        sync_status: conflict ? 'conflict' : response.success === true ? 'acknowledged' : 'failed',
        editor_session: editorSession,
        fallback_reason: conflict ? 'The open scene has unsaved human changes; disk state was not reloaded.'
          : response.success === true ? null : errorMessage(response.error ?? 'Editor did not acknowledge synchronization'),
        observed_target_state: asRecord(response.observed_target_state) ?? response,
        attempts: 1,
      };
    } catch (error) {
      if (error instanceof EditorSessionUnavailableError) {
        return {
          sync_status: 'detached', editor_session: error.session,
          fallback_reason: 'No attached editor was available to acknowledge the persisted mutation.',
          observed_target_state: null, attempts: 1,
        };
      }
      const timeout = /timed out/i.test(errorMessage(error));
      let session: PublicEditorSession | null = null;
      try { session = await this.options.status(projectPath); } catch { /* status is supplemental */ }
      return {
        sync_status: timeout ? 'timeout' : 'failed', editor_session: session,
        fallback_reason: errorMessage(error), observed_target_state: null, attempts: 1,
      };
    }
  }
}

function detachedResult(editorSession: PublicEditorSession): EditorSyncResult {
  return {
    sync_status: 'detached', editor_session: editorSession,
    fallback_reason: `No attached editor was available to acknowledge the persisted mutation (${editorSession.state}).`,
    observed_target_state: null, attempts: 1,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
