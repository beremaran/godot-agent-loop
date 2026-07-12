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

# Debug mode flag
var debug_mode: bool = false

# Operation name -> handler. The single source of truth for which operations
# exist; the CLI rejects any name that is not registered here.
var _operations: Dictionary[String, Callable] = {}

func _init() -> void:
    _register_operations()

    var args: PackedStringArray = OS.get_cmdline_args()
    debug_mode = "--debug-godot" in args

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

    log_debug("All arguments: " + str(args))
    log_debug("Script index: " + str(script_index))
    log_debug("Operation index: " + str(operation_index))
    log_debug("Params index: " + str(params_index))

    var operation: String = args[operation_index]
    var params_json: String = args[params_index]

    log_info("Operation: " + operation)
    log_debug("Params JSON: " + params_json)

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
    if debug_mode:
        print("[DEBUG] " + message)

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

# Get a script by name or path
func get_script_by_name(name_of_class: String) -> Script:
    if debug_mode:
        print("Attempting to get script for class: " + name_of_class)

    # Try to load it directly if it's a resource path
    if ResourceLoader.exists(name_of_class, "Script"):
        if debug_mode:
            print("Resource exists, loading directly: " + name_of_class)
        var script := load(name_of_class) as Script
        if script:
            if debug_mode:
                print("Successfully loaded script from path")
            return script
        else:
            printerr("Failed to load script from path: " + name_of_class)
    elif debug_mode:
        print("Resource not found, checking global class registry")

    # Search for it in the global class registry if it's a class name
    var global_classes: Array[Dictionary] = ProjectSettings.get_global_class_list()
    if debug_mode:
        print("Searching through " + str(global_classes.size()) + " global classes")

    for global_class in global_classes:
        var found_name_of_class: String = global_class["class"]
        var found_path: String = global_class["path"]

        if found_name_of_class == name_of_class:
            if debug_mode:
                print("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
            var script := load(found_path) as Script
            if script:
                if debug_mode:
                    print("Successfully loaded script from registry")
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
    if debug_mode:
        print("Attempting to instantiate class: " + name_of_class)

    # Check if it's a built-in class
    if ClassDB.class_exists(name_of_class):
        if debug_mode:
            print("Class exists in ClassDB, using ClassDB.instantiate()")
        if ClassDB.can_instantiate(name_of_class):
            result = ClassDB.instantiate(name_of_class)
            if result == null:
                printerr("ClassDB.instantiate() returned null for class: " + name_of_class)
        else:
            printerr("Class exists but cannot be instantiated: " + name_of_class)
            printerr("This may be an abstract class or interface that cannot be directly instantiated")
    else:
        # Try to get the script
        if debug_mode:
            print("Class not found in ClassDB, trying to get script")
        var script := get_script_by_name(name_of_class)
        if script is GDScript:
            if debug_mode:
                print("Found GDScript, creating instance")
            result = (script as GDScript).new()
        else:
            printerr("Failed to get script for class: " + name_of_class)
            return null

    if result == null:
        printerr("Failed to instantiate class: " + name_of_class)
    elif debug_mode:
        print("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())

    return result

# Instantiate a class that must be a Node (scene operations)
func instantiate_node(name_of_class: String) -> Node:
    return instantiate_class(name_of_class) as Node

# Create a new scene with a specified root node type
func create_scene(params: Dictionary) -> OperationResult:
    var scene_path: String = _param_string(params, "scene_path")
    print("Creating scene: " + scene_path)

    # Get project paths and log them for debugging
    var project_res_path: String = "res://"
    var project_user_path: String = "user://"
    var global_res_path: String = ProjectSettings.globalize_path(project_res_path)
    var global_user_path: String = ProjectSettings.globalize_path(project_user_path)

    if debug_mode:
        print("Project paths:")
        print("- res:// path: " + project_res_path)
        print("- user:// path: " + project_user_path)
        print("- Globalized res:// path: " + global_res_path)
        print("- Globalized user:// path: " + global_user_path)

        # Print some common environment variables for debugging
        print("Environment variables:")
        var env_vars: Array[String] = ["PATH", "HOME", "USER", "TEMP", "GODOT_PATH"]
        for env_var in env_vars:
            if OS.has_environment(env_var):
                print("  " + env_var + " = " + OS.get_environment(env_var))

    # Normalize the scene path
    var full_scene_path: String = scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)

    # Convert resource path to an absolute path
    var absolute_scene_path: String = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)

    # Get the scene directory paths
    var scene_dir_res: String = full_scene_path.get_base_dir()
    var scene_dir_abs: String = absolute_scene_path.get_base_dir()
    if debug_mode:
        print("Scene directory (resource path): " + scene_dir_res)
        print("Scene directory (absolute path): " + scene_dir_abs)

    # Only do extensive testing in debug mode
    if debug_mode:
        # Try to create a simple test file in the project root to verify write access
        var initial_test_file_path: String = "res://godot_mcp_test_write.tmp"
        var initial_test_file := FileAccess.open(initial_test_file_path, FileAccess.WRITE)
        if initial_test_file:
            @warning_ignore("return_value_discarded")
            initial_test_file.store_string("Test write access")
            initial_test_file.close()
            print("Successfully wrote test file to project root: " + initial_test_file_path)

            # Verify the test file exists
            var initial_test_file_exists: bool = FileAccess.file_exists(initial_test_file_path)
            print("Test file exists check: " + str(initial_test_file_exists))

            # Clean up the test file
            if initial_test_file_exists:
                var remove_error: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(initial_test_file_path))
                print("Test file removal result: " + str(remove_error))
        else:
            var write_error: Error = FileAccess.get_open_error()
            printerr("Failed to write test file to project root: " + str(write_error))
            printerr("This indicates a serious permission issue with the project directory")

    # Use traditional if-else statement for better compatibility
    var root_node_type: String = "Node2D"  # Default value
    if params.has("root_node_type"):
        root_node_type = _param_string(params, "root_node_type")
    if debug_mode:
        print("Root node type: " + root_node_type)

    # Create the root node
    var scene_root := instantiate_node(root_node_type)
    if not scene_root:
        return _fail("Failed to instantiate node of type: " + root_node_type, PackedStringArray([
            "Make sure the class exists and can be instantiated",
            "Check if the class is registered in ClassDB or available as a script",
        ]))

    scene_root.name = "root"
    if debug_mode:
        print("Root node created with name: " + scene_root.name)

    # Set the owner of the root node to itself (important for scene saving)
    scene_root.owner = scene_root

    # Pack the scene
    var packed_scene := PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        # Only do extensive testing in debug mode
        if debug_mode:
            # First, let's verify we can write to the project directory
            print("Testing write access to project directory...")
            var test_write_path: String = "res://test_write_access.tmp"
            var test_write_abs: String = ProjectSettings.globalize_path(test_write_path)
            var test_file := FileAccess.open(test_write_path, FileAccess.WRITE)

            if test_file:
                @warning_ignore("return_value_discarded")
                test_file.store_string("Write test")
                test_file.close()
                print("Successfully wrote test file to project directory")

                # Clean up test file
                if FileAccess.file_exists(test_write_path):
                    var remove_error: Error = DirAccess.remove_absolute(test_write_abs)
                    print("Test file removal result: " + str(remove_error))
            else:
                var write_error: Error = FileAccess.get_open_error()
                printerr("Failed to write test file to project directory: " + str(write_error))
                printerr("This may indicate permission issues with the project directory")
                # Continue anyway, as the scene directory might still be writable

        # Ensure the scene directory exists using DirAccess
        if debug_mode:
            print("Ensuring scene directory exists...")

        # Get the scene directory relative to res://
        var scene_dir_relative: String = scene_dir_res.substr(6)  # Remove "res://" prefix
        if debug_mode:
            print("Scene directory (relative to res://): " + scene_dir_relative)

        # Create the directory if needed
        if not scene_dir_relative.is_empty():
            # First check if it exists
            var dir_exists: bool = DirAccess.dir_exists_absolute(scene_dir_abs)
            if debug_mode:
                print("Directory exists check (absolute): " + str(dir_exists))

            if not dir_exists:
                if debug_mode:
                    print("Directory doesn't exist, creating: " + scene_dir_relative)

                # Try to create the directory using DirAccess
                var dir := DirAccess.open("res://")
                if dir == null:
                    var open_error: Error = DirAccess.get_open_error()
                    printerr("Failed to open res:// directory: " + str(open_error))

                    # Try alternative approach with absolute path
                    if debug_mode:
                        print("Trying alternative directory creation approach...")
                    var make_dir_error: Error = DirAccess.make_dir_recursive_absolute(scene_dir_abs)
                    if debug_mode:
                        print("Make directory result (absolute): " + str(make_dir_error))

                    if make_dir_error != OK:
                        return _fail("Failed to create directory using absolute path", PackedStringArray([
                            "Error code: " + str(make_dir_error),
                        ]))
                else:
                    # Create the directory using the DirAccess instance
                    if debug_mode:
                        print("Creating directory using DirAccess: " + scene_dir_relative)
                    var make_dir_error: Error = dir.make_dir_recursive(scene_dir_relative)
                    if debug_mode:
                        print("Make directory result: " + str(make_dir_error))

                    if make_dir_error != OK:
                        return _fail("Failed to create directory: " + scene_dir_relative, PackedStringArray([
                            "Error code: " + str(make_dir_error),
                        ]))

                # Verify the directory was created
                dir_exists = DirAccess.dir_exists_absolute(scene_dir_abs)
                if debug_mode:
                    print("Directory exists check after creation: " + str(dir_exists))

                if not dir_exists:
                    return _fail("Directory reported as created but does not exist: " + scene_dir_abs, PackedStringArray([
                        "This may indicate a problem with path resolution or permissions",
                    ]))
            elif debug_mode:
                print("Directory already exists: " + scene_dir_abs)

        # Save the scene
        if debug_mode:
            print("Saving scene to: " + full_scene_path)
        var save_error: Error = ResourceSaver.save(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")

        if save_error == OK:
            # Only do extensive testing in debug mode
            if debug_mode:
                # Wait a moment to ensure file system has time to complete the write
                print("Waiting for file system to complete write operation...")
                OS.delay_msec(500)  # 500ms delay

                # Verify the file was actually created using multiple methods
                var file_check_abs: bool = FileAccess.file_exists(absolute_scene_path)
                print("File exists check (absolute path): " + str(file_check_abs))

                var file_check_res: bool = FileAccess.file_exists(full_scene_path)
                print("File exists check (resource path): " + str(file_check_res))

                var res_exists: bool = ResourceLoader.exists(full_scene_path)
                print("Resource exists check: " + str(res_exists))

                # If file doesn't exist by absolute path, try to create a test file in the same directory
                if not file_check_abs and not file_check_res:
                    printerr("Scene file not found after save. Trying to diagnose the issue...")

                    # Try to write a test file to the same directory
                    var test_scene_file_path: String = scene_dir_res + "/test_scene_file.tmp"
                    var test_scene_file := FileAccess.open(test_scene_file_path, FileAccess.WRITE)

                    if test_scene_file:
                        @warning_ignore("return_value_discarded")
                        test_scene_file.store_string("Test scene directory write")
                        test_scene_file.close()
                        print("Successfully wrote test file to scene directory: " + test_scene_file_path)

                        # Check if the test file exists
                        var test_file_exists: bool = FileAccess.file_exists(test_scene_file_path)
                        print("Test file exists: " + str(test_file_exists))

                        if test_file_exists:
                            # Directory is writable, so the issue is with scene saving
                            printerr("Directory is writable but scene file wasn't created.")
                            printerr("This suggests an issue with ResourceSaver.save() or the packed scene.")

                            # Try saving with a different approach
                            print("Trying alternative save approach...")
                            var alt_save_error: Error = ResourceSaver.save(packed_scene, test_scene_file_path + ".tscn")
                            print("Alternative save result: " + str(alt_save_error))

                            # Clean up test files
                            var remove_error: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path))
                            print("Test file removal result: " + str(remove_error))
                            if alt_save_error == OK:
                                var remove_alt_error: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path + ".tscn"))
                                print("Alternative test file removal result: " + str(remove_alt_error))
                        else:
                            printerr("Test file couldn't be verified. This suggests filesystem access issues.")
                    else:
                        var write_error: Error = FileAccess.get_open_error()
                        printerr("Failed to write test file to scene directory: " + str(write_error))
                        printerr("This confirms there are permission or path issues with the scene directory.")

                    # Return error since we couldn't create the scene file
                    return _fail("Failed to create scene: " + scene_path)

                # If we get here, at least one of our file checks passed
                if file_check_abs or file_check_res or res_exists:
                    print("Scene file verified to exist!")

                    # Try to load the scene to verify it's valid
                    var test_load := ResourceLoader.load(full_scene_path)
                    if test_load:
                        print("Scene created and verified successfully at: " + scene_path)
                        print("Scene file can be loaded correctly.")
                    else:
                        print("Scene file exists but cannot be loaded. It may be corrupted or incomplete.")
                        # Continue anyway since the file exists

                    print("Scene created successfully at: " + scene_path)
                else:
                    return _fail("All file existence checks failed despite successful save operation.", PackedStringArray([
                        "This indicates a serious issue with file system access or path resolution.",
                    ]))
            else:
                # In non-debug mode, just check if the file exists
                var file_exists: bool = FileAccess.file_exists(full_scene_path)
                if file_exists:
                    print("Scene created successfully at: " + scene_path)
                else:
                    return _fail("Failed to create scene: " + scene_path)
        else:
            # Handle specific error codes
            var error_message: String = "Failed to save scene. Error code: " + str(save_error)

            if save_error == ERR_CANT_CREATE:
                error_message += " (ERR_CANT_CREATE - Cannot create the scene file)"
            elif save_error == ERR_CANT_OPEN:
                error_message += " (ERR_CANT_OPEN - Cannot open the scene file for writing)"
            elif save_error == ERR_FILE_CANT_WRITE:
                error_message += " (ERR_FILE_CANT_WRITE - Cannot write to the scene file)"
            elif save_error == ERR_FILE_NO_PERMISSION:
                error_message += " (ERR_FILE_NO_PERMISSION - No permission to write the scene file)"

            return _fail(error_message)
    else:
        return _fail("Failed to pack scene: " + str(result), PackedStringArray([
            "Error code: " + str(result),
        ]))

    return _ok()

