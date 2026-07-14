extends SceneTree

## Canonicalizes project.godot with the exact engine under acceptance so addon
## cleanup comparisons do not confuse engine-version migration with residue.


func _initialize() -> void:
	var save_error: Error = ProjectSettings.save()
	if save_error != OK:
		push_error("Could not normalize project settings: %s" % error_string(save_error))
	quit(save_error)
