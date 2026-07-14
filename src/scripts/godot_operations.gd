#!/usr/bin/env -S godot --headless --script
extends SceneTree

# The outcome of one operation. Operations never report errors and never quit:
# they return this to the entry point, which is the only place that logs
# failures and chooses the exit code.
class OperationResult extends RefCounted:
    var ok: bool
    var errors: PackedStringArray

    func _init(p_ok: bool, p_errors: PackedStringArray) -> void:
        ok = p_ok
        errors = p_errors

# A parsed command line: the operation to run and its JSON object parameters,
# or the reasons the command line could not be used.
class CliInvocation extends RefCounted:
    var operation: String
    var params: Dictionary
    var errors: PackedStringArray

    func _init(p_operation: String, p_params: Dictionary, p_errors: PackedStringArray) -> void:
        operation = p_operation
        params = p_params
        errors = p_errors

    func is_valid() -> bool:
        return errors.is_empty()

# Opt-in debug diagnostics. This is constructed only under --debug-godot, so a
# normal operation never logs diagnostics and never writes a probe file into the
# user's project. Values that can carry file paths, tokens, or script source are
# summarized by type and size rather than printed.
class DebugDiagnostics extends RefCounted:
    const PROBE_PREFIX := "godot_mcp_write_probe_"

    func log_message(message: String) -> void:
        print("[DEBUG] " + message)

    # Describe a JSON value without disclosing its contents. JSON values arrive
    # as Variant, so each branch narrows after its own type check.
    func redact(value: Variant) -> String:
        if value is String:
            var text: String = value
            return "<string, " + str(text.length()) + " chars>"
        if value is Dictionary:
            var object: Dictionary = value
            return "<object, " + str(object.size()) + " keys>"
        if value is Array:
            var items: Array = value
            return "<array, " + str(items.size()) + " items>"
        if value == null:
            return "null"
        if value is bool or value is int or value is float:
            return str(value)
        return "<" + type_string(typeof(value)) + ">"

    func redact_params(params: Dictionary) -> String:
        var parts := PackedStringArray()
        var keys := PackedStringArray(params.keys())
        keys.sort()
        for key in keys:
            @warning_ignore("return_value_discarded")
            parts.append(key + ": " + redact(params[key]))
        return "{" + ", ".join(parts) + "}"

    func log_project_environment() -> void:
        log_message("Globalized res:// path: " + ProjectSettings.globalize_path("res://"))
        log_message("Globalized user:// path: " + ProjectSettings.globalize_path("user://"))

        # Only report which variables are set; their values are paths and may
        # carry credentials.
        var set_vars := PackedStringArray()
        for env_var: String in ["PATH", "HOME", "USER", "TEMP", "GODOT_PATH"]:
            if OS.has_environment(env_var):
                @warning_ignore("return_value_discarded")
                set_vars.append(env_var)
        log_message("Environment variables set: " + ", ".join(set_vars))

    # Check that a directory is writable by creating and deleting one probe file.
    # The probe name is unique per call and the file is removed on every branch,
    # so the directory is left exactly as it was found.
    func probe_write_access(res_dir: String) -> void:
        var probe_path: String = res_dir.path_join(PROBE_PREFIX + str(Time.get_ticks_usec()) + ".tmp")
        if FileAccess.file_exists(probe_path):
            log_message("Skipping write probe, path is already taken: " + probe_path)
            return

        var probe := FileAccess.open(probe_path, FileAccess.WRITE)
        if probe == null:
            log_message("Write probe failed for " + res_dir + " (open error " + str(FileAccess.get_open_error()) + "); this indicates a permission or path issue")
            return

        @warning_ignore("return_value_discarded")
        probe.store_string("write probe")
        probe.close()
        log_message("Write probe succeeded for: " + res_dir)
        _remove_probe(probe_path)

    func _remove_probe(probe_path: String) -> void:
        if not FileAccess.file_exists(probe_path):
            return
        var remove_error: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(probe_path))
        if remove_error != OK:
            log_message("Failed to remove write probe " + probe_path + " (error " + str(remove_error) + ")")

# Debug mode flag
var debug_mode: bool = false

# The diagnostics service, or null when diagnostics are off. Nothing outside
# log_debug() and the branches guarded by debug_mode may use it.
var _diagnostics: DebugDiagnostics = null

# Operation name -> handler. The single source of truth for which operations
# exist; the CLI rejects any name that is not registered here.
var _operations: Dictionary[String, Callable] = {}
const SERVE_ARGUMENT: String = "--serve-authoring"

func _init() -> void:
    _register_operations()

    var args: PackedStringArray = OS.get_cmdline_args()
    debug_mode = "--debug-godot" in args
    if debug_mode:
        _diagnostics = DebugDiagnostics.new()

    if SERVE_ARGUMENT in args:
        # Autoloads enter the tree after the script main loop is constructed.
        # Keep the deferred startup and its exit decision lexically inside this
        # CLI entry point; helpers report failures but never terminate Godot.
        var start_authoring_session: Callable = func() -> void:
            var startup_errors: PackedStringArray = _start_authoring_session()
            if not startup_errors.is_empty():
                _report_errors(startup_errors)
                quit(1)
        start_authoring_session.call_deferred()
        return

    var invocation := _parse_cli(args)
    if not invocation.is_valid():
        _report_errors(invocation.errors)
        quit(1)
        return

    log_info("Executing operation: " + invocation.operation)

    var handler: Callable = _operations[invocation.operation]
    var result: OperationResult = handler.call(invocation.params)
    if not result.ok:
        _report_errors(result.errors)
        quit(1)
        return

    quit(0)

func _start_authoring_session() -> PackedStringArray:
    var server: Node = get_root().get_node_or_null("McpInteractionServer")
    if server == null:
        return PackedStringArray([
            "Authoring session requires the McpInteractionServer autoload.",
        ])
    if not server.has_method("register_authoring_dispatcher"):
        return PackedStringArray([
            "McpInteractionServer does not support authoring commands.",
        ])
    server.call("register_authoring_dispatcher", execute_operation)
    log_info("Authoring session ready")
    return PackedStringArray()

func execute_operation(operation: String, params: Dictionary) -> Dictionary:
    if not _operations.has(operation):
        return {
            "error": "Unknown authoring operation: " + operation,
            "error_data": {
                "reason": "unknown_authoring_operation",
                "operation": operation,
            },
        }
    log_info("Executing operation: " + operation)
    var handler: Callable = _operations[operation]
    var result: OperationResult = handler.call(params)
    if not result.ok:
        return {
            "error": "\n".join(result.errors),
            "error_data": {
                "reason": "authoring_operation_failed",
                "operation": operation,
                "errors": Array(result.errors),
            },
        }
    return {"success": true, "operation": operation}