# Add a node to an existing scene
func add_node(params: Dictionary) -> OperationResult:
    var scene_path: String = _param_string(params, "scene_path")
    print("Adding node to scene: " + scene_path)

    var full_scene_path: String = scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)

    var absolute_scene_path: String = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)

    if not FileAccess.file_exists(absolute_scene_path):
        return _fail("Scene file does not exist at: " + absolute_scene_path)

    var scene := load(full_scene_path) as PackedScene
    if not scene:
        return _fail("Failed to load scene: " + full_scene_path)

    if debug_mode:
        print("Scene loaded successfully")
    var scene_root := scene.instantiate()
    if debug_mode:
        print("Scene instantiated")

    # Use traditional if-else statement for better compatibility
    var parent_path: String = "root"  # Default value
    if params.has("parent_node_path"):
        parent_path = _param_string(params, "parent_node_path")
    if debug_mode:
        print("Parent path: " + parent_path)

    var parent: Node = scene_root
    if parent_path != "root":
        parent = scene_root.get_node(parent_path.replace("root/", ""))
        if not parent:
            return _fail("Parent node not found: " + parent_path)
    if debug_mode:
        print("Parent node found: " + parent.name)

    var node_type: String = _param_string(params, "node_type")
    if debug_mode:
        print("Instantiating node of type: " + node_type)
    var new_node := instantiate_node(node_type)
    if not new_node:
        return _fail("Failed to instantiate node of type: " + node_type, PackedStringArray([
            "Make sure the class exists and can be instantiated",
            "Check if the class is registered in ClassDB or available as a script",
        ]))
    var node_name: String = _param_string(params, "node_name")
    new_node.name = node_name
    if debug_mode:
        print("New node created with name: " + new_node.name)

    if params.has("properties"):
        if debug_mode:
            print("Setting properties on node")
        var properties: Dictionary = _param_dictionary(params, "properties")
        for property: String in properties:
            var converted: Variant = _convert_property_value(new_node, property, properties[property])
            if debug_mode:
                print("Setting property: " + property + " = " + str(converted))
            new_node.set(property, converted)

    parent.add_child(new_node)
    new_node.owner = scene_root
    if debug_mode:
        print("Node added to parent and ownership set")

    var packed_scene := PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        if debug_mode:
            print("Saving scene to: " + absolute_scene_path)
        var save_error: Error = ResourceSaver.save(packed_scene, absolute_scene_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")
        if save_error == OK:
            if debug_mode:
                var file_check_after: bool = FileAccess.file_exists(absolute_scene_path)
                print("File exists check after save: " + str(file_check_after))
                if file_check_after:
                    print("Node '" + node_name + "' of type '" + node_type + "' added successfully")
                else:
                    return _fail("File reported as saved but does not exist at: " + absolute_scene_path)
            else:
                print("Node '" + node_name + "' of type '" + node_type + "' added successfully")
        else:
            return _fail("Failed to save scene: " + str(save_error))
    else:
        return _fail("Failed to pack scene: " + str(result))

    return _ok()

# Load a sprite into a Sprite2D node
func load_sprite(params: Dictionary) -> OperationResult:
    var scene_path: String = _param_string(params, "scene_path")
    print("Loading sprite into scene: " + scene_path)

    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path: String = scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)

    # Check if the scene file exists
    var file_check: bool = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))

    if not file_check:
        return _fail("Scene file does not exist at: " + full_scene_path, PackedStringArray([
            "Absolute file path that doesn't exist: " + ProjectSettings.globalize_path(full_scene_path),
        ]))

    # Ensure the texture path starts with res:// for Godot's resource system
    var full_texture_path: String = _param_string(params, "texture_path")
    if not full_texture_path.begins_with("res://"):
        full_texture_path = "res://" + full_texture_path

    if debug_mode:
        print("Full texture path (with res://): " + full_texture_path)

    # Load the scene
    var scene := load(full_scene_path) as PackedScene
    if not scene:
        return _fail("Failed to load scene: " + full_scene_path)

    if debug_mode:
        print("Scene loaded successfully")

    # Instance the scene
    var scene_root := scene.instantiate()
    if debug_mode:
        print("Scene instantiated")

    # Find the sprite node
    var requested_node_path: String = _param_string(params, "node_path")
    var node_path: String = requested_node_path
    if debug_mode:
        print("Original node path: " + node_path)

    if node_path.begins_with("root/"):
        node_path = node_path.substr(5)  # Remove "root/" prefix
        if debug_mode:
            print("Node path after removing 'root/' prefix: " + node_path)

    var sprite_node: Node = null
    if node_path == "":
        # If no node path, assume root is the sprite
        sprite_node = scene_root
        if debug_mode:
            print("Using root node as sprite node")
    else:
        sprite_node = scene_root.get_node(node_path)
        if sprite_node and debug_mode:
            print("Found sprite node: " + sprite_node.name)

    if not sprite_node:
        return _fail("Node not found: " + requested_node_path)

    # Check if the node is a Sprite2D or compatible type
    if debug_mode:
        print("Node class: " + sprite_node.get_class())
    if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
        return _fail("Node is not a sprite-compatible type: " + sprite_node.get_class())

    # Load the texture
    if debug_mode:
        print("Loading texture from: " + full_texture_path)
    var texture := load(full_texture_path) as Texture2D
    if not texture:
        return _fail("Failed to load texture: " + full_texture_path)

    if debug_mode:
        print("Texture loaded successfully")

    # Set the texture on the sprite
    if sprite_node is Sprite2D:
        (sprite_node as Sprite2D).texture = texture
        if debug_mode:
            print("Set texture on Sprite2D/Sprite3D node")
    elif sprite_node is Sprite3D:
        (sprite_node as Sprite3D).texture = texture
        if debug_mode:
            print("Set texture on Sprite2D/Sprite3D node")
    elif sprite_node is TextureRect:
        (sprite_node as TextureRect).texture = texture
        if debug_mode:
            print("Set texture on TextureRect node")

    # Save the modified scene
    var packed_scene := PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        if debug_mode:
            print("Saving scene to: " + full_scene_path)
        var error: Error = ResourceSaver.save(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")

        if error == OK:
            # Verify the file was actually updated
            if debug_mode:
                var file_check_after: bool = FileAccess.file_exists(full_scene_path)
                print("File exists check after save: " + str(file_check_after))

                if file_check_after:
                    print("Sprite loaded successfully with texture: " + full_texture_path)
                    # Get the absolute path for reference
                    var absolute_path: String = ProjectSettings.globalize_path(full_scene_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    return _fail("File reported as saved but does not exist at: " + full_scene_path)
            else:
                print("Sprite loaded successfully with texture: " + full_texture_path)
        else:
            return _fail("Failed to save scene: " + str(error))
    else:
        return _fail("Failed to pack scene: " + str(result))

    return _ok()

# Export a scene as a MeshLibrary resource
func export_mesh_library(params: Dictionary) -> OperationResult:
    var scene_path: String = _param_string(params, "scene_path")
    print("Exporting MeshLibrary from scene: " + scene_path)

    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path: String = scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)

    # Ensure the output path starts with res:// for Godot's resource system
    var full_output_path: String = _param_string(params, "output_path")
    if not full_output_path.begins_with("res://"):
        full_output_path = "res://" + full_output_path

    if debug_mode:
        print("Full output path (with res://): " + full_output_path)

    # Check if the scene file exists
    var file_check: bool = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))

    if not file_check:
        return _fail("Scene file does not exist at: " + full_scene_path, PackedStringArray([
            "Absolute file path that doesn't exist: " + ProjectSettings.globalize_path(full_scene_path),
        ]))

    # Load the scene
    if debug_mode:
        print("Loading scene from: " + full_scene_path)
    var scene := load(full_scene_path) as PackedScene
    if not scene:
        return _fail("Failed to load scene: " + full_scene_path)

    if debug_mode:
        print("Scene loaded successfully")

    # Instance the scene
    var scene_root := scene.instantiate()
    if debug_mode:
        print("Scene instantiated")

    # Create a new MeshLibrary
    var mesh_library := MeshLibrary.new()
    if debug_mode:
        print("Created new MeshLibrary")

    # Get mesh item names if provided
    var mesh_item_names: Array = _param_array(params, "mesh_item_names")
    var use_specific_items: bool = mesh_item_names.size() > 0

    if debug_mode:
        if use_specific_items:
            print("Using specific mesh items: " + str(mesh_item_names))
        else:
            print("Using all mesh items in the scene")

    # Process all child nodes
    var item_id: int = 0
    if debug_mode:
        print("Processing child nodes...")

    for child in scene_root.get_children():
        var child_name: String = String(child.name)
        if debug_mode:
            print("Checking child node: " + child_name)

        # Skip if not using all items and this item is not in the list
        if use_specific_items and not (child_name in mesh_item_names):
            if debug_mode:
                print("Skipping node " + child_name + " (not in specified items list)")
            continue

        # Check if the child has a mesh
        var mesh_instance: MeshInstance3D = null
        if child is MeshInstance3D:
            mesh_instance = child
            if debug_mode:
                print("Node " + child_name + " is a MeshInstance3D")
        else:
            # Try to find a MeshInstance3D in the child's descendants
            if debug_mode:
                print("Searching for MeshInstance3D in descendants of " + child_name)
            for descendant in child.get_children():
                if descendant is MeshInstance3D:
                    mesh_instance = descendant
                    if debug_mode:
                        print("Found MeshInstance3D in descendant: " + String(descendant.name))
                    break

        if mesh_instance and mesh_instance.mesh:
            if debug_mode:
                print("Adding mesh: " + child_name)

            # Add the mesh to the library
            mesh_library.create_item(item_id)
            mesh_library.set_item_name(item_id, child_name)
            mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
            if debug_mode:
                print("Added mesh to library with ID: " + str(item_id))

            # Add collision shape if available
            var collision_added: bool = false
            for collision_child in child.get_children():
                if collision_child is CollisionShape3D and (collision_child as CollisionShape3D).shape:
                    mesh_library.set_item_shapes(item_id, [(collision_child as CollisionShape3D).shape])
                    if debug_mode:
                        print("Added collision shape from: " + String(collision_child.name))
                    collision_added = true
                    break

            if debug_mode and not collision_added:
                print("No collision shape found for mesh: " + child_name)

            item_id += 1
        elif debug_mode:
            print("Node " + child_name + " has no valid mesh")

    if debug_mode:
        print("Processed " + str(item_id) + " meshes")

    # Create directory if it doesn't exist
    var dir := DirAccess.open("res://")
    if dir == null:
        return _fail("Failed to open res:// directory", PackedStringArray([
            "DirAccess error: " + str(DirAccess.get_open_error()),
        ]))

    var output_dir: String = full_output_path.get_base_dir()
    if debug_mode:
        print("Output directory: " + output_dir)

    if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):  # Remove "res://" prefix
        if debug_mode:
            print("Creating directory: " + output_dir)
        var error: Error = dir.make_dir_recursive(output_dir.substr(6))  # Remove "res://" prefix
        if error != OK:
            return _fail("Failed to create directory: " + output_dir + ", error: " + str(error))

    # Save the mesh library
    if item_id > 0:
        if debug_mode:
            print("Saving MeshLibrary to: " + full_output_path)
        var error: Error = ResourceSaver.save(mesh_library, full_output_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")

        if error == OK:
            # Verify the file was actually created
            if debug_mode:
                var file_check_after: bool = FileAccess.file_exists(full_output_path)
                print("File exists check after save: " + str(file_check_after))

                if file_check_after:
                    print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + full_output_path)
                    # Get the absolute path for reference
                    var absolute_path: String = ProjectSettings.globalize_path(full_output_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    return _fail("File reported as saved but does not exist at: " + full_output_path)
            else:
                print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + full_output_path)
        else:
            return _fail("Failed to save MeshLibrary: " + str(error))
    else:
        return _fail("No valid meshes found in the scene")

    return _ok()

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

    # Ensure the file path starts with res:// for Godot's resource system
    var file_path: String = _param_string(params, "file_path")
    if not file_path.begins_with("res://"):
        file_path = "res://" + file_path

    print("Getting UID for file: " + file_path)
    if debug_mode:
        print("Full file path (with res://): " + file_path)

    # Get the absolute path for reference
    var absolute_path: String = ProjectSettings.globalize_path(file_path)
    if debug_mode:
        print("Absolute file path: " + absolute_path)

    # Ensure the file exists
    var file_check: bool = FileAccess.file_exists(file_path)
    if debug_mode:
        print("File exists check: " + str(file_check))

    if not file_check:
        return _fail("File does not exist at: " + file_path, PackedStringArray([
            "Absolute file path that doesn't exist: " + absolute_path,
        ]))

    # Check if the UID file exists
    var uid_path: String = file_path + ".uid"
    if debug_mode:
        print("UID file path: " + uid_path)

    var uid_check: bool = FileAccess.file_exists(uid_path)
    if debug_mode:
        print("UID file exists check: " + str(uid_check))

    var f := FileAccess.open(uid_path, FileAccess.READ)

    if f:
        # Read the UID content
        var uid_content: String = f.get_as_text()
        f.close()
        if debug_mode:
            print("UID content read successfully")

        # Return the UID content
        var result: Dictionary = {
            "file": file_path,
            "absolutePath": absolute_path,
            "uid": uid_content.strip_edges(),
            "exists": true
        }
        if debug_mode:
            print("UID result: " + JSON.stringify(result))
        print(JSON.stringify(result))
        return _ok()
    else:
        if debug_mode:
            print("UID file does not exist or could not be opened")

        # UID file doesn't exist
        var result: Dictionary = {
            "file": file_path,
            "absolutePath": absolute_path,
            "exists": false,
            "message": "UID file does not exist for this file. Use resave_resources to generate UIDs."
        }
        if debug_mode:
            print("UID result: " + JSON.stringify(result))
        print(JSON.stringify(result))
        return _ok()

