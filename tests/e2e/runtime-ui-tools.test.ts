// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function payload(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function startedGame(): Promise<E2EServer> {
  server = await startServer({ allowPrivileged: true });
  const started = await server.call('run_project', { projectPath: server.projectPath });
  expect(started.isError, started.text).toBe(false);
  await server.waitForGameConnection();
  return server;
}

async function evalResult(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return (payload(result.text) as { result: unknown }).result;
}

async function addUiFixtures(game: E2EServer): Promise<void> {
  expect(await evalResult(game, [
    'var ui := Control.new()',
    'ui.name = "UI"',
    'ui.size = Vector2(640, 360)',
    'get_tree().root.get_node("Main").add_child(ui)',
    'var fixtures := [Button.new(), LineEdit.new(), TextEdit.new(), RichTextLabel.new(), ItemList.new(), OptionButton.new(), HSlider.new(), ProgressBar.new(), SpinBox.new(), ColorPicker.new()]',
    'var names := ["Button", "Line", "Edit", "Rich", "Items", "Options", "Slider", "Progress", "Spin", "Picker"]',
    'for i in fixtures.size():',
    '\tfixtures[i].name = names[i]',
    '\tui.add_child(fixtures[i])',
    '(ui.get_node("Button") as Button).focus_mode = Control.FOCUS_ALL',
    'return ui.get_child_count()',
  ].join('\n'))).toBe(10);
}

