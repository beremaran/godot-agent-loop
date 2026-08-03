#!/usr/bin/env -S godot --headless --script
extends SceneTree
## Compiles one project GDScript after project autoloads are registered.
##
## Godot's `--check-only --script <target>` path compiles the target before
## Main registers every project autoload singleton, which can report valid
## singleton references as unknown identifiers. SceneTree `_initialize()` runs
## after autoload bootstrap. CACHE_MODE_IGNORE still forces a fresh parse,
## analysis, and compile instead of accepting a resource cached by bootstrap.


func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_args()
	var script_index: int = args.find("--script")
	var target_index: int = script_index + 2

	if script_index == -1 or args.size() <= target_index:
		printerr("SCRIPT ERROR: usage: godot --headless --path <project> --script validate_script.gd <res://path/to/script.gd>")
		quit(1)
		return

	var target: String = args[target_index]
	var _loaded_script: Resource = ResourceLoader.load(
		target,
		"GDScript",
		ResourceLoader.CACHE_MODE_IGNORE,
	)
	quit()