# Resave all resources to update UID references
func resave_resources(params: Dictionary) -> OperationResult:
    print("Resaving all resources to update UID references...")

    # Get project path if provided
    var project_path: String = "res://"
    if params.has("project_path"):
        project_path = _param_string(params, "project_path")
        if not project_path.begins_with("res://"):
            project_path = "res://" + project_path
        if not project_path.ends_with("/"):
            project_path += "/"

    if debug_mode:
        print("Using project path: " + project_path)

    # Get all .tscn files
    if debug_mode:
        print("Searching for scene files in: " + project_path)
    var scenes := find_files(project_path, ".tscn")
    if debug_mode:
        print("Found " + str(scenes.size()) + " scenes")

    # Resave each scene. Per-file problems accumulate here instead of being
    # printed and quit on, so the entry point reports them together.
    var success_count: int = 0
    var errors: Array[String] = []

    for scene_path in scenes:
        if debug_mode:
            print("Processing scene: " + scene_path)

        # Check if the scene file exists
        var file_check: bool = FileAccess.file_exists(scene_path)
        if debug_mode:
            print("Scene file exists check: " + str(file_check))

        if not file_check:
            errors.append("Scene file does not exist at: " + scene_path)
            continue

        # Load the scene
        var scene := load(scene_path) as Resource
        if scene:
            if debug_mode:
                print("Scene loaded successfully, saving...")
            var error: Error = ResourceSaver.save(scene, scene_path)
            if debug_mode:
                print("Save result: " + str(error) + " (OK=" + str(OK) + ")")

            if error == OK:
                success_count += 1
                if debug_mode:
                    print("Scene saved successfully: " + scene_path)

                    # Verify the file was actually updated
                    var file_check_after: bool = FileAccess.file_exists(scene_path)
                    print("File exists check after save: " + str(file_check_after))

                    if not file_check_after:
                        errors.append("File reported as saved but does not exist at: " + scene_path)
            else:
                errors.append("Failed to save: " + scene_path + ", error: " + str(error))
        else:
            errors.append("Failed to load: " + scene_path)

    # Get all .gd and .shader files
    if debug_mode:
        print("Searching for script and shader files in: " + project_path)
    var scripts := find_files(project_path, ".gd") + find_files(project_path, ".shader") + find_files(project_path, ".gdshader")
    if debug_mode:
        print("Found " + str(scripts.size()) + " scripts/shaders")

    # Check for missing .uid files
    var missing_uids: int = 0
    var generated_uids: int = 0

    for script_path in scripts:
        if debug_mode:
            print("Checking UID for: " + script_path)
        var uid_path: String = script_path + ".uid"

        var uid_check: bool = FileAccess.file_exists(uid_path)
        if debug_mode:
            print("UID file exists check: " + str(uid_check))

        var f := FileAccess.open(uid_path, FileAccess.READ)
        if not f:
            missing_uids += 1
            if debug_mode:
                print("Missing UID file for: " + script_path + ", generating...")

            # Force a save to generate UID
            var res := load(script_path) as Resource
            if res:
                var error: Error = ResourceSaver.save(res, script_path)
                if debug_mode:
                    print("Save result: " + str(error) + " (OK=" + str(OK) + ")")

                if error == OK:
                    generated_uids += 1
                    if debug_mode:
                        print("Generated UID for: " + script_path)

                        # Verify the UID file was actually created
                        var uid_check_after: bool = FileAccess.file_exists(uid_path)
                        print("UID file exists check after save: " + str(uid_check_after))

                        if not uid_check_after:
                            errors.append("UID file reported as generated but does not exist at: " + uid_path)
                else:
                    errors.append("Failed to generate UID for: " + script_path + ", error: " + str(error))
            else:
                errors.append("Failed to load resource: " + script_path)
        elif debug_mode:
            print("UID file already exists for: " + script_path)

    if debug_mode:
        print("Summary:")
        print("- Scenes processed: " + str(scenes.size()))
        print("- Scenes successfully saved: " + str(success_count))
        print("- Scenes with errors: " + str(errors.size()))
        print("- Scripts/shaders missing UIDs: " + str(missing_uids))
        print("- UIDs successfully generated: " + str(generated_uids))
    print("Resave operation complete")

    if not errors.is_empty():
        return _failed(PackedStringArray(errors))
    return _ok()