func _register_operations() -> void:
    _operations = {
        "create_scene": create_scene,
        "add_node": add_node,
        "load_sprite": load_sprite,
        "export_mesh_library": export_mesh_library,
        "save_scene": save_scene,
        "get_uid": get_uid,
        "resave_resources": resave_resources,
        "read_scene": read_scene,
        "modify_node": modify_node,
        "remove_node": remove_node,
        "attach_script": attach_script,
        "create_resource": create_resource,
        "manage_resource": manage_resource,
        "manage_scene_signals": manage_scene_signals,
        "manage_theme_resource": manage_theme_resource,
        "manage_scene_structure": manage_scene_structure,
    }

# Parse the Godot command line into an operation and its parameters. The
# operation name and the JSON object are both validated before any dispatch.
func _parse_cli(args: PackedStringArray) -> CliInvocation:
    var script_index: int = args.find("--script")
    if script_index == -1:
        return _invalid_cli("Could not find --script argument")

    # The operation follows the script path, and the params follow the operation.
    var operation_index: int = script_index + 2
    var params_index: int = script_index + 3

    if args.size() <= params_index:
        return _invalid_cli(
            "Usage: godot --headless --script godot_operations.gd <operation> <json_params>",
            PackedStringArray(["Not enough command-line arguments provided."])
        )

    # The arguments carry the params JSON, which can hold paths or script
    # source, so only their positions are logged.
    log_debug("Argument count: " + str(args.size()))
    log_debug("Script index: " + str(script_index))
    log_debug("Operation index: " + str(operation_index))
    log_debug("Params index: " + str(params_index))

    var operation: String = args[operation_index]
    var params_json: String = args[params_index]

    log_info("Operation: " + operation)
    log_debug("Params JSON: " + str(params_json.length()) + " chars")

    if not _operations.has(operation):
        return _invalid_cli(
            "Unknown operation: " + operation,
            PackedStringArray(["Known operations: " + ", ".join(_operation_names())])
        )

    var json := JSON.new()
    var parse_error: Error = json.parse(params_json)
    if parse_error != OK:
        return _invalid_cli(
            "Failed to parse JSON parameters: " + params_json,
            PackedStringArray(["JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line())])
        )

    var data: Variant = json.get_data()
    if not (data is Dictionary):
        return _invalid_cli("Parameters must be a JSON object: " + params_json)

    var operation_params: Dictionary = data
    log_debug("Params: " + _redact_params(operation_params))
    return CliInvocation.new(operation, operation_params, PackedStringArray())

func _operation_names() -> PackedStringArray:
    var names := PackedStringArray(_operations.keys())
    names.sort()
    return names

func _invalid_cli(message: String, details: PackedStringArray = PackedStringArray()) -> CliInvocation:
    return CliInvocation.new("", {}, _error_lines(message, details))

# Result constructors used by every operation instead of printerr()/quit(1).
func _ok() -> OperationResult:
    return OperationResult.new(true, PackedStringArray())

func _fail(message: String, details: PackedStringArray = PackedStringArray()) -> OperationResult:
    return OperationResult.new(false, _error_lines(message, details))

func _failed(errors: PackedStringArray) -> OperationResult:
    return OperationResult.new(false, errors)

func _error_lines(message: String, details: PackedStringArray) -> PackedStringArray:
    var lines := PackedStringArray([message])
    lines.append_array(details)
    return lines

func _report_errors(errors: PackedStringArray) -> void:
    for line in errors:
        log_error(line)

# Logging functions
func log_debug(message: String) -> void:
    if _diagnostics != null:
        _diagnostics.log_message(message)

# Summaries used when a debug line would otherwise print a value that can carry
# a file path, a token, or script source.
func _redact(value: Variant) -> String:
    if _diagnostics == null:
        return ""
    return _diagnostics.redact(value)

func _redact_params(params: Dictionary) -> String:
    if _diagnostics == null:
        return ""
    return _diagnostics.redact_params(params)

func log_info(message: String) -> void:
    print("[INFO] " + message)

func log_error(message: String) -> void:
    printerr("[ERROR] " + message)

# Parameter readers: JSON values arrive as Variant, so every read narrows to the
# type the operation works with instead of relying on dynamic access.
func _param_string(params: Dictionary, key: String, default_value: String = "") -> String:
    if not params.has(key):
        return default_value
    var value: Variant = params[key]
    if value is String:
        return value
    return str(value)

func _param_dictionary(params: Dictionary, key: String) -> Dictionary:
    var value: Variant = params.get(key, {})
    if value is Dictionary:
        return value
    return {}

func _param_array(params: Dictionary, key: String) -> Array:
    var value: Variant = params.get(key, [])
    if value is Array:
        return value
    return []

# --- Project paths ---------------------------------------------------------
#
# Tool callers may pass either a project-relative path or a full res:// path,
# so every operation normalizes through _res_path() instead of open-coding the
# prefix check.

const RES_PREFIX: String = "res://"

func _res_path(path: String) -> String:
    if path.begins_with(RES_PREFIX):
        return path
    return RES_PREFIX + path

# The path relative to the project root, which is what DirAccess calls rooted
# at res:// expect.
func _res_relative(res_path: String) -> String:
    return res_path.substr(RES_PREFIX.length())

# --- Directories -----------------------------------------------------------

# Create a res:// directory and its parents if they are missing.
func _ensure_directory(res_dir: String) -> OperationResult:
    var relative: String = _res_relative(res_dir)
    if relative.is_empty():
        return _ok()

    var absolute: String = ProjectSettings.globalize_path(res_dir)
    if DirAccess.dir_exists_absolute(absolute):
        log_debug("Directory already exists: " + res_dir)
        return _ok()

    var dir := DirAccess.open(RES_PREFIX)
    if dir == null:
        # res:// itself could not be opened, so fall back to the absolute path.
        var open_error: Error = DirAccess.get_open_error()
        log_debug("Failed to open res:// (error " + str(open_error) + "), creating by absolute path")
        var absolute_error: Error = DirAccess.make_dir_recursive_absolute(absolute)
        if absolute_error != OK:
            return _fail("Failed to create directory: " + res_dir, PackedStringArray([
                "DirAccess error: " + str(open_error),
                "Error code: " + str(absolute_error),
            ]))
    else:
        var make_error: Error = dir.make_dir_recursive(relative)
        if make_error != OK:
            return _fail("Failed to create directory: " + res_dir, PackedStringArray([
                "Error code: " + str(make_error),
            ]))

    if not DirAccess.dir_exists_absolute(absolute):
        return _fail("Directory reported as created but does not exist: " + absolute, PackedStringArray([
            "This may indicate a problem with path resolution or permissions",
        ]))

    log_debug("Created directory: " + res_dir)
    return _ok()

# --- Scene loading, packing and saving -------------------------------------

# A scene file opened for editing: its instantiated root, or the reasons it
# could not be opened. The instantiated tree is never added to the running
# SceneTree and queue_free() would never be processed before quit(), so the
# guard frees the root when the OpenScene itself is released; without it every
# early return leaks the whole tree as ObjectDB instances at exit.
class OpenScene extends RefCounted:
    var root: Node
    var errors: PackedStringArray

    func _init(p_root: Node, p_errors: PackedStringArray) -> void:
        root = p_root
        errors = p_errors

    func is_valid() -> bool:
        return errors.is_empty()

    func _notification(what: int) -> void:
        if what == NOTIFICATION_PREDELETE and root != null and is_instance_valid(root):
            root.free()

# Load a scene file and instantiate it so an operation can edit the tree.
func _open_scene(res_scene_path: String) -> OpenScene:
    if not FileAccess.file_exists(res_scene_path):
        return _scene_not_opened("Scene file does not exist at: " + res_scene_path, PackedStringArray([
            "Absolute file path that doesn't exist: " + ProjectSettings.globalize_path(res_scene_path),
        ]))

    var scene := load(res_scene_path) as PackedScene
    if scene == null:
        return _scene_not_opened("Failed to load scene: " + res_scene_path)

    var scene_root := scene.instantiate()
    if scene_root == null:
        return _scene_not_opened("Failed to instantiate scene: " + res_scene_path)

    log_debug("Scene instantiated: " + res_scene_path)
    return OpenScene.new(scene_root, PackedStringArray())

func _scene_not_opened(message: String, details: PackedStringArray = PackedStringArray()) -> OpenScene:
    return OpenScene.new(null, _error_lines(message, details))

# Resolve a tool-supplied node path against a scene root. Callers address the
# root as "", "root" or ".", and its descendants with or without a "root/"
# prefix.
func _resolve_scene_node(scene_root: Node, tool_path: String) -> Node:
    if tool_path == "" or tool_path == "root" or tool_path == ".":
        return scene_root
    var p: String = tool_path
    if p.begins_with("root/"):
        p = p.substr(5)
    return scene_root.get_node_or_null(p)

# Pack an edited scene root and write it back to a res:// path.
func _save_scene_root(scene_root: Node, res_scene_path: String) -> OperationResult:
    var packed := PackedScene.new()
    var pack_error: Error = packed.pack(scene_root)
    if pack_error != OK:
        return _fail("Failed to pack scene: " + res_scene_path, PackedStringArray([
            "Error code: " + str(pack_error),
        ]))

    return _save_resource(packed, res_scene_path, "scene")

# Save a resource to a res:// path, creating its directory first and verifying
# the file exists afterwards.
func _save_resource(resource: Resource, res_path: String, what: String) -> OperationResult:
    var dir_result := _ensure_directory(res_path.get_base_dir())
    if not dir_result.ok:
        return dir_result

    var save_error: Error = ResourceSaver.save(resource, res_path)
    if save_error != OK:
        return _fail("Failed to save " + what + ": " + str(save_error), PackedStringArray([
            "Path: " + res_path + _save_error_hint(save_error),
        ]))

    if not FileAccess.file_exists(res_path):
        return _fail("File reported as saved but does not exist at: " + res_path)

    log_debug("Saved " + what + " to: " + res_path)
    return _ok()

func _save_error_hint(save_error: Error) -> String:
    match save_error:
        ERR_CANT_CREATE:
            return " (ERR_CANT_CREATE - Cannot create the file)"
        ERR_CANT_OPEN:
            return " (ERR_CANT_OPEN - Cannot open the file for writing)"
        ERR_FILE_CANT_WRITE:
            return " (ERR_FILE_CANT_WRITE - Cannot write to the file)"
        ERR_FILE_NO_PERMISSION:
            return " (ERR_FILE_NO_PERMISSION - No permission to write the file)"
    return ""

# --- Resource loading ------------------------------------------------------

# An existing resource opened for reading or modification.
class OpenResource extends RefCounted:
    var resource: Resource
    var errors: PackedStringArray

    func _init(p_resource: Resource, p_errors: PackedStringArray) -> void:
        resource = p_resource
        errors = p_errors

    func is_valid() -> bool:
        return errors.is_empty()

# `what` names the resource in failures ("Resource", "Theme"), so callers keep
# their domain wording without repeating the exists/load dance.
func _open_resource(res_path: String, what: String) -> OpenResource:
    if not ResourceLoader.exists(res_path):
        return OpenResource.new(null, PackedStringArray([what + " not found: " + res_path]))

    var resource := ResourceLoader.load(res_path)
    if resource == null:
        return OpenResource.new(null, PackedStringArray(["Failed to load " + what.to_lower() + ": " + res_path]))

    return OpenResource.new(resource, PackedStringArray())

# Apply JSON properties to a node or resource, converting each value to the
# type the target property declares.
func _apply_properties(target: Object, properties: Dictionary) -> void:
    for prop_name: String in properties:
        var raw_value: Variant = properties[prop_name]
        var converted_value: Variant = _convert_property_value(target, prop_name, raw_value)
        log_debug("Setting " + prop_name + " = " + _redact(converted_value) + " (from " + _redact(raw_value) + ")")
        target.set(prop_name, converted_value)

# --- Class and script resolution -------------------------------------------

# Get a script by name or path
func get_script_by_name(name_of_class: String) -> Script:
    log_debug("Attempting to get script for class: " + name_of_class)

    # Try to load it directly if it's a resource path
    if ResourceLoader.exists(name_of_class, "Script"):
        log_debug("Resource exists, loading directly: " + name_of_class)
        var script := load(name_of_class) as Script
        if script:
            log_debug("Successfully loaded script from path")
            return script
        else:
            printerr("Failed to load script from path: " + name_of_class)
    else:
        log_debug("Resource not found, checking global class registry")

    # Search for it in the global class registry if it's a class name
    var global_classes: Array[Dictionary] = ProjectSettings.get_global_class_list()
    log_debug("Searching through " + str(global_classes.size()) + " global classes")

    for global_class in global_classes:
        var found_name_of_class: String = global_class["class"]
        var found_path: String = global_class["path"]

        if found_name_of_class == name_of_class:
            log_debug("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
            var script := load(found_path) as Script
            if script:
                log_debug("Successfully loaded script from registry")
                return script
            else:
                printerr("Failed to load script from registry path: " + found_path)
                break

    printerr("Could not find script for class: " + name_of_class)
    return null

# Instantiate a class by name
func instantiate_class(name_of_class: String) -> Object:
    if name_of_class.is_empty():
        printerr("Cannot instantiate class: name is empty")
        return null

    var result: Object = null
    log_debug("Attempting to instantiate class: " + name_of_class)

    # Check if it's a built-in class
    if ClassDB.class_exists(name_of_class):
        log_debug("Class exists in ClassDB, using ClassDB.instantiate()")
        if ClassDB.can_instantiate(name_of_class):
            result = ClassDB.instantiate(name_of_class)
            if result == null:
                printerr("ClassDB.instantiate() returned null for class: " + name_of_class)
        else:
            printerr("Class exists but cannot be instantiated: " + name_of_class)
            printerr("This may be an abstract class or interface that cannot be directly instantiated")
    else:
        # Try to get the script
        log_debug("Class not found in ClassDB, trying to get script")
        var script := get_script_by_name(name_of_class)
        if script is GDScript:
            log_debug("Found GDScript, creating instance")
            result = (script as GDScript).new()
        else:
            printerr("Failed to get script for class: " + name_of_class)
            return null

    if result == null:
        printerr("Failed to instantiate class: " + name_of_class)
    else:
        log_debug("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())

    return result

# Instantiate a class that must be a Node (scene operations)
func instantiate_node(name_of_class: String) -> Node:
    return instantiate_class(name_of_class) as Node

# Create a new scene with a specified root node type
func create_scene(params: Dictionary) -> OperationResult:
    var scene_path: String = _param_string(params, "scene_path")
    print("Creating scene: " + scene_path)

    if _diagnostics != null:
        _diagnostics.log_project_environment()
        _diagnostics.probe_write_access(RES_PREFIX)

    var full_scene_path: String = _res_path(scene_path)
    var root_node_type: String = _param_string(params, "root_node_type", "Node2D")
    log_debug("Scene path: " + full_scene_path + ", root node type: " + root_node_type)

    var scene_root := instantiate_node(root_node_type)
    if scene_root == null:
        return _fail("Failed to instantiate node of type: " + root_node_type, PackedStringArray([
            "Make sure the class exists and can be instantiated",
            "Check if the class is registered in ClassDB or available as a script",
        ]))

    # PackedScene.pack() stores the root plus the nodes it owns. The root itself
    # needs no owner: Node.set_owner() rejects a node owning itself, so assigning
    # one only printed an engine error.
    scene_root.name = "root"

    var save_result := _save_scene_root(scene_root, full_scene_path)
    # The root never joins the SceneTree, so it must be freed explicitly or it
    # leaks an ObjectDB instance at exit.
    scene_root.free()
    if not save_result.ok:
        if _diagnostics != null:
            _diagnostics.probe_write_access(full_scene_path.get_base_dir())
        return save_result

    print("Scene created successfully at: " + scene_path)
    return _ok()

# Add a node to an existing scene
func add_node(params: Dictionary) -> OperationResult:
    var full_scene_path: String = _res_path(_param_string(params, "scene_path"))
    print("Adding node to scene: " + full_scene_path)

    var opened := _open_scene(full_scene_path)
    if not opened.is_valid():
        return _failed(opened.errors)
    var scene_root: Node = opened.root

    var parent_path: String = _param_string(params, "parent_node_path", "root")
    var parent := _resolve_scene_node(scene_root, parent_path)
    if parent == null:
        return _fail("Parent node not found: " + parent_path)

    var node_type: String = _param_string(params, "node_type")
    var new_node := instantiate_node(node_type)
    if new_node == null:
        return _fail("Failed to instantiate node of type: " + node_type, PackedStringArray([
            "Make sure the class exists and can be instantiated",
            "Check if the class is registered in ClassDB or available as a script",
        ]))

    var node_name: String = _param_string(params, "node_name")
    new_node.name = node_name
    _apply_properties(new_node, _param_dictionary(params, "properties"))

    # force_readable_name matches editor semantics: a duplicate name becomes
    # Twin2 rather than the transient @Twin@N, which PackedScene will not
    # persist — without this the second node silently vanished from the file.
    parent.add_child(new_node, true)
    new_node.owner = scene_root

    var save_result := _save_scene_root(scene_root, full_scene_path)
    if not save_result.ok:
        return save_result

    print("Node '" + node_name + "' of type '" + node_type + "' added successfully")
    return _ok()

# Load a sprite into a Sprite2D node
func load_sprite(params: Dictionary) -> OperationResult:
    var full_scene_path: String = _res_path(_param_string(params, "scene_path"))
    var full_texture_path: String = _res_path(_param_string(params, "texture_path"))
    print("Loading sprite into scene: " + full_scene_path)

    var opened := _open_scene(full_scene_path)
    if not opened.is_valid():
        return _failed(opened.errors)
    var scene_root: Node = opened.root

    # An empty node path means the root node is the sprite.
    var node_path: String = _param_string(params, "node_path")
    var sprite_node := _resolve_scene_node(scene_root, node_path)
    if sprite_node == null:
        return _fail("Node not found: " + node_path)

    if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
        return _fail("Node is not a sprite-compatible type: " + sprite_node.get_class())

    var texture := load(full_texture_path) as Texture2D
    if texture == null:
        return _fail("Failed to load texture: " + full_texture_path)

    if sprite_node is Sprite2D:
        (sprite_node as Sprite2D).texture = texture
    elif sprite_node is Sprite3D:
        (sprite_node as Sprite3D).texture = texture
    else:
        (sprite_node as TextureRect).texture = texture

    var save_result := _save_scene_root(scene_root, full_scene_path)
    if not save_result.ok:
        return save_result

    print("Sprite loaded successfully with texture: " + full_texture_path)
    return _ok()

# Export a scene as a MeshLibrary resource
func export_mesh_library(params: Dictionary) -> OperationResult:
    var full_scene_path: String = _res_path(_param_string(params, "scene_path"))
    var full_output_path: String = _res_path(_param_string(params, "output_path"))
    print("Exporting MeshLibrary from scene: " + full_scene_path)

    var opened := _open_scene(full_scene_path)
    if not opened.is_valid():
        return _failed(opened.errors)
    var scene_root: Node = opened.root

    # An empty list means every mesh in the scene.
    var mesh_item_names: Array = _param_array(params, "mesh_item_names")
    var use_specific_items: bool = mesh_item_names.size() > 0

    var mesh_library := MeshLibrary.new()
    var item_id: int = 0

    for child in scene_root.get_children():
        var child_name: String = String(child.name)
        if use_specific_items and not (child_name in mesh_item_names):
            log_debug("Skipping node " + child_name + " (not in specified items list)")
            continue

        var mesh_instance := _find_mesh_instance(child)
        if mesh_instance == null or mesh_instance.mesh == null:
            log_debug("Node " + child_name + " has no valid mesh")
            continue

        mesh_library.create_item(item_id)
        mesh_library.set_item_name(item_id, child_name)
        mesh_library.set_item_mesh(item_id, mesh_instance.mesh)

        var shape := _find_collision_shape(child)
        if shape != null:
            mesh_library.set_item_shapes(item_id, [shape])

        log_debug("Added mesh '" + child_name + "' to library with ID: " + str(item_id))
        item_id += 1

    if item_id == 0:
        return _fail("No valid meshes found in the scene")

    var save_result := _save_resource(mesh_library, full_output_path, "MeshLibrary")
    if not save_result.ok:
        return save_result

    print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + full_output_path)
    return _ok()

# A library item's mesh is either the node itself or one of its direct children.
func _find_mesh_instance(node: Node) -> MeshInstance3D:
    if node is MeshInstance3D:
        return node
    for child in node.get_children():
        if child is MeshInstance3D:
            return child
    return null

func _find_collision_shape(node: Node) -> Shape3D:
    for child in node.get_children():
        if child is CollisionShape3D and (child as CollisionShape3D).shape != null:
            return (child as CollisionShape3D).shape
    return null

# Find files with a specific extension recursively
func find_files(path: String, extension: String) -> PackedStringArray:
    var files := PackedStringArray()
    var dir := DirAccess.open(path)

    if dir:
        @warning_ignore("return_value_discarded")
        dir.list_dir_begin()
        var file_name: String = dir.get_next()

        while file_name != "":
            if dir.current_is_dir() and not file_name.begins_with("."):
                files.append_array(find_files(path + file_name + "/", extension))
            elif file_name.ends_with(extension):
                @warning_ignore("return_value_discarded")
                files.append(path + file_name)

            file_name = dir.get_next()

    return files

# Get UID for a specific file
func get_uid(params: Dictionary) -> OperationResult:
    if not params.has("file_path"):
        return _fail("File path is required")

    var file_path: String = _res_path(_param_string(params, "file_path"))
    var absolute_path: String = ProjectSettings.globalize_path(file_path)
    print("Getting UID for file: " + file_path)

    if not FileAccess.file_exists(file_path):
        return _fail("File does not exist at: " + file_path, PackedStringArray([
            "Absolute file path that doesn't exist: " + absolute_path,
        ]))

    var result: Dictionary = {
        "file": file_path,
        "absolutePath": absolute_path,
    }

    var uid_file := FileAccess.open(file_path + ".uid", FileAccess.READ)
    if uid_file != null:
        var uid_content: String = uid_file.get_as_text()
        uid_file.close()
        result["uid"] = uid_content.strip_edges()
        result["exists"] = true
    else:
        log_debug("UID file does not exist or could not be opened for: " + file_path)
        result["exists"] = false
        result["message"] = "UID file does not exist for this file. Use resave_resources to generate UIDs."

    print(JSON.stringify(result))
    return _ok()

# Resave all resources to update UID references
func resave_resources(params: Dictionary) -> OperationResult:
    print("Resaving all resources to update UID references...")

    var project_path: String = RES_PREFIX
    if params.has("project_path"):
        project_path = _res_path(_param_string(params, "project_path"))
        if not project_path.ends_with("/"):
            project_path += "/"
    log_debug("Using project path: " + project_path)

    # Per-file problems accumulate here instead of being printed and quit on,
    # so the entry point reports them together.
    var errors: Array[String] = []

    var scenes := find_files(project_path, ".tscn")
    var saved_scenes: int = 0
    for scene_path in scenes:
        var scene := load(scene_path) as Resource
        if scene == null:
            errors.append("Failed to load: " + scene_path)
            continue

        var save_result := _save_resource(scene, scene_path, "scene")
        if save_result.ok:
            saved_scenes += 1
        else:
            errors.append_array(save_result.errors)

    # A missing .uid sidecar is regenerated by resaving the script or shader.
    var scripts := find_files(project_path, ".gd") + find_files(project_path, ".shader") + find_files(project_path, ".gdshader")
    var missing_uids: int = 0
    var generated_uids: int = 0

    for script_path in scripts:
        var uid_path: String = script_path + ".uid"
        if FileAccess.file_exists(uid_path):
            continue

        missing_uids += 1
        # ResourceSaver does not write .uid sidecars for scripts outside the
        # editor's import pipeline (verified on 4.7: resaving a .gd leaves no
        # sidecar), so create and persist a fresh UID explicitly, matching the
        # sidecar format the importer writes.
        var new_id: int = ResourceUID.create_id()
        var uid_file := FileAccess.open(uid_path, FileAccess.WRITE)
        if uid_file == null:
            errors.append("Failed to write UID file: " + uid_path)
            continue
        @warning_ignore("return_value_discarded")
        uid_file.store_line(ResourceUID.id_to_text(new_id))
        uid_file.close()
        if not ResourceUID.has_id(new_id):
            ResourceUID.add_id(new_id, script_path)
        generated_uids += 1

    log_debug("Summary:")
    log_debug("- Scenes processed: " + str(scenes.size()))
    log_debug("- Scenes successfully saved: " + str(saved_scenes))
    log_debug("- Scripts/shaders missing UIDs: " + str(missing_uids))
    log_debug("- UIDs successfully generated: " + str(generated_uids))
    log_debug("- Errors: " + str(errors.size()))
    print("Resave operation complete")

    if not errors.is_empty():
        return _failed(PackedStringArray(errors))
    return _ok()

# Save changes to a scene file
func save_scene(params: Dictionary) -> OperationResult:
    var full_scene_path: String = _res_path(_param_string(params, "scene_path"))
    print("Saving scene: " + full_scene_path)

    var opened := _open_scene(full_scene_path)
    if not opened.is_valid():
        return _failed(opened.errors)

    # A new path saves a copy; otherwise the scene is rewritten in place.
    var save_path: String = full_scene_path
    if params.has("new_path"):
        save_path = _res_path(_param_string(params, "new_path"))

    var save_result := _save_scene_root(opened.root, save_path)
    if not save_result.ok:
        return save_result

    print("Scene saved successfully to: " + save_path)
    return _ok()

# JSON decodes into Variant, so the conversions below are the one place where
# untyped values are narrowed. Every suppression in this file lives here.

# Helper: Narrow a JSON scalar to float
func _variant_to_float(value: Variant, default_value: float = 0.0) -> float:
    if value is float or value is int or value is bool:
        @warning_ignore("unsafe_call_argument")
        return float(value)
    if value is String:
        var text: String = value
        return text.to_float()
    return default_value

# Helper: Narrow a JSON scalar to int (JSON numbers decode as float)
func _variant_to_int(value: Variant, default_value: int = 0) -> int:
    if value is float or value is int or value is bool:
        @warning_ignore("unsafe_call_argument", "narrowing_conversion")
        return int(value)
    if value is String:
        var text: String = value
        return text.to_int()
    return default_value

# Helper: Narrow a JSON scalar to bool
func _variant_to_bool(value: Variant) -> bool:
    if value is bool:
        return value
    if value is float or value is int:
        return not is_zero_approx(_variant_to_float(value))
    if value is String:
        var text: String = value
        return text.to_lower() == "true"
    return false

# Helper: Read a float member out of a JSON object, tolerating ints
func _json_float(source: Dictionary, key: String, default_value: float = 0.0) -> float:
    return _variant_to_float(source.get(key, default_value), default_value)

# Helper: Read an int member out of a JSON object
func _json_int(source: Dictionary, key: String, default_value: int = 0) -> int:
    return _variant_to_int(source.get(key, default_value), default_value)

# Helper: Read a nested JSON object member
func _json_object(source: Dictionary, key: String) -> Dictionary:
    var value: Variant = source.get(key, {})
    if value is Dictionary:
        return value
    return {}

# Helper: Convert a JSON value to the correct Godot type based on a node's property type
func _convert_property_value(node: Object, prop_name: String, value: Variant) -> Variant:
    for prop in node.get_property_list():
        if prop["name"] == prop_name:
            var type_id: int = _variant_to_int(prop.get("type", 0))
            return _convert_to_property_type(type_id, value)
    return value

# Helper: Convert a JSON value to a specific Variant type, or return it unchanged
# when the value does not carry the shape that type needs
func _convert_to_property_type(type_id: int, value: Variant) -> Variant:
    var obj: Dictionary = value if value is Dictionary else {}
    var text: String = value if value is String else ""

    match type_id:
        TYPE_VECTOR2:
            if obj.has("x") and obj.has("y"):
                return Vector2(_json_float(obj, "x"), _json_float(obj, "y"))
        TYPE_VECTOR2I:
            if obj.has("x") and obj.has("y"):
                return Vector2i(_json_int(obj, "x"), _json_int(obj, "y"))
        TYPE_VECTOR3:
            if obj.has("x") and obj.has("y"):
                return Vector3(_json_float(obj, "x"), _json_float(obj, "y"), _json_float(obj, "z"))
        TYPE_VECTOR3I:
            if obj.has("x") and obj.has("y"):
                return Vector3i(_json_int(obj, "x"), _json_int(obj, "y"), _json_int(obj, "z"))
        TYPE_COLOR:
            if obj.has("r") and obj.has("g") and obj.has("b"):
                return Color(_json_float(obj, "r"), _json_float(obj, "g"), _json_float(obj, "b"), _json_float(obj, "a", 1.0))
            if text.begins_with("#"):
                return Color.html(text)
        TYPE_QUATERNION:
            if value is Dictionary:
                return Quaternion(_json_float(obj, "x"), _json_float(obj, "y"), _json_float(obj, "z"), _json_float(obj, "w", 1.0))
        TYPE_RECT2:
            if obj.has("position") and obj.has("size"):
                var pos: Dictionary = _json_object(obj, "position")
                var sz: Dictionary = _json_object(obj, "size")
                return Rect2(_json_float(pos, "x"), _json_float(pos, "y"), _json_float(sz, "x"), _json_float(sz, "y"))
        TYPE_AABB:
            if obj.has("position") and obj.has("size"):
                var pos: Dictionary = _json_object(obj, "position")
                var sz: Dictionary = _json_object(obj, "size")
                return AABB(
                    Vector3(_json_float(pos, "x"), _json_float(pos, "y"), _json_float(pos, "z")),
                    Vector3(_json_float(sz, "x"), _json_float(sz, "y"), _json_float(sz, "z"))
                )
        TYPE_BASIS:
            if obj.has("x") and obj.has("y") and obj.has("z"):
                return _json_basis(obj)
        TYPE_TRANSFORM3D:
            if obj.has("basis") and obj.has("origin"):
                var basis_d: Dictionary = _json_object(obj, "basis")
                var origin_d: Dictionary = _json_object(obj, "origin")
                var basis: Basis = Basis.IDENTITY
                if basis_d.has("x"):
                    basis = _json_basis(basis_d)
                var origin := Vector3(_json_float(origin_d, "x"), _json_float(origin_d, "y"), _json_float(origin_d, "z"))
                return Transform3D(basis, origin)
        TYPE_TRANSFORM2D:
            if obj.has("x") and obj.has("y") and obj.has("origin"):
                var tx: Dictionary = _json_object(obj, "x")
                var ty: Dictionary = _json_object(obj, "y")
                var t_origin: Dictionary = _json_object(obj, "origin")
                return Transform2D(
                    Vector2(_json_float(tx, "x"), _json_float(tx, "y")),
                    Vector2(_json_float(ty, "x"), _json_float(ty, "y")),
                    Vector2(_json_float(t_origin, "x"), _json_float(t_origin, "y"))
                )
        TYPE_BOOL:
            return _variant_to_bool(value)
        TYPE_INT:
            return _variant_to_int(value)
        TYPE_FLOAT:
            return _variant_to_float(value)
        TYPE_STRING:
            return str(value)
        TYPE_NODE_PATH:
            return NodePath(str(value))
        TYPE_OBJECT:
            if text.begins_with("res://"):
                if ResourceLoader.exists(text):
                    var res := load(text)
                    if res != null:
                        return res
                printerr("Failed to load resource from path: " + text)
            return value
    return value

# Helper: Build a Basis from a JSON object holding x/y/z column objects
func _json_basis(source: Dictionary) -> Basis:
    var bx: Dictionary = _json_object(source, "x")
    var by: Dictionary = _json_object(source, "y")
    var bz: Dictionary = _json_object(source, "z")
    return Basis(
        Vector3(_json_float(bx, "x"), _json_float(bx, "y"), _json_float(bx, "z")),
        Vector3(_json_float(by, "x"), _json_float(by, "y"), _json_float(by, "z")),
        Vector3(_json_float(bz, "x"), _json_float(bz, "y"), _json_float(bz, "z"))
    )

# Helper: Safe variant-to-string for scene reading
func _variant_to_string(value: Variant) -> String:
    if value == null:
        return "null"
    if value is String:
        return value
    if value is bool:
        return "true" if value else "false"
    if value is NodePath:
        return str(value)
    return str(value)

# Read a scene file and return its full node tree as JSON
func read_scene(params: Dictionary) -> OperationResult:
    if not params.has("scene_path"):
        return _fail("scene_path is required")

    var full_scene_path: String = _res_path(_param_string(params, "scene_path"))
    log_info("Reading scene: " + full_scene_path)

    if not FileAccess.file_exists(full_scene_path):
        return _fail("Scene file does not exist at: " + full_scene_path)

    var scene := load(full_scene_path) as PackedScene
    if not scene:
        # A scene that references missing external resources still has readable
        # text, so fall back to the raw file rather than failing the operation.
        var f := FileAccess.open(full_scene_path, FileAccess.READ)
        if f:
            var raw_content: String = f.get_as_text()
            f.close()
            print("SCENE_JSON_START")
            print(JSON.stringify({"error": "Failed to instantiate scene, returning raw text", "raw": raw_content.substr(0, 4096)}))
            print("SCENE_JSON_END")
            return _ok()
        return _fail("Failed to load scene: " + full_scene_path, PackedStringArray([
            "The scene may reference missing external resources.",
        ]))

    var scene_root := scene.instantiate()
    if scene_root == null:
        return _fail("Failed to instantiate scene: " + full_scene_path)

    var tree_data: Dictionary = _walk_scene_tree(scene_root)

    # Output as JSON for the TypeScript side to parse
    print("SCENE_JSON_START")
    print(JSON.stringify(tree_data))
    print("SCENE_JSON_END")

    # queue_free() is never processed under --script before quit(), so free
    # the tree immediately.
    scene_root.free()
    return _ok()

func _walk_scene_tree(node: Node) -> Dictionary:
    var info: Dictionary = {
        "name": node.name,
        "type": node.get_class(),
    }

    # Include script path if attached
    var node_script: Script = node.get_script()
    if node_script != null:
        info["script"] = node_script.resource_path

    # Collect non-default properties
    var props: Dictionary = {}
    for prop in node.get_property_list():
        var prop_name: String = prop["name"]
        var usage: int = prop.get("usage", 0)
        # Only include editor-visible, storage properties
        if usage & PROPERTY_USAGE_EDITOR and usage & PROPERTY_USAGE_STORAGE:
            var value: Variant = node.get(prop_name)
            if value != null:
                props[prop_name] = _variant_to_string(value)

    if props.size() > 0:
        info["properties"] = props

    # Include groups
    var groups: Array[StringName] = node.get_groups()
    if groups.size() > 0:
        var group_names: Array[String] = []
        for g in groups:
            group_names.append(String(g))
        info["groups"] = group_names

    # Recurse into children
    var children_arr: Array[Dictionary] = []
    for child in node.get_children():
        children_arr.append(_walk_scene_tree(child))

    if children_arr.size() > 0:
        info["children"] = children_arr

    return info

# Modify a node's properties in a scene file
func modify_node(params: Dictionary) -> OperationResult:
    if not params.has("scene_path") or not params.has("node_path") or not params.has("properties"):
        return _fail("scene_path, node_path, and properties are required")

    var full_scene_path: String = _res_path(_param_string(params, "scene_path"))
    log_info("Modifying node in scene: " + full_scene_path)

    var opened := _open_scene(full_scene_path)
    if not opened.is_valid():
        return _failed(opened.errors)

    var node_path: String = _param_string(params, "node_path")
    var target := _resolve_scene_node(opened.root, node_path)
    if target == null:
        return _fail("Node not found: " + node_path)

    _apply_properties(target, _param_dictionary(params, "properties"))

    var save_result := _save_scene_root(opened.root, full_scene_path)
    if not save_result.ok:
        return save_result

    print("Node modified successfully in: " + full_scene_path)
    return _ok()

# Remove a node from a scene file
func remove_node(params: Dictionary) -> OperationResult:
    if not params.has("scene_path") or not params.has("node_path"):
        return _fail("scene_path and node_path are required")

    var full_scene_path: String = _res_path(_param_string(params, "scene_path"))
    log_info("Removing node from scene: " + full_scene_path)

    var opened := _open_scene(full_scene_path)
    if not opened.is_valid():
        return _failed(opened.errors)
    var scene_root: Node = opened.root

    var node_path: String = _param_string(params, "node_path")
    var target := _resolve_scene_node(scene_root, node_path)
    if target == null:
        return _fail("Node not found: " + node_path)

    if target == scene_root:
        return _fail("Cannot remove the root node of a scene")

    var removed_name: String = String(target.name)
    target.get_parent().remove_child(target)
    # queue_free() is never processed under --script before quit(); free the
    # detached subtree immediately so it cannot leak at exit.
    target.free()

    var save_result := _save_scene_root(scene_root, full_scene_path)
    if not save_result.ok:
        return save_result

    print("Node '" + removed_name + "' removed successfully from: " + full_scene_path)
    return _ok()

# Attach a script to a node in a scene file
func attach_script(params: Dictionary) -> OperationResult:
    if not params.has("scene_path") or not params.has("node_path") or not params.has("script_path"):
        return _fail("scene_path, node_path, and script_path are required")

    var full_scene_path: String = _res_path(_param_string(params, "scene_path"))
    var full_script_path: String = _res_path(_param_string(params, "script_path"))
    log_info("Attaching script " + full_script_path + " to node in scene: " + full_scene_path)

    if not FileAccess.file_exists(full_script_path):
        return _fail("Script file does not exist at: " + full_script_path)

    var opened := _open_scene(full_scene_path)
    if not opened.is_valid():
        return _failed(opened.errors)

    var node_path: String = _param_string(params, "node_path")
    var target := _resolve_scene_node(opened.root, node_path)
    if target == null:
        return _fail("Node not found: " + node_path)

    var script := load(full_script_path) as Script
    if script == null:
        return _fail("Failed to load script: " + full_script_path)

    target.set_script(script)

    var save_result := _save_scene_root(opened.root, full_scene_path)
    if not save_result.ok:
        return save_result

    print("Script '" + full_script_path + "' attached successfully to node in: " + full_scene_path)
    return _ok()

# Create a resource file (.tres)
func create_resource(params: Dictionary) -> OperationResult:
    if not params.has("resource_type") or not params.has("resource_path"):
        return _fail("resource_type and resource_path are required")

    var resource_type: String = _param_string(params, "resource_type")
    var full_resource_path: String = _res_path(_param_string(params, "resource_path"))
    log_info("Creating resource of type " + resource_type + " at: " + full_resource_path)

    if not ClassDB.class_exists(resource_type):
        return _fail("Unknown resource type: " + resource_type, PackedStringArray([
            "Must be a valid Godot class name (e.g., StandardMaterial3D, AudioStreamPlayer, Theme)",
        ]))

    if not ClassDB.can_instantiate(resource_type):
        return _fail("Cannot instantiate resource type: " + resource_type)

    var instance: Object = ClassDB.instantiate(resource_type)
    if instance == null:
        return _fail("Failed to instantiate resource of type: " + resource_type)

    var resource := instance as Resource
    if resource == null:
        return _fail("Type " + resource_type + " is not a Resource subclass")

    _apply_properties(resource, _param_dictionary(params, "properties"))

    var save_result := _save_resource(resource, full_resource_path, "resource")
    if not save_result.ok:
        return save_result

    print("Resource created successfully at: " + full_resource_path)
    return _ok()


func manage_resource(params: Dictionary) -> OperationResult:
    var full_path: String = _res_path(_param_string(params, "resource_path"))
    var action: String = _param_string(params, "action", "read")

    if action != "read" and action != "modify":
        return _fail("Unknown manage_resource action: " + action, PackedStringArray([
            "Allowed actions: read, modify",
        ]))

    var opened := _open_resource(full_path, "Resource")
    if not opened.is_valid():
        return _failed(opened.errors)
    var resource: Resource = opened.resource

    if action == "read":
        var props: Dictionary = {}
        for prop in resource.get_property_list():
            var usage: int = prop.get("usage", 0)
            if usage & PROPERTY_USAGE_STORAGE:
                var prop_name: String = prop["name"]
                props[prop_name] = str(resource.get(prop_name))
        print("RESOURCE_JSON_START")
        print(JSON.stringify({"type": resource.get_class(), "path": full_path, "properties": props}))
        print("RESOURCE_JSON_END")
        return _ok()

    _apply_properties(resource, _param_dictionary(params, "properties"))

    var save_result := _save_resource(resource, full_path, "resource")
    if not save_result.ok:
        return save_result

    print("Resource modified: " + full_path)
    return _ok()


func manage_scene_signals(params: Dictionary) -> OperationResult:
    var full_path: String = _res_path(_param_string(params, "scene_path"))
    var action: String = _param_string(params, "action", "list")

    if not FileAccess.file_exists(full_path):
        return _fail("Scene not found: " + full_path)

    var content: String = FileAccess.get_file_as_string(full_path)

    if action == "list":
        var connections: Array[String] = []
        var lines: PackedStringArray = content.split("\n")
        for line in lines:
            if line.begins_with("[connection"):
                connections.append(line.strip_edges())
        print("SIGNALS_JSON_START")
        print(JSON.stringify({"connections": connections}))
        print("SIGNALS_JSON_END")
    elif action == "add":
        var signal_name: String = _param_string(params, "signal_name")
        var source_path: String = _param_string(params, "source_path", ".")
        var target_path: String = _param_string(params, "target_path", ".")
        var method: String = _param_string(params, "method")
        var conn_line: String = '[connection signal="%s" from="%s" to="%s" method="%s"]' % [signal_name, source_path, target_path, method]
        content += "\n" + conn_line + "\n"
        var file := FileAccess.open(full_path, FileAccess.WRITE)
        if file == null:
            return _fail("Failed to open scene for writing: " + full_path + ", error: " + str(FileAccess.get_open_error()))
        @warning_ignore("return_value_discarded")
        file.store_string(content)
        file.close()
        print("Signal connection added: " + conn_line)
    elif action == "remove":
        var signal_name: String = _param_string(params, "signal_name")
        var lines: PackedStringArray = content.split("\n")
        var new_lines := PackedStringArray()
        for line in lines:
            if not (line.begins_with("[connection") and signal_name in line):
                @warning_ignore("return_value_discarded")
                new_lines.append(line)
        var file := FileAccess.open(full_path, FileAccess.WRITE)
        if file == null:
            return _fail("Failed to open scene for writing: " + full_path + ", error: " + str(FileAccess.get_open_error()))
        @warning_ignore("return_value_discarded")
        file.store_string("\n".join(new_lines))
        file.close()
        print("Signal connections for '%s' removed" % signal_name)
    else:
        return _fail("Unknown manage_scene_signals action: " + action, PackedStringArray([
            "Allowed actions: list, add, remove",
        ]))

    return _ok()


func manage_theme_resource(params: Dictionary) -> OperationResult:
    var full_path: String = _res_path(_param_string(params, "resource_path"))
    var action: String = _param_string(params, "action", "read")
    var properties: Dictionary = _param_dictionary(params, "properties")

    if action == "create":
        var new_theme := Theme.new()
        for key: String in properties:
            new_theme.set(key, properties[key])

        var create_result := _save_resource(new_theme, full_path, "theme")
        if not create_result.ok:
            return create_result

        print("Theme created at: " + full_path)
        return _ok()

    if action != "read" and action != "modify":
        return _fail("Unknown manage_theme_resource action: " + action, PackedStringArray([
            "Allowed actions: create, read, modify",
        ]))

    var opened := _open_resource(full_path, "Theme")
    if not opened.is_valid():
        return _failed(opened.errors)
    var theme: Resource = opened.resource

    if action == "read":
        print("THEME_JSON_START")
        print(JSON.stringify({"type": theme.get_class(), "path": full_path}))
        print("THEME_JSON_END")
        return _ok()

    for key: String in properties:
        theme.set(key, properties[key])

    var save_result := _save_resource(theme, full_path, "theme")
    if not save_result.ok:
        return save_result

    print("Theme modified: " + full_path)
    return _ok()


func manage_scene_structure(params: Dictionary) -> OperationResult:
    var full_path: String = _res_path(_param_string(params, "scene_path"))
    var action: String = _param_string(params, "action", "rename")
    var node_path_str: String = _param_string(params, "node_path")

    var opened := _open_scene(full_path)
    if not opened.is_valid():
        return _failed(opened.errors)
    var scene_root: Node = opened.root

    var target := _resolve_scene_node(scene_root, node_path_str)
    if target == null:
        return _fail("Node not found: " + node_path_str)

    if action == "rename":
        var new_name: String = _param_string(params, "new_name")
        if new_name.is_empty():
            return _fail("new_name is required for rename")
        target.name = new_name
        print("Node renamed to '%s'" % target.name)
    elif action == "duplicate":
        if target == scene_root:
            return _fail("Cannot duplicate the root node")
        var dup := target.duplicate()
        target.get_parent().add_child(dup, true)
        _set_owner_recursive(dup, scene_root)
        print("Node duplicated: %s (as '%s')" % [node_path_str, dup.name])
    elif action == "move":
        var new_parent_path: String = _param_string(params, "new_parent_path")
        if new_parent_path.is_empty():
            return _fail("new_parent_path is required for move")
        if target == scene_root:
            return _fail("Cannot move the root node")
        var new_parent := _resolve_scene_node(scene_root, new_parent_path)
        if new_parent == null:
            return _fail("New parent not found: " + new_parent_path)
        if new_parent == target or _is_ancestor(target, new_parent):
            return _fail("Cannot move a node into itself or one of its descendants")
        target.get_parent().remove_child(target)
        # Descendants keep their owner across remove_child, and add_child warns
        # that the pending owner would be inconsistent; clear owners first and
        # reassign them once the subtree is in place.
        _clear_owner_recursive(target)
        new_parent.add_child(target, true)
        _set_owner_recursive(target, scene_root)
        print("Node moved: %s -> parent %s (as '%s')" % [node_path_str, new_parent_path, target.name])
    else:
        return _fail("Unknown manage_scene_structure action: " + action, PackedStringArray([
            "Allowed actions: rename, duplicate, move",
        ]))

    var save_result := _save_scene_root(scene_root, full_path)
    if not save_result.ok:
        return save_result

    print("Scene structure saved: " + full_path)
    return _ok()


func _clear_owner_recursive(node: Node) -> void:
    node.owner = null
    for c in node.get_children():
        _clear_owner_recursive(c)


func _set_owner_recursive(node: Node, owner_root: Node) -> void:
    node.owner = owner_root
    if node.scene_file_path != "":
        return
    for c in node.get_children():
        _set_owner_recursive(c, owner_root)


func _is_ancestor(node: Node, maybe_descendant: Node) -> bool:
    var n := maybe_descendant.get_parent()
    while n != null:
        if n == node:
            return true
        n = n.get_parent()
    return false
