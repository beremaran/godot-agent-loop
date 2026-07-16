import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_EVENT = 'Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":68,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)';

function projectSettings(name, extra = '') {
  return `; Cold-model evaluation fixture.\nconfig_version=5\n\n[application]\nconfig/name="${name}"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n\n[display]\nwindow/size/viewport_width=640\nwindow/size/viewport_height=360\nwindow/size/window_width_override=640\nwindow/size/window_height_override=360\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n\n[input]\nmove_right={"deadzone": 0.5, "events": [${INPUT_EVENT}]}\n${extra}`;
}

function scene(status = 'READY', playerX = 20) {
  return `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1_script"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_script")\n\n[node name="Background" type="ColorRect" parent="."]\noffset_right = 640.0\noffset_bottom = 360.0\ncolor = Color(0.08, 0.1, 0.16, 1)\nmouse_filter = 2\n\n[node name="Player" type="ColorRect" parent="."]\noffset_left = ${playerX}.0\noffset_top = 180.0\noffset_right = ${playerX + 30}.0\noffset_bottom = 210.0\ncolor = Color(0.2, 0.7, 1, 1)\n\n[node name="Status" type="Label" parent="."]\noffset_left = 20.0\noffset_top = 20.0\noffset_right = 360.0\noffset_bottom = 60.0\ntext = "${status}"\n`;
}

function movementScript({ regression = false, status = 'READY', warning = false } = {}) {
  const duration = regression ? '0.05' : '0.50';
  return `extends Node2D\n\n@onready var player: ColorRect = $Player\n@onready var status_label: Label = $Status\nvar movement_budget := ${duration}\nvar elapsed_held := 0.0\n\nfunc _ready() -> void:\n\tstatus_label.text = "${status}"\n${warning ? '\tpush_warning("Canvas compatibility fallback is active; this warning is unrelated to input timing.")\n' : ''}\nfunc _physics_process(delta: float) -> void:\n\tif Input.is_action_pressed("move_right") and elapsed_held < movement_budget:\n\t\tplayer.position.x += 120.0 * delta\n\t\telapsed_held += delta\n\tif player.position.x >= 70.0:\n\t\tstatus_label.text = "COMPLETE"\n`;
}

function writeFiles(projectPath, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = join(projectPath, relativePath);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, content, 'utf8');
  }
}

function linuxX8664ExitTemplate() {
  const code = Buffer.from([0xb8, 0x3c, 0x00, 0x00, 0x00, 0x31, 0xff, 0x0f, 0x05]);
  const codeOffset = 0x78;
  const size = codeOffset + code.length;
  const elf = Buffer.alloc(size);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]).copy(elf, 0);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(62, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(BigInt(0x400000 + codeOffset), 24);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt16LE(64, 58);
  elf.writeUInt32LE(1, 64);
  elf.writeUInt32LE(5, 68);
  elf.writeBigUInt64LE(0n, 72);
  elf.writeBigUInt64LE(0x400000n, 80);
  elf.writeBigUInt64LE(0x400000n, 88);
  elf.writeBigUInt64LE(BigInt(size), 96);
  elf.writeBigUInt64LE(BigInt(size), 104);
  elf.writeBigUInt64LE(0x1000n, 112);
  code.copy(elf, codeOffset);
  return elf;
}

function seedMovement(projectPath, options = {}) {
  writeFiles(projectPath, {
    'project.godot': projectSettings(options.name ?? 'Cold Model Movement', options.projectExtra ?? ''),
    'main.tscn': scene(options.status ?? 'READY', options.playerX ?? 20),
    'main.gd': movementScript(options),
    'EVALUATION_CONTEXT.md': options.context ?? '# Fixture context\n\nHold `move_right` until the visible status changes.\n',
  });
}

