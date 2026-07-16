import { randomUUID } from 'node:crypto';

export type LifecyclePhase = 'start' | 'backend' | 'sync' | 'commit' | 'finish' | 'cleanup' | 'state';
export type LifecycleOutcome = 'running' | 'success' | 'failure' | 'timeout' | 'fallback' | 'paused' | 'conflict' | 'cancelled';

export interface LifecycleTraceEvent extends Record<string, unknown> {
  event_id: number;
  timestamp: string;
  correlation_id: string;
  parent_correlation_id?: string;
  tool: string;
  command: string;
  target_backend: string;
  phase: LifecyclePhase;
  outcome: LifecycleOutcome;
  duration_ms: number;
  source: 'agent' | 'automatic';
  details?: unknown;
}

export interface TraceSpan {
  projectPath: string;
  correlationId: string;
  parentCorrelationId?: string;
  tool: string;
  command: string;
  backend: string;
  startedAt: number;
}

export interface LifecycleTraceOptions {
  capacity?: number;
  onEvent?: (projectPath: string, event: LifecycleTraceEvent) => void;
  now?: () => number;
}

/** Bounded, correlated, per-project lifecycle evidence with secret-safe payloads. */
export class LifecycleTrace {
  private readonly buffers = new Map<string, LifecycleTraceEvent[]>();
  private readonly capacity: number;
  private readonly now: () => number;
  private nextEventId: number;

  constructor(private readonly options: LifecycleTraceOptions = {}) {
    this.capacity = Math.max(200, options.capacity ?? 200);
    this.now = options.now ?? Date.now;
    this.nextEventId = Math.floor(this.now() * 1_000);
  }

  begin(
    projectPath: string,
    tool: string,
    command: string,
    backend: string,
    identifiers: { correlationId?: string; parentCorrelationId?: string } = {},
  ): TraceSpan {
    const span: TraceSpan = {
      projectPath,
      correlationId: identifiers.correlationId ?? randomUUID(),
      ...(identifiers.parentCorrelationId ? { parentCorrelationId: identifiers.parentCorrelationId } : {}),
      tool, command, backend, startedAt: this.now(),
    };
    this.record(projectPath, {
      correlation_id: span.correlationId,
      ...(span.parentCorrelationId ? { parent_correlation_id: span.parentCorrelationId } : {}),
      tool, command, target_backend: backend,
      phase: 'start', outcome: 'running', duration_ms: 0, source: 'agent',
    });
    return span;
  }

  finish(span: TraceSpan, outcome: LifecycleOutcome, details?: unknown): LifecycleTraceEvent {
    return this.record(span.projectPath, {
      correlation_id: span.correlationId, tool: span.tool, command: span.command,
      ...(span.parentCorrelationId ? { parent_correlation_id: span.parentCorrelationId } : {}),
      target_backend: span.backend, phase: 'finish', outcome,
      duration_ms: Math.max(0, this.now() - span.startedAt), source: 'agent',
      ...(details === undefined ? {} : { details }),
    });
  }

  record(
    projectPath: string,
    event: Omit<LifecycleTraceEvent, 'event_id' | 'timestamp'>,
  ): LifecycleTraceEvent {
    const safe = redactAndBound(event) as Omit<LifecycleTraceEvent, 'event_id' | 'timestamp'>;
    const full = {
      ...safe,
      event_id: this.nextEventId++,
      timestamp: new Date(this.now()).toISOString(),
    } as LifecycleTraceEvent;
    const buffer = this.buffers.get(projectPath) ?? [];
    buffer.push(full);
    if (buffer.length > this.capacity) buffer.splice(0, buffer.length - this.capacity);
    this.buffers.set(projectPath, buffer);
    this.options.onEvent?.(projectPath, full);
    return full;
  }

  events(projectPath: string): readonly LifecycleTraceEvent[] {
    return (this.buffers.get(projectPath) ?? []).map(event => ({ ...event }));
  }
}

export function redactAndBound(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (looksLikeLargeBase64(value)) return `[binary omitted: ${value.length} characters]`;
    return value.length > 500 ? `${value.slice(0, 497)}...` : value;
  }
  if (depth >= 4) return '[depth omitted]';
  if (Array.isArray(value)) {
    const bounded = value.slice(0, 20).map(item => redactAndBound(item, depth + 1));
    if (value.length > 20) bounded.push(`[${value.length - 20} more items]`);
    return bounded;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      result[key] = SECRET_KEY.test(key) ? '[redacted]' : redactAndBound(item, depth + 1);
    }
    return result;
  }
  return typeof value === 'symbol' ? value.description ?? 'symbol' : typeof value;
}

const SECRET_KEY = /(?:^|_)(?:token|secret|password|credential|authorization|api_?key|private_?key)(?:$|_)/i;

function looksLikeLargeBase64(value: string): boolean {
  return value.length > 1_024 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}
