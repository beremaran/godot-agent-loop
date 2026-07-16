// @test-kind: unit
import { describe, expect, it } from 'vitest';
import { LifecycleTrace, redactAndBound } from '../src/lifecycle-trace.js';

describe('LifecycleTrace', () => {
  it('keeps at least 200 monotonic correlated events per project without cross-routing', () => {
    let now = 1_000;
    const trace = new LifecycleTrace({ capacity: 200, now: () => now++ });
    for (let index = 0; index < 205; index++) {
      const span = trace.begin('/one', 'write_file', 'write', 'filesystem');
      trace.finish(span, 'success');
    }
    const one = trace.events('/one');
    expect(one).toHaveLength(200);
    expect(one[0].event_id).toBeLessThan(one.at(-1)!.event_id);
    expect(new Set(one.map(event => event.correlation_id)).size).toBe(100);
    expect(trace.events('/two')).toEqual([]);
  });

  it('redacts secret-shaped fields and bounds payloads, arrays, depth, and base64', () => {
    const safe = redactAndBound({
      token: 'never', nested: { api_key: 'never', value: 'x'.repeat(900) },
      array: Array.from({ length: 30 }, (_, index) => index),
      image: 'a'.repeat(2_000),
    });
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('never');
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('more items');
    expect(serialized).toContain('binary omitted');
    expect(serialized.length).toBeLessThan(2_000);
  });

  it('uses the same correlation id for start and final outcome', () => {
    const trace = new LifecycleTrace();
    const span = trace.begin('/project', 'editor_transaction', 'transaction', 'editor');
    trace.finish(span, 'conflict', { token: 'hidden' });
    const [start, finish] = trace.events('/project');
    expect(start.correlation_id).toBe(finish.correlation_id);
    expect(finish).toMatchObject({ phase: 'finish', outcome: 'conflict' });
    expect(JSON.stringify(finish)).not.toContain('hidden');
  });

  it('forwards every terminal outcome with complete bounded Activity fields', () => {
    let now = 10_000;
    const activity: import('../src/lifecycle-trace.js').LifecycleTraceEvent[] = [];
    const trace = new LifecycleTrace({
      now: () => now += 5,
      onEvent: (_projectPath, event) => { activity.push(event); },
    });
    const outcomes = [
      'success', 'failure', 'timeout', 'fallback', 'conflict', 'paused', 'cancelled',
    ] as const;

    for (const outcome of outcomes) {
      const span = trace.begin('/project', 'godot_call', `effective_${outcome}`, 'runtime', {
        correlationId: `trace-${outcome}`, parentCorrelationId: 'parent-trace',
      });
      trace.finish(span, outcome, {
        synchronization: outcome === 'conflict' ? 'conflict' : outcome === 'fallback' ? 'detached' : undefined,
        token: 'never-forward-this',
      });
    }

    const terminal = activity.filter(event => event.phase === 'finish');
    expect(terminal.map(event => event.outcome)).toEqual(outcomes);
    for (const event of terminal) {
      expect(event).toMatchObject({
        event_id: expect.any(Number), timestamp: expect.any(String),
        correlation_id: `trace-${event.outcome}`, parent_correlation_id: 'parent-trace',
        tool: 'godot_call', command: `effective_${event.outcome}`,
        target_backend: 'runtime', phase: 'finish', source: 'agent',
        duration_ms: expect.any(Number),
      });
    }
    expect(JSON.stringify(activity)).not.toContain('never-forward-this');
  });
});
