// @test-kind: unit
import { describe, expect, it } from 'vitest';

import { mergeInputMapAction } from '../src/tool-handlers/project-tool-handlers.js';

const SPACE_EVENT = 'Object(InputEventKey,"physical_keycode":32)';

describe('mergeInputMapAction', () => {
  it('merges a distinct key into one action and preserves its original deadzone', () => {
    const source = [
      'config_version=5',
      '',
      '[input]',
      '',
      `jump={"deadzone": 0.25, "events": [${SPACE_EVENT}]}`,
      '',
      '[rendering]',
      '',
      'renderer/rendering_method="gl_compatibility"',
      '',
    ].join('\n');

    const merged = mergeInputMapAction(source, 'jump', 0.75, 87);

    expect(merged).toMatchObject({ existed: true, eventAdded: true });
    expect(merged.content.match(/^jump=/gm)).toHaveLength(1);
    expect(merged.content).toContain('"deadzone": 0.25');
    expect(merged.content).toContain('"physical_keycode":32');
    expect(merged.content).toContain('"physical_keycode":87');
    expect(merged.content).toContain('[rendering]\n\nrenderer/rendering_method="gl_compatibility"');
  });

  it('de-duplicates a repeated physical keycode byte-for-byte', () => {
    const source = `[input]\n\njump={"deadzone": 0.5, "events": [${SPACE_EVENT}]}\n`;
    const merged = mergeInputMapAction(source, 'jump', 0.8, 32);

    expect(merged).toEqual({ content: source, existed: true, eventAdded: false });
    expect(merged.content.match(/"physical_keycode":32/g)).toHaveLength(1);
  });

  it('adds the first event to an action that previously had none', () => {
    const merged = mergeInputMapAction('[input]\n\nmove={"deadzone": 0.4}\n', 'move', 0.9, 65);

    expect(merged).toMatchObject({ existed: true, eventAdded: true });
    expect(merged.content).toContain('move={"deadzone": 0.4, "events": [');
    expect(merged.content).toContain('"physical_keycode":65');
  });

  it('only considers entries inside the input section', () => {
    const source = '[custom]\n\njump={"deadzone": 0.1}\n';
    const merged = mergeInputMapAction(source, 'jump', 0.6, 74);

    expect(merged.existed).toBe(false);
    expect(merged.content.match(/^jump=/gm)).toHaveLength(2);
    expect(merged.content).toContain('[input]');
  });
});
