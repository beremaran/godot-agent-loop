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
});