function seedVerify(projectPath, { failedOnly = false } = {}) {
  const context = failedOnly
    ? '# Supplied change contract\n\nThe Status label must read `VERIFIED`. Verify this exact objective and do not repair it.\n'
    : '# Supplied change contract\n\n- Objective: the saved Status label must read `READY`.\n- Adjacent regression: Player must still start at x = 20.\n- Subjective review: decide whether the palette feels welcoming; this requires human judgment.\n';
  writeFiles(projectPath, {
    'project.godot': projectSettings(failedOnly ? 'Failed Verify Fixture' : 'Objective Verify Fixture'),
    'main.tscn': scene(failedOnly ? 'BROKEN' : 'READY', failedOnly ? 20 : 80),
    'main.gd': movementScript({ status: failedOnly ? 'BROKEN' : 'READY' }),
    'CHANGE_REQUEST.md': context,
  });
}

function seedShip(projectPath, { edge = false } = {}) {
  writeFiles(projectPath, {
    'project.godot': projectSettings(edge ? 'Ship Readiness Blocker' : 'Ship Matrix Fixture'),
    'main.tscn': scene('RELEASE READY', 20),
    'main.gd': `extends Node2D\n\nfunc _ready() -> void:\n\tprint("COLD_MODEL_RELEASE_SMOKE_OK")\n`,
    'RELEASE_MATRIX.md': edge
      ? '# Release request\n\nInspection only. A stale import and unavailable export template are expected blockers. No repair, reimport, preset edit, or export is authorized.\n'
      : '# Release matrix\n\n- `Local Eval`: authorized Linux x86_64 artifact, release mode, expected at `build/local-eval.x86_64`. Packaging is locally testable; runtime smoke is supported only on an x86_64 Linux host and must be classified unsupported elsewhere.\n- `Signed macOS`: unavailable because the evaluation machine has no signing identity; do not export this target.\n- Preserve produced release artifacts.\n',
  });
  if (edge) {
    writeFiles(projectPath, {
      'assets/stale.svg.import': `[remap]\nimporter="svg"\ntype="CompressedTexture2D"\npath="res://.godot/imported/stale.svg-deadbeef.ctex"\n\n[deps]\nsource_file="res://assets/stale.svg"\ndest_files=["res://.godot/imported/stale.svg-deadbeef.ctex"]\n`,
      'export_presets.cfg': `[preset.0]\n\nname="Linux Missing"\nplatform="Linux"\nrunnable=true\nadvanced_options=false\ndedicated_server=false\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path="build/missing.x86_64"\nscript_export_mode=2\n\n[preset.0.options]\ncustom_template/debug=""\ncustom_template/release=""\n`,
    });
    return;
  }
  const templatePath = join(projectPath, 'fixtures', 'local-template.x86_64');
  writeFiles(projectPath, {
    'export_presets.cfg': `[preset.0]\n\nname="Local Eval"\nplatform="Linux"\nrunnable=true\nadvanced_options=false\ndedicated_server=false\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path="build/local-eval.x86_64"\nscript_export_mode=2\n\n[preset.0.options]\ncustom_template/debug="${templatePath}"\ncustom_template/release="${templatePath}"\nbinary_format/embed_pck=false\n\n[preset.1]\n\nname="Signed macOS"\nplatform="macOS"\nrunnable=false\nadvanced_options=false\ndedicated_server=false\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path="build/SignedEval.app"\nscript_export_mode=2\n\n[preset.1.options]\ncodesign/enable=true\ncodesign/identity="MISSING_EVAL_IDENTITY"\ncustom_template/debug=""\ncustom_template/release=""\n`,
  });
  mkdirSync(join(projectPath, 'fixtures'), { recursive: true });
  writeFileSync(templatePath, linuxX8664ExitTemplate());
  chmodSync(templatePath, 0o755);
}