# Save changes to a scene file
func save_scene(params: Dictionary) -> OperationResult:
    var scene_path: String = _param_string(params, "scene_path")
    print("Saving scene: " + scene_path)

    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path: String = scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)

    # Check if the scene file exists
    var file_check: bool = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))

    if not file_check:
        return _fail("Scene file does not exist at: " + full_scene_path, PackedStringArray([
            "Absolute file path that doesn't exist: " + ProjectSettings.globalize_path(full_scene_path),
        ]))

    # Load the scene
    var scene := load(full_scene_path) as PackedScene
    if not scene:
        return _fail("Failed to load scene: " + full_scene_path)

    if debug_mode:
        print("Scene loaded successfully")

    # Instance the scene
    var scene_root := scene.instantiate()
    if debug_mode:
        print("Scene instantiated")

    # Determine save path
    var has_new_path: bool = params.has("new_path")
    var save_path: String = _param_string(params, "new_path") if has_new_path else full_scene_path
    if has_new_path and not save_path.begins_with("res://"):
        save_path = "res://" + save_path

    if debug_mode:
        print("Save path: " + save_path)

    # Create directory if it doesn't exist
    if has_new_path:
        var dir := DirAccess.open("res://")
        if dir == null:
            return _fail("Failed to open res:// directory", PackedStringArray([
                "DirAccess error: " + str(DirAccess.get_open_error()),
            ]))

        var scene_dir: String = save_path.get_base_dir()
        if debug_mode:
            print("Scene directory: " + scene_dir)

        if scene_dir != "res://" and not dir.dir_exists(scene_dir.substr(6)):  # Remove "res://" prefix
            if debug_mode:
                print("Creating directory: " + scene_dir)
            var error: Error = dir.make_dir_recursive(scene_dir.substr(6))  # Remove "res://" prefix
            if error != OK:
                return _fail("Failed to create directory: " + scene_dir + ", error: " + str(error))

    # Create a packed scene
    var packed_scene := PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        if debug_mode:
            print("Saving scene to: " + save_path)
        var error: Error = ResourceSaver.save(packed_scene, save_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")

        if error == OK:
            # Verify the file was actually created/updated
            if debug_mode:
                var file_check_after: bool = FileAccess.file_exists(save_path)
                print("File exists check after save: " + str(file_check_after))

                if file_check_after:
                    print("Scene saved successfully to: " + save_path)
                    # Get the absolute path for reference
                    var absolute_path: String = ProjectSettings.globalize_path(save_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    return _fail("File reported as saved but does not exist at: " + save_path)
            else:
                print("Scene saved successfully to: " + save_path)
        else:
            return _fail("Failed to save scene: " + str(error))
    else:
        return _fail("Failed to pack scene (save_scene): " + str(result))

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

    var full_scene_path: String = _param_string(params, "scene_path")
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

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

    # Clean up
    scene_root.queue_free()
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

    var full_scene_path: String = _param_string(params, "scene_path")
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    log_info("Modifying node in scene: " + full_scene_path)

    if not FileAccess.file_exists(full_scene_path):
        return _fail("Scene file does not exist at: " + full_scene_path)

    var scene := load(full_scene_path) as PackedScene
    if not scene:
        return _fail("Failed to load scene: " + full_scene_path)

    var scene_root := scene.instantiate()

    # Find the target node
    var requested_node_path: String = _param_string(params, "node_path")
    var node_path: String = requested_node_path
    var target: Node = scene_root
    if node_path != "root" and node_path != ".":
        if node_path.begins_with("root/"):
            node_path = node_path.substr(5)
        target = scene_root.get_node_or_null(node_path)

    if target == null:
        return _fail("Node not found: " + requested_node_path)

    # Set properties with type conversion
    var properties: Dictionary = _param_dictionary(params, "properties")
    for prop_name: String in properties:
        var raw_value: Variant = properties[prop_name]
        var converted_value: Variant = _convert_property_value(target, prop_name, raw_value)
        log_info("Setting " + prop_name + " = " + str(converted_value) + " (from " + str(raw_value) + ")")
        target.set(prop_name, converted_value)

    # Repack and save
    var packed_scene := PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if result != OK:
        return _fail("Failed to pack scene after modification: " + str(result))

    var save_error: Error = ResourceSaver.save(packed_scene, full_scene_path)
    if save_error != OK:
        return _fail("Failed to save modified scene: " + str(save_error))

    print("Node modified successfully in: " + full_scene_path)
    return _ok()

# Remove a node from a scene file
func remove_node(params: Dictionary) -> OperationResult:
    if not params.has("scene_path") or not params.has("node_path"):
        return _fail("scene_path and node_path are required")

    var full_scene_path: String = _param_string(params, "scene_path")
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    log_info("Removing node from scene: " + full_scene_path)

    if not FileAccess.file_exists(full_scene_path):
        return _fail("Scene file does not exist at: " + full_scene_path)

    var scene := load(full_scene_path) as PackedScene
    if not scene:
        return _fail("Failed to load scene: " + full_scene_path)

    var scene_root := scene.instantiate()

    # Find the target node
    var requested_node_path: String = _param_string(params, "node_path")
    var node_path: String = requested_node_path
    if node_path.begins_with("root/"):
        node_path = node_path.substr(5)

    var target := scene_root.get_node_or_null(node_path)
    if target == null:
        return _fail("Node not found: " + requested_node_path)

    if target == scene_root:
        return _fail("Cannot remove the root node of a scene")

    var removed_name: String = String(target.name)
    target.get_parent().remove_child(target)
    target.queue_free()

    # Repack and save
    var packed_scene := PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if result != OK:
        return _fail("Failed to pack scene after removal: " + str(result))

    var save_error: Error = ResourceSaver.save(packed_scene, full_scene_path)
    if save_error != OK:
        return _fail("Failed to save scene after removal: " + str(save_error))

    print("Node '" + removed_name + "' removed successfully from: " + full_scene_path)
    return _ok()

# Attach a script to a node in a scene file
func attach_script(params: Dictionary) -> OperationResult:
    if not params.has("scene_path") or not params.has("node_path") or not params.has("script_path"):
        return _fail("scene_path, node_path, and script_path are required")

    var full_scene_path: String = _param_string(params, "scene_path")
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    var full_script_path: String = _param_string(params, "script_path")
    if not full_script_path.begins_with("res://"):
        full_script_path = "res://" + full_script_path

    log_info("Attaching script " + full_script_path + " to node in scene: " + full_scene_path)

    if not FileAccess.file_exists(full_scene_path):
        return _fail("Scene file does not exist at: " + full_scene_path)

    if not FileAccess.file_exists(full_script_path):
        return _fail("Script file does not exist at: " + full_script_path)

    var scene := load(full_scene_path) as PackedScene
    if not scene:
        return _fail("Failed to load scene: " + full_scene_path)

    var scene_root := scene.instantiate()

    # Find the target node
    var requested_node_path: String = _param_string(params, "node_path")
    var node_path: String = requested_node_path
    var target: Node = scene_root
    if node_path != "root" and node_path != ".":
        if node_path.begins_with("root/"):
            node_path = node_path.substr(5)
        target = scene_root.get_node_or_null(node_path)

    if target == null:
        return _fail("Node not found: " + requested_node_path)

    # Load and attach the script
    var script := load(full_script_path) as Script
    if not script:
        return _fail("Failed to load script: " + full_script_path)

    target.set_script(script)

    # Repack and save
    var packed_scene := PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if result != OK:
        return _fail("Failed to pack scene after attaching script: " + str(result))

    var save_error: Error = ResourceSaver.save(packed_scene, full_scene_path)
    if save_error != OK:
        return _fail("Failed to save scene after attaching script: " + str(save_error))

    print("Script '" + full_script_path + "' attached successfully to node in: " + full_scene_path)
    return _ok()

# Create a resource file (.tres)
func create_resource(params: Dictionary) -> OperationResult:
    if not params.has("resource_type") or not params.has("resource_path"):
        return _fail("resource_type and resource_path are required")

    var resource_type: String = _param_string(params, "resource_type")
    var full_resource_path: String = _param_string(params, "resource_path")
    if not full_resource_path.begins_with("res://"):
        full_resource_path = "res://" + full_resource_path

    log_info("Creating resource of type " + resource_type + " at: " + full_resource_path)

    # Instantiate the resource
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

    # Set properties if provided
    if params.has("properties"):
        var properties: Dictionary = _param_dictionary(params, "properties")
        for prop_name: String in properties:
            var raw_value: Variant = properties[prop_name]
            var converted_value: Variant = _convert_property_value(resource, prop_name, raw_value)
            log_info("Setting " + prop_name + " = " + str(converted_value))
            resource.set(prop_name, converted_value)

    # Ensure directory exists
    var dir_path: String = full_resource_path.get_base_dir()
    var dir_relative: String = dir_path.substr(6)  # Remove "res://"
    if not dir_relative.is_empty():
        var dir := DirAccess.open("res://")
        if dir and not dir.dir_exists(dir_relative):
            var make_dir_error: Error = dir.make_dir_recursive(dir_relative)
            if make_dir_error != OK:
                return _fail("Failed to create directory: " + dir_path + ", error: " + str(make_dir_error))

    # Save the resource
    var save_error: Error = ResourceSaver.save(resource, full_resource_path)
    if save_error != OK:
        return _fail("Failed to save resource: " + str(save_error))

    print("Resource created successfully at: " + full_resource_path)
    return _ok()


func manage_resource(params: Dictionary) -> OperationResult:
    var resource_path: String = _param_string(params, "resource_path")
    var action: String = _param_string(params, "action", "read")
    var full_path: String = resource_path
    if not full_path.begins_with("res://"):
        full_path = "res://" + full_path

    if action == "read":
        if not ResourceLoader.exists(full_path):
            return _fail("Resource not found: " + full_path)
        var res := ResourceLoader.load(full_path)
        if res == null:
            return _fail("Failed to load resource: " + full_path)
        var props: Dictionary = {}
        for prop in res.get_property_list():
            var usage: int = prop.get("usage", 0)
            if usage & PROPERTY_USAGE_STORAGE:
                var prop_name: String = prop["name"]
                props[prop_name] = str(res.get(prop_name))
        print("RESOURCE_JSON_START")
        print(JSON.stringify({"type": res.get_class(), "path": full_path, "properties": props}))
        print("RESOURCE_JSON_END")
    elif action == "modify":
        if not ResourceLoader.exists(full_path):
            return _fail("Resource not found: " + full_path)
        var res := ResourceLoader.load(full_path)
        if res == null:
            return _fail("Failed to load resource: " + full_path)
        var properties: Dictionary = _param_dictionary(params, "properties")
        for prop_name: String in properties:
            var raw_value: Variant = properties[prop_name]
            var converted_value: Variant = _convert_property_value(res, prop_name, raw_value)
            res.set(prop_name, converted_value)
        var save_error: Error = ResourceSaver.save(res, full_path)
        if save_error != OK:
            return _fail("Failed to save resource: " + str(save_error))
        print("Resource modified: " + full_path)
    else:
        return _fail("Unknown manage_resource action: " + action, PackedStringArray([
            "Allowed actions: read, modify",
        ]))

    return _ok()


func manage_scene_signals(params: Dictionary) -> OperationResult:
    var scene_path: String = _param_string(params, "scene_path")
    var action: String = _param_string(params, "action", "list")
    var full_path: String = scene_path
    if not full_path.begins_with("res://"):
        full_path = "res://" + full_path

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
    var resource_path: String = _param_string(params, "resource_path")
    var action: String = _param_string(params, "action", "read")
    var full_path: String = resource_path
    if not full_path.begins_with("res://"):
        full_path = "res://" + full_path

    if action == "create":
        var theme := Theme.new()
        var properties: Dictionary = _param_dictionary(params, "properties")
        for key: String in properties:
            theme.set(key, properties[key])
        var dir_path: String = full_path.get_base_dir()
        var dir_relative: String = dir_path.substr(6)
        if not dir_relative.is_empty():
            var dir := DirAccess.open("res://")
            if dir and not dir.dir_exists(dir_relative):
                var make_dir_error: Error = dir.make_dir_recursive(dir_relative)
                if make_dir_error != OK:
                    return _fail("Failed to create directory: " + dir_path + ", error: " + str(make_dir_error))
        var save_error: Error = ResourceSaver.save(theme, full_path)
        if save_error != OK:
            return _fail("Failed to save theme: " + str(save_error))
        print("Theme created at: " + full_path)
    elif action == "read":
        if not ResourceLoader.exists(full_path):
            return _fail("Theme not found: " + full_path)
        var theme := ResourceLoader.load(full_path)
        if theme == null:
            return _fail("Failed to load theme: " + full_path)
        print("THEME_JSON_START")
        print(JSON.stringify({"type": theme.get_class(), "path": full_path}))
        print("THEME_JSON_END")
    elif action == "modify":
        if not ResourceLoader.exists(full_path):
            return _fail("Theme not found: " + full_path)
        var theme := ResourceLoader.load(full_path)
        if theme == null:
            return _fail("Failed to load theme: " + full_path)
        var properties: Dictionary = _param_dictionary(params, "properties")
        for key: String in properties:
            theme.set(key, properties[key])
        var save_error: Error = ResourceSaver.save(theme, full_path)
        if save_error != OK:
            return _fail("Failed to save theme: " + str(save_error))
        print("Theme modified: " + full_path)
    else:
        return _fail("Unknown manage_theme_resource action: " + action, PackedStringArray([
            "Allowed actions: create, read, modify",
        ]))

    return _ok()


func manage_scene_structure(params: Dictionary) -> OperationResult:
    var scene_path: String = _param_string(params, "scene_path")
    var action: String = _param_string(params, "action", "rename")
    var node_path_str: String = _param_string(params, "node_path")
    var full_path: String = scene_path
    if not full_path.begins_with("res://"):
        full_path = "res://" + full_path

    if not FileAccess.file_exists(full_path):
        return _fail("Scene not found: " + full_path)

    var scene := load(full_path) as PackedScene
    if scene == null:
        return _fail("Failed to load scene: " + full_path)

    var root := scene.instantiate()
    var target := _resolve_scene_node(root, node_path_str)
    if target == null:
        return _fail("Node not found: " + node_path_str)

    if action == "rename":
        var new_name: String = _param_string(params, "new_name")
        if new_name.is_empty():
            return _fail("new_name is required for rename")
        target.name = new_name
        print("Node renamed to '%s'" % target.name)
    elif action == "duplicate":
        if target == root:
            return _fail("Cannot duplicate the root node")
        var dup := target.duplicate()
        target.get_parent().add_child(dup, true)
        _set_owner_recursive(dup, root)
        print("Node duplicated: %s (as '%s')" % [node_path_str, dup.name])
    elif action == "move":
        var new_parent_path: String = _param_string(params, "new_parent_path")
        if new_parent_path.is_empty():
            return _fail("new_parent_path is required for move")
        if target == root:
            return _fail("Cannot move the root node")
        var new_parent := _resolve_scene_node(root, new_parent_path)
        if new_parent == null:
            return _fail("New parent not found: " + new_parent_path)
        if new_parent == target or _is_ancestor(target, new_parent):
            return _fail("Cannot move a node into itself or one of its descendants")
        target.get_parent().remove_child(target)
        new_parent.add_child(target, true)
        _set_owner_recursive(target, root)
        print("Node moved: %s -> parent %s (as '%s')" % [node_path_str, new_parent_path, target.name])
    else:
        return _fail("Unknown manage_scene_structure action: " + action, PackedStringArray([
            "Allowed actions: rename, duplicate, move",
        ]))

    var packed := PackedScene.new()
    var pack_result: Error = packed.pack(root)
    if pack_result != OK:
        return _fail("Failed to pack scene: " + str(pack_result))
    var save_error: Error = ResourceSaver.save(packed, full_path)
    if save_error != OK:
        return _fail("Failed to save scene: " + str(save_error))
    print("Scene structure saved: " + full_path)
    return _ok()


func _resolve_scene_node(root: Node, tool_path: String) -> Node:
    if tool_path == "" or tool_path == "root" or tool_path == ".":
        return root
    var p: String = tool_path
    if p.begins_with("root/"):
        p = p.substr(5)
    return root.get_node_or_null(p)


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