describe('runtime UI tools through MCP', () => {
  it('game_ui_theme and game_ui_control cover overrides, focus, configuration, and responsive layout', async () => {
    const game = await startedGame();
    await addUiFixtures(game);

    const themed = await game.call('game_ui_theme', {
      nodePath: '/root/Main/UI/Button',
      overrides: {
        colors: { font_color: { r: 0.2, g: 0.4, b: 0.6, a: 1 } },
        constants: { outline_size: 3 },
        fontSizes: { font_size: 22 },
      },
    });
    expect(themed.isError, themed.text).toBe(false);
    expect(payload(themed.text)).toMatchObject({
      applied: ['color:font_color', 'constant:outline_size', 'font_size:font_size'],
    });

    const configured = await game.call('game_ui_control', {
      nodePath: '/root/Main/UI/Button', action: 'configure', anchorPreset: 'full_rect',
      tooltip: 'inspect', mouseFilter: 'ignore', minSize: { x: 120, y: 40 },
    });
    expect(configured.isError, configured.text).toBe(false);
    expect((await game.call('game_ui_control', {
      nodePath: '/root/Main/UI/Button', action: 'grab_focus',
    })).isError).toBe(false);
    const focused = await game.call('game_ui_control', {
      nodePath: '/root/Main/UI/Button', action: 'get_info',
    });
    expect(payload(focused.text)).toMatchObject({ has_focus: true, tooltip: 'inspect', mouse_filter: 2 });

    const firstLayout = await evalResult(game, [
      'var ui := get_tree().root.get_node("Main/UI") as Control',
      'var button := ui.get_node("Button") as Button',
      'return {"size": button.size, "anchors": [button.anchor_left, button.anchor_top, button.anchor_right, button.anchor_bottom], "min": button.custom_minimum_size, "color": button.get_theme_color("font_color"), "outline": button.get_theme_constant("outline_size"), "font_size": button.get_theme_font_size("font_size")}',
    ].join('\n')) as Record<string, unknown>;
    expect(firstLayout).toMatchObject({
      size: { x: 640, y: 360 }, anchors: [0, 0, 1, 1], min: { x: 120, y: 40 }, outline: 3, font_size: 22,
    });
    expect((firstLayout.color as { b: number }).b).toBeCloseTo(0.6);

    expect(await evalResult(game, [
      'var ui := get_tree().root.get_node("Main/UI") as Control',
      'ui.size = Vector2(800, 600)',
      'return (ui.get_node("Button") as Button).size',
    ].join('\n'))).toEqual({ x: 800, y: 600 });

    expect((await game.call('game_ui_control', {
      nodePath: '/root/Main/UI/Button', action: 'configure', tooltip: '',
    })).isError).toBe(false);
    expect((await game.call('game_ui_control', {
      nodePath: '/root/Main/UI/Button', action: 'release_focus',
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var button := get_tree().root.get_node("Main/UI/Button") as Button',
      'return {"tooltip": button.tooltip_text, "focus": button.has_focus()}',
    ].join('\n'))).toEqual({ tooltip: '', focus: false });
  });

  it('game_ui_text covers every action, all text subclasses, caret state, selection, and bbcode', async () => {
    const game = await startedGame();
    await addUiFixtures(game);

    expect((await game.call('game_ui_text', {
      nodePath: '/root/Main/UI/Line', action: 'set', text: 'abcdef', caretPosition: 5,
      selectionFrom: 1, selectionTo: 4,
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var line := get_tree().root.get_node("Main/UI/Line") as LineEdit',
      'return {"caret": line.caret_column, "selected": line.has_selection(), "from": line.get_selection_from_column(), "to": line.get_selection_to_column()}',
    ].join('\n'))).toMatchObject({ caret: 5, selected: true, from: 1, to: 4 });
    expect((await game.call('game_ui_text', {
      nodePath: '/root/Main/UI/Line', action: 'append', text: '-tail', caretPosition: 11,
    })).isError).toBe(false);
    const line = await game.call('game_ui_text', { nodePath: '/root/Main/UI/Line', action: 'get' });
    expect(payload(line.text)).toMatchObject({ text: 'abcdef-tail' });
    expect(await evalResult(game, [
      'var line := get_tree().root.get_node("Main/UI/Line") as LineEdit',
      'return {"caret": line.caret_column, "selected": line.has_selection()}',
    ].join('\n'))).toMatchObject({ caret: 11, selected: false });

    expect((await game.call('game_ui_text', {
      nodePath: '/root/Main/UI/Edit', action: 'set', text: '012345', caretPosition: 4,
      selectionFrom: 2, selectionTo: 5,
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var edit := get_tree().root.get_node("Main/UI/Edit") as TextEdit',
      'return {"text": edit.text, "caret": edit.get_caret_column(), "selected": edit.has_selection(), "from": edit.get_selection_from_column(), "to": edit.get_selection_to_column()}',
    ].join('\n'))).toMatchObject({ text: '012345', caret: 5, selected: true, from: 2, to: 5 });
    expect((await game.call('game_ui_text', {
      nodePath: '/root/Main/UI/Edit', action: 'set', text: '012345', caretPosition: 4,
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var edit := get_tree().root.get_node("Main/UI/Edit") as TextEdit',
      'return {"caret": edit.get_caret_column(), "selected": edit.has_selection()}',
    ].join('\n'))).toEqual({ caret: 4, selected: false });

    expect((await game.call('game_ui_text', {
      nodePath: '/root/Main/UI/Rich', action: 'set', text: 'prefix ',
    })).isError).toBe(false);
    expect((await game.call('game_ui_text', {
      nodePath: '/root/Main/UI/Rich', action: 'append', text: 'plain',
    })).isError).toBe(false);
    expect((await game.call('game_ui_text', {
      nodePath: '/root/Main/UI/Rich', action: 'bbcode', text: '[b]bold[/b] [color=red]red[/color]',
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var rich := get_tree().root.get_node("Main/UI/Rich") as RichTextLabel',
      'return {"enabled": rich.bbcode_enabled, "parsed": rich.get_parsed_text()}',
    ].join('\n'))).toEqual({ enabled: true, parsed: 'bold red' });

    for (const node of ['Line', 'Edit', 'Rich']) {
      expect((await game.call('game_ui_text', { nodePath: `/root/Main/UI/${node}`, action: 'clear' })).isError).toBe(false);
    }
    expect(await evalResult(game, [
      'var ui := get_tree().root.get_node("Main/UI")',
      'return [(ui.get_node("Line") as LineEdit).text, (ui.get_node("Edit") as TextEdit).text, (ui.get_node("Rich") as RichTextLabel).text]',
    ].join('\n'))).toEqual(['', '', '']);

    const missingText = await game.call('game_ui_text', { nodePath: '/root/Main/UI/Line', action: 'set' });
    expect(missingText.isError).toBe(true);
    expect(missingText.text).toMatch(/text is required/i);
  });

  it('game_ui_item_list covers every action on ItemList and OptionButton with bounds failures', async () => {
    const game = await startedGame();
    await addUiFixtures(game);

    for (const node of ['Items', 'Options']) {
      for (const text of ['alpha', 'beta', 'gamma']) {
        expect((await game.call('game_ui_item_list', {
          nodePath: `/root/Main/UI/${node}`, action: 'add', text,
        })).isError).toBe(false);
      }
      expect((await game.call('game_ui_item_list', {
        nodePath: `/root/Main/UI/${node}`, action: 'select', index: 1,
      })).isError).toBe(false);
      const listed = await game.call('game_ui_item_list', {
        nodePath: `/root/Main/UI/${node}`, action: 'get_items',
      });
      if (node === 'Items') {
        expect(payload(listed.text)).toMatchObject({ items: [{ text: 'alpha' }, { text: 'beta', selected: true }, { text: 'gamma' }] });
      } else {
        expect(payload(listed.text)).toMatchObject({ selected: 1, items: [{ text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }] });
      }
      expect((await game.call('game_ui_item_list', {
        nodePath: `/root/Main/UI/${node}`, action: 'remove', index: 0,
      })).isError).toBe(false);
      expect((await game.call('game_ui_item_list', {
        nodePath: `/root/Main/UI/${node}`, action: 'clear',
      })).isError).toBe(false);
    }
    expect(await evalResult(game, [
      'var ui := get_tree().root.get_node("Main/UI")',
      'return {"items": (ui.get_node("Items") as ItemList).item_count, "options": (ui.get_node("Options") as OptionButton).item_count}',
    ].join('\n'))).toEqual({ items: 0, options: 0 });

    const outOfBounds = await game.call('game_ui_item_list', {
      nodePath: '/root/Main/UI/Items', action: 'select', index: 4,
    });
    expect(outOfBounds.isError).toBe(true);
    expect(outOfBounds.text).toMatch(/out of bounds/i);
  });

  it('game_ui_range covers Range subclasses and ColorPicker set/get state', async () => {
    const game = await startedGame();
    await addUiFixtures(game);

    for (const [node, value] of [['Slider', 4.5], ['Progress', 6.5], ['Spin', 8.5]] as const) {
      expect((await game.call('game_ui_range', {
        nodePath: `/root/Main/UI/${node}`, action: 'set', minValue: 0, maxValue: 10, step: 0.5, value,
      })).isError).toBe(false);
      const state = await game.call('game_ui_range', { nodePath: `/root/Main/UI/${node}`, action: 'get' });
      expect(payload(state.text)).toMatchObject({ value, min: 0, max: 10, step: 0.5 });
    }

    expect((await game.call('game_ui_range', {
      nodePath: '/root/Main/UI/Picker', action: 'set', color: { r: 0.15, g: 0.35, b: 0.55, a: 0.75 },
    })).isError).toBe(false);
    const picked = await game.call('game_ui_range', { nodePath: '/root/Main/UI/Picker', action: 'get' });
    const color = (payload(picked.text) as { color: Record<string, number> }).color;
    expect(color.r).toBeCloseTo(0.15);
    expect(color.g).toBeCloseTo(0.35);
    expect(color.b).toBeCloseTo(0.55);
    expect(color.a).toBeCloseTo(0.75);
    const observed = await evalResult(game, [
      'var picker := get_tree().root.get_node("Main/UI/Picker") as ColorPicker',
      'return {"class": picker.get_class(), "color": picker.color}',
    ].join('\n')) as { class: string; color: Record<string, number> };
    expect(observed.class).toBe('ColorPicker');
    expect(observed.color.r).toBeCloseTo(0.15);
    expect(observed.color.g).toBeCloseTo(0.35);
    expect(observed.color.b).toBeCloseTo(0.55);
    expect(observed.color.a).toBeCloseTo(0.75);

    const emptySet = await game.call('game_ui_range', { nodePath: '/root/Main/UI/Slider', action: 'set' });
    expect(emptySet.isError).toBe(true);
    expect(emptySet.text).toMatch(/set requires/i);
  });

  it('game_ui_popup covers Window and AcceptDialog visibility, sizing, titles, and body text', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var main := get_tree().root.get_node("Main")',
      'var popup := Window.new()',
      'popup.name = "Popup"',
      'main.add_child(popup)',
      'var dialog := AcceptDialog.new()',
      'dialog.name = "Dialog"',
      'main.add_child(dialog)',
      'return [popup.get_class(), dialog.get_class()]',
    ].join('\n'))).toEqual(['Window', 'AcceptDialog']);

    expect((await game.call('game_ui_popup', {
      nodePath: '/root/Main/Popup', action: 'popup_centered', size: { x: 320, y: 180 }, title: 'Inspector',
    })).isError).toBe(false);
    const shown = await game.call('game_ui_popup', { nodePath: '/root/Main/Popup', action: 'get_info' });
    expect(payload(shown.text)).toMatchObject({ visible: true, title: 'Inspector', size: { x: 320, y: 180 } });
    expect(await evalResult(game, [
      'var popup := get_tree().root.get_node("Main/Popup") as Window',
      'return {"visible": popup.visible, "size": popup.size, "title": popup.title}',
    ].join('\n'))).toEqual({ visible: true, size: { x: 320, y: 180 }, title: 'Inspector' });

    expect((await game.call('game_ui_popup', {
      nodePath: '/root/Main/Popup', action: 'hide',
    })).isError).toBe(false);
    expect((await game.call('game_ui_popup', {
      nodePath: '/root/Main/Popup', action: 'popup', title: '',
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var popup := get_tree().root.get_node("Main/Popup") as Window',
      'return {"visible": popup.visible, "title": popup.title}',
    ].join('\n'))).toEqual({ visible: true, title: '' });

    expect((await game.call('game_ui_popup', {
      nodePath: '/root/Main/Dialog', action: 'popup_centered', size: { x: 360, y: 200 },
      title: 'Confirm', text: 'Proceed with operation?',
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var dialog := get_tree().root.get_node("Main/Dialog") as AcceptDialog',
      'return {"visible": dialog.visible, "title": dialog.title, "text": dialog.dialog_text}',
    ].join('\n'))).toEqual({ visible: true, title: 'Confirm', text: 'Proceed with operation?' });
    expect((await game.call('game_ui_popup', {
      nodePath: '/root/Main/Dialog', action: 'hide',
    })).isError).toBe(false);

    const invalidBody = await game.call('game_ui_popup', {
      nodePath: '/root/Main/Popup', action: 'popup', text: 'not supported',
    });
    expect(invalidBody.isError).toBe(true);
    expect(invalidBody.text).toMatch(/AcceptDialog/i);
  });

  it('game_ui_tree covers recursive add/get/select/collapse/expand/remove operations', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var tree := Tree.new()',
      'tree.name = "Tree"',
      'tree.columns = 2',
      'get_tree().root.get_node("Main").add_child(tree)',
      'return tree.columns',
    ].join('\n'))).toBe(2);

    expect((await game.call('game_ui_tree', {
      nodePath: '/root/Main/Tree', action: 'add', text: 'Parent', column: 0,
    })).isError).toBe(false);
    expect((await game.call('game_ui_tree', {
      nodePath: '/root/Main/Tree', action: 'add', itemPath: '0', text: 'Child', column: 0,
    })).isError).toBe(false);
    expect((await game.call('game_ui_tree', {
      nodePath: '/root/Main/Tree', action: 'add', itemPath: '0/0', text: 'Grandchild', column: 1,
    })).isError).toBe(false);

    let listed = await game.call('game_ui_tree', { nodePath: '/root/Main/Tree', action: 'get_items' });
    expect(payload(listed.text)).toMatchObject({
      items: [
        { path: '', depth: 0 },
        { path: '0', text: 'Parent', depth: 1 },
        { path: '0/0', text: 'Child', depth: 2 },
        { path: '0/0/0', depth: 3, columns: ['', 'Grandchild'] },
      ],
    });

    const collapsed = await game.call('game_ui_tree', {
      nodePath: '/root/Main/Tree', action: 'collapse', itemPath: '0',
    });
    expect(collapsed.isError, collapsed.text).toBe(false);
    expect((await game.call('game_ui_tree', {
      nodePath: '/root/Main/Tree', action: 'select', itemPath: '0/0', column: 0,
    })).isError).toBe(false);
    listed = await game.call('game_ui_tree', { nodePath: '/root/Main/Tree', action: 'get_items' });
    expect(payload(listed.text)).toMatchObject({
      items: [
        {},
        { path: '0', collapsed: true },
        { path: '0/0', selected: true },
        { path: '0/0/0', columns: ['', 'Grandchild'] },
      ],
    });
    expect((await game.call('game_ui_tree', {
      nodePath: '/root/Main/Tree', action: 'expand', itemPath: '0',
    })).isError).toBe(false);
    expect((await game.call('game_ui_tree', {
      nodePath: '/root/Main/Tree', action: 'remove', itemPath: '0/0/0',
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var tree := get_tree().root.get_node("Main/Tree") as Tree',
      'var parent := tree.get_root().get_child(0)',
      'return {"collapsed": parent.collapsed, "children": parent.get_child(0).get_child_count()}',
    ].join('\n'))).toEqual({ collapsed: false, children: 0 });

    const missingItem = await game.call('game_ui_tree', {
      nodePath: '/root/Main/Tree', action: 'remove', itemPath: '8/3',
    });
    expect(missingItem.isError).toBe(true);
    expect(missingItem.text).toMatch(/not found/i);
  });

  it('game_ui_tabs covers get/current/title on TabContainer and TabBar', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var main := get_tree().root.get_node("Main")',
      'var container := TabContainer.new()',
      'container.name = "Tabs"',
      'main.add_child(container)',
      'var first := Control.new()',
      'first.name = "First"',
      'container.add_child(first)',
      'var second := Control.new()',
      'second.name = "Second"',
      'container.add_child(second)',
      'var bar := TabBar.new()',
      'bar.name = "TabBar"',
      'bar.add_tab("One")',
      'bar.add_tab("Two")',
      'main.add_child(bar)',
      'return [container.get_tab_count(), bar.tab_count]',
    ].join('\n'))).toEqual([2, 2]);

    for (const node of ['Tabs', 'TabBar']) {
      const initial = await game.call('game_ui_tabs', { nodePath: `/root/Main/${node}`, action: 'get_tabs' });
      expect(payload(initial.text)).toMatchObject({ current: 0, tabs: [{ index: 0 }, { index: 1 }] });
      expect((await game.call('game_ui_tabs', {
        nodePath: `/root/Main/${node}`, action: 'set_title', index: 0, title: `${node} Primary`,
      })).isError).toBe(false);
      expect((await game.call('game_ui_tabs', {
        nodePath: `/root/Main/${node}`, action: 'set_current', index: 1,
      })).isError).toBe(false);
      const updated = await game.call('game_ui_tabs', { nodePath: `/root/Main/${node}`, action: 'get_tabs' });
      expect(payload(updated.text)).toMatchObject({
        current: 1,
        tabs: [{ index: 0, title: `${node} Primary` }, { index: 1 }],
      });
    }
    expect(await evalResult(game, [
      'var container := get_tree().root.get_node("Main/Tabs") as TabContainer',
      'var bar := get_tree().root.get_node("Main/TabBar") as TabBar',
      'return {"container_current": container.current_tab, "container_title": container.get_tab_title(0), "bar_current": bar.current_tab, "bar_title": bar.get_tab_title(0)}',
    ].join('\n'))).toEqual({ container_current: 1, container_title: 'Tabs Primary', bar_current: 1, bar_title: 'TabBar Primary' });

    const badIndex = await game.call('game_ui_tabs', {
      nodePath: '/root/Main/TabBar', action: 'set_current', index: 5,
    });
    expect(badIndex.isError).toBe(true);
    expect(badIndex.text).toMatch(/out of bounds/i);
  });

  it('game_ui_menu covers add/get/check/remove/clear and real Shortcut resources', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var menu := PopupMenu.new()',
      'menu.name = "Menu"',
      'get_tree().root.get_node("Main").add_child(menu)',
      'return menu.get_class()',
    ].join('\n'))).toBe('PopupMenu');

    expect((await game.call('game_ui_menu', {
      nodePath: '/root/Main/Menu', action: 'add', text: 'Inspect', id: 41, shortcutKey: 'K',
    })).isError).toBe(false);
    expect((await game.call('game_ui_menu', {
      nodePath: '/root/Main/Menu', action: 'add', text: 'Delete', id: 42,
    })).isError).toBe(false);
    expect((await game.call('game_ui_menu', {
      nodePath: '/root/Main/Menu', action: 'set_checked', index: 0, checked: true,
    })).isError).toBe(false);
    const listed = await game.call('game_ui_menu', { nodePath: '/root/Main/Menu', action: 'get_items' });
    expect(payload(listed.text)).toMatchObject({
      items: [
        { index: 0, text: 'Inspect', id: 41, checked: true },
        { index: 1, text: 'Delete', id: 42, checked: false, shortcut: '' },
      ],
    });
    expect(await evalResult(game, [
      'var menu := get_tree().root.get_node("Main/Menu") as PopupMenu',
      'var shortcut := menu.get_item_shortcut(0)',
      'var event := shortcut.events[0] as InputEventKey',
      'return {"class": shortcut.get_class(), "key": OS.get_keycode_string(event.keycode), "checked": menu.is_item_checked(0)}',
    ].join('\n'))).toEqual({ class: 'Shortcut', key: 'K', checked: true });

    expect((await game.call('game_ui_menu', {
      nodePath: '/root/Main/Menu', action: 'remove', index: 1,
    })).isError).toBe(false);
    expect((await game.call('game_ui_menu', {
      nodePath: '/root/Main/Menu', action: 'clear',
    })).isError).toBe(false);
    expect(await evalResult(game, 'return (get_tree().root.get_node("Main/Menu") as PopupMenu).item_count')).toBe(0);

    const invalidShortcut = await game.call('game_ui_menu', {
      nodePath: '/root/Main/Menu', action: 'add', text: 'Invalid', shortcutKey: 'not-a-real-key',
    });
    expect(invalidShortcut.isError).toBe(true);
    expect(invalidShortcut.text).toMatch(/Unknown shortcut key/i);
    expect(await evalResult(game, 'return (get_tree().root.get_node("Main/Menu") as PopupMenu).item_count')).toBe(0);
  });
});