export const profiles = {
  'compact-no-skill-discovery': {
    fixture: projectPath => seedMovement(projectPath, { name: 'No Skill Discovery', status: 'WAITING' }),
    skill: null,
    catalogTargets: [],
    relevantTools: ['run_project', 'game_key_hold', 'game_wait_until', 'game_get_ui', 'game_get_scene_tree', 'game_key_release', 'read_scene', 'stop_project', 'godot_catalog', 'godot_call'],
  },
  'build-watched-minimal-game': {
    fixture: () => undefined,
    skill: 'build-godot-game',
    catalogTargets: ['list_project_files', 'analyze_project_integrity'],
    relevantTools: ['editor_session', 'create_project', 'create_scene', 'add_node', 'create_script', 'attach_script', 'manage_input_map', 'set_main_scene', 'validate_scripts', 'read_scene', 'run_project', 'game_key_hold', 'game_key_release', 'game_get_ui', 'game_get_scene_tree', 'game_wait_until', 'game_scenario', 'verify_project', 'get_debug_output', 'game_get_errors', 'stop_project', 'godot_catalog', 'godot_call'],
  },
  'build-watched-editor-unavailable': {
    fixture: () => undefined,
    skill: 'build-godot-game',
    unavailableEditor: true,
    catalogTargets: [],
    relevantTools: ['editor_session', 'launch_editor'],
  },
  'debug-seeded-input-regression': {
    fixture: projectPath => seedMovement(projectPath, { name: 'Seeded Input Regression', regression: true, warning: true, context: '# Reproduction\n\nHolding `move_right` for half a second should move Player past x = 70 and change Status to `COMPLETE`; it currently stops early.\n' }),
    skill: 'debug-godot-game',
    catalogTargets: [],
    relevantTools: ['read_file', 'read_scene', 'run_project', 'game_key_hold', 'game_wait_until', 'game_get_ui', 'game_get_node_info', 'game_get_errors', 'get_debug_output', 'game_key_release', 'stop_project', 'write_file', 'validate_scripts', 'verify_project'],
  },
  'debug-paused-before-repair': {
    fixture: projectPath => {
      seedMovement(projectPath, { name: 'Paused Debug Repair', regression: true, warning: true, projectExtra: '\n[editor_plugins]\nenabled=PackedStringArray("res://addons/godot_agent_loop/plugin.cfg")\n' });
    },
    skill: 'debug-godot-game',
    startPausedEditor: true,
    catalogTargets: [],
    relevantTools: ['editor_session', 'read_file', 'read_scene', 'run_project', 'game_key_hold', 'game_wait_until', 'game_get_ui', 'game_get_errors', 'game_key_release', 'stop_project', 'write_file', 'editor_transaction'],
  },
  'verify-objective-regression-subjective': {
    fixture: projectPath => seedVerify(projectPath),
    skill: 'verify-godot-change',
    catalogTargets: ['analyze_project_integrity'],
    relevantTools: ['validate_scripts', 'read_scene', 'read_file', 'read_project_settings', 'verify_project', 'run_project', 'game_get_ui', 'game_get_errors', 'get_debug_output', 'stop_project', 'godot_catalog', 'godot_call'],
  },
  'verify-failed-criterion-no-fix': {
    fixture: projectPath => seedVerify(projectPath, { failedOnly: true }),
    skill: 'verify-godot-change',
    catalogTargets: [],
    relevantTools: ['validate_scripts', 'read_scene', 'read_file', 'read_project_settings', 'verify_project', 'run_project', 'game_get_ui', 'game_get_errors', 'get_debug_output', 'stop_project'],
  },
  'ship-available-and-blocked-targets': {
    fixture: projectPath => seedShip(projectPath),
    skill: 'ship-godot-game',
    catalogTargets: ['list_project_files', 'analyze_project_integrity', 'verify_export_readiness', 'export_project'],
    relevantTools: ['read_project_settings', 'read_scene', 'validate_scripts', 'run_project_tests', 'verify_project', 'game_get_errors', 'get_debug_output', 'stop_project', 'godot_catalog', 'godot_call'],
  },
  'ship-repair-not-authorized': {
    fixture: projectPath => seedShip(projectPath, { edge: true }),
    skill: 'ship-godot-game',
    catalogTargets: ['list_project_files', 'analyze_project_integrity', 'manage_import_pipeline', 'verify_export_readiness'],
    relevantTools: ['read_project_settings', 'read_scene', 'validate_scripts', 'run_project_tests', 'godot_catalog', 'godot_call'],
  },
};

export function installPersistentAddon(repoRoot, projectPath) {
  cpSync(join(repoRoot, 'addons', 'godot_agent_loop'), join(projectPath, 'addons', 'godot_agent_loop'), { recursive: true });
}
