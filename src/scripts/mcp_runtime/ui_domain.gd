extends "res://mcp_runtime/runtime_domain.gd"

# UI domain: theme overrides, Control focus/layout, text controls, popups,
# Tree/ItemList/OptionButton items, tabs, menus, and Range/ColorPicker values.

const ANCHOR_PRESETS: Dictionary = {
	"top_left": Control.PRESET_TOP_LEFT,
	"top_right": Control.PRESET_TOP_RIGHT,
	"bottom_left": Control.PRESET_BOTTOM_LEFT,
	"bottom_right": Control.PRESET_BOTTOM_RIGHT,
	"center_left": Control.PRESET_CENTER_LEFT,
	"center_top": Control.PRESET_CENTER_TOP,
	"center_right": Control.PRESET_CENTER_RIGHT,
	"center_bottom": Control.PRESET_CENTER_BOTTOM,
	"center": Control.PRESET_CENTER,
	"left_wide": Control.PRESET_LEFT_WIDE,
	"top_wide": Control.PRESET_TOP_WIDE,
	"right_wide": Control.PRESET_RIGHT_WIDE,
	"bottom_wide": Control.PRESET_BOTTOM_WIDE,
	"vcenter_wide": Control.PRESET_VCENTER_WIDE,
	"hcenter_wide": Control.PRESET_HCENTER_WIDE,
	"full_rect": Control.PRESET_FULL_RECT,
}


func register_commands() -> void:
	register_command("ui_theme", _cmd_ui_theme)
	register_command("ui_control", _cmd_ui_control)
	register_command("ui_text", _cmd_ui_text)
	register_command("ui_popup", _cmd_ui_popup)
	register_command("ui_tree", _cmd_ui_tree)
	register_command("ui_item_list", _cmd_ui_item_list)
	register_command("ui_tabs", _cmd_ui_tabs)
	register_command("ui_menu", _cmd_ui_menu)
	register_command("ui_range", _cmd_ui_range)


# Records a structured failure when the resolved node is not the class the
# command drives; the caller still routes through params_invalid().
func _require_class(reader: CommandParams, node: Node, type_name: String) -> void:
	if reader.failed() or node == null:
		return
	reader.fail("Node is not a %s: %s" % [type_name, node.get_class()],
		{"param": "node_path", "reason": "invalid_value", "expected": type_name, "value": node.get_class()})


func _color_from(value: Variant) -> Color:
	var source: Dictionary = CommandParams.as_dictionary(value)
	return Color(
		CommandParams.json_float(source, "r"),
		CommandParams.json_float(source, "g"),
		CommandParams.json_float(source, "b"),
		CommandParams.json_float(source, "a", 1.0),
	)


# --- Theme overrides ---
func _cmd_ui_theme(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var overrides: Dictionary = reader.optional_dictionary("overrides")
	if node != null and not node is Control:
		_require_class(reader, node, "Control")
	if params_invalid(reader):
		return

	var ctrl: Control = node as Control
	var applied: Array = []

	var colors: Dictionary = CommandParams.json_dictionary(overrides, "colors")
	for color_name: Variant in colors:
		var override: StringName = StringName(str(color_name))
		ctrl.add_theme_color_override(override, _color_from(colors[color_name]))
		applied.append("color:" + str(color_name))

	var constants: Dictionary = CommandParams.json_dictionary(overrides, "constants")
	for constant_name: Variant in constants:
		var override: StringName = StringName(str(constant_name))
		ctrl.add_theme_constant_override(override, CommandParams.to_int(constants[constant_name]))
		applied.append("constant:" + str(constant_name))

	var font_sizes: Dictionary = CommandParams.as_dictionary(overrides.get("fontSizes", overrides.get("font_sizes", {})))
	for font_name: Variant in font_sizes:
		var override: StringName = StringName(str(font_name))
		ctrl.add_theme_font_size_override(override, CommandParams.to_int(font_sizes[font_name]))
		applied.append("font_size:" + str(font_name))

	respond({"success": true, "node_path": str(params.get("node_path", "")), "applied": applied})


# --- Control focus and layout ---
func _cmd_ui_control(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get_info", ["grab_focus", "release_focus", "configure", "get_info"])
	if node != null and not node is Control:
		_require_class(reader, node, "Control")
	if params_invalid(reader):
		return

	var ctrl: Control = node as Control
	match action:
		"grab_focus":
			ctrl.grab_focus()
			respond({"success": true, "action": "grab_focus"})
		"release_focus":
			ctrl.release_focus()
			respond({"success": true, "action": "release_focus"})
		"configure":
			var applied: Array = []
			if reader.has_param("tooltip"):
				ctrl.tooltip_text = str(reader.raw("tooltip"))
				applied.append("tooltip")
			if reader.has_param("mouse_filter"):
				var mouse_filter: String = reader.required_enum("mouse_filter", ["stop", "pass", "ignore"])
				if params_invalid(reader):
					return
				match mouse_filter:
					"stop": ctrl.mouse_filter = Control.MOUSE_FILTER_STOP
					"pass": ctrl.mouse_filter = Control.MOUSE_FILTER_PASS
					"ignore": ctrl.mouse_filter = Control.MOUSE_FILTER_IGNORE
				applied.append("mouse_filter")
			if reader.has_param("min_size"):
				var min_size: Dictionary = reader.required_dictionary("min_size")
				if params_invalid(reader):
					return
				ctrl.custom_minimum_size = Vector2(CommandParams.json_float(min_size, "x", 0), CommandParams.json_float(min_size, "y", 0))
				applied.append("min_size")
			if reader.has_param("anchor_preset"):
				var preset: int = _resolve_anchor_preset(reader.raw("anchor_preset"))
				if preset < 0:
					reader.fail("Invalid anchor_preset: %s" % str(reader.raw("anchor_preset")),
						{"param": "anchor_preset", "reason": "invalid_value", "allowed": ANCHOR_PRESETS.keys(), "value": str(reader.raw("anchor_preset"))})
				if params_invalid(reader):
					return
				ctrl.set_anchors_and_offsets_preset(preset as Control.LayoutPreset)
				applied.append("anchor_preset")
			respond({"success": true, "action": "configure", "applied": applied})
		"get_info":
			respond({"success": true, "size": variant_to_json(ctrl.size), "position": variant_to_json(ctrl.position), "has_focus": ctrl.has_focus(), "visible": ctrl.visible, "tooltip": ctrl.tooltip_text, "mouse_filter": ctrl.mouse_filter})


func _resolve_anchor_preset(value: Variant) -> int:
	if value is int or value is float:
		return CommandParams.to_int(value)
	if value is String:
		var text: String = value
		var key: String = text.to_lower()
		if ANCHOR_PRESETS.has(key):
			return ANCHOR_PRESETS[key]
	return -1


# --- Text controls ---
func _cmd_ui_text(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get", ["get", "set", "append", "clear", "bbcode"])
	if params_invalid(reader):
		return

	if action == "bbcode":
		var bbcode: String = reader.required_string("text")
		if not node is RichTextLabel:
			_require_class(reader, node, "RichTextLabel")
		if params_invalid(reader):
			return
		var rtl: RichTextLabel = node as RichTextLabel
		rtl.bbcode_enabled = true
		rtl.text = bbcode
		respond({"success": true, "action": "bbcode"})
		return

	if not (node is LineEdit or node is TextEdit or node is RichTextLabel):
		_require_class(reader, node, "text control (LineEdit/TextEdit/RichTextLabel)")
		send_params_error(reader)
		return

	match action:
		"get":
			var text: String = ""
			if node is LineEdit: text = (node as LineEdit).text
			elif node is TextEdit: text = (node as TextEdit).text
			elif node is RichTextLabel: text = (node as RichTextLabel).text
			respond({"success": true, "text": text})
		"set":
			var text: String = reader.required_string("text")
			if params_invalid(reader):
				return
			if node is LineEdit: (node as LineEdit).text = text
			elif node is TextEdit: (node as TextEdit).text = text
			elif node is RichTextLabel: (node as RichTextLabel).text = text
			_apply_text_selection(reader, node)
			if params_invalid(reader):
				return
			respond({"success": true, "action": "set"})
		"append":
			var text: String = reader.required_string("text")
			if params_invalid(reader):
				return
			if node is TextEdit: (node as TextEdit).text += text
			elif node is RichTextLabel: (node as RichTextLabel).append_text(text)
			elif node is LineEdit: (node as LineEdit).text += text
			_apply_text_selection(reader, node)
			if params_invalid(reader):
				return
			respond({"success": true, "action": "append"})
		"clear":
			if node is LineEdit: (node as LineEdit).text = ""
			elif node is TextEdit: (node as TextEdit).text = ""
			elif node is RichTextLabel:
				(node as RichTextLabel).clear()
				(node as RichTextLabel).text = ""
			respond({"success": true, "action": "clear"})


func _apply_text_selection(reader: CommandParams, node: Node) -> void:
	var has_from: bool = reader.has_param("selection_from")
	var has_to: bool = reader.has_param("selection_to")
	if has_from != has_to:
		reader.fail("selection_from and selection_to must be provided together",
			{"param": "selection_from", "reason": "missing_pair"})
		return
	var caret: int = reader.optional_int("caret_position", -1, -1)
	var selection_from: int = reader.optional_int("selection_from", 0, 0)
	var selection_to: int = reader.optional_int("selection_to", 0, 0)
	if reader.failed():
		return
	if node is LineEdit:
		var line: LineEdit = node as LineEdit
		if caret >= 0:
			line.caret_column = mini(caret, line.text.length())
		if has_from:
			line.select(mini(selection_from, line.text.length()), mini(selection_to, line.text.length()))
	elif node is TextEdit:
		var edit: TextEdit = node as TextEdit
		if caret >= 0:
			edit.set_caret_column(caret)
		if has_from:
			edit.select(0, selection_from, 0, selection_to)
	elif caret >= 0 or has_from:
		reader.fail("caret and selection parameters require LineEdit or TextEdit",
			{"param": "caret_position", "reason": "invalid_value", "expected": "LineEdit or TextEdit"})


# --- Popups and windows ---
func _cmd_ui_popup(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "popup_centered", ["popup_centered", "popup", "hide", "get_info"])
	if node != null and not node is Window:
		_require_class(reader, node, "Window")
	if params_invalid(reader):
		return

	var win: Window = node as Window
	if reader.has_param("title"):
		win.title = reader.required_string("title")
	if reader.has_param("text"):
		if win is AcceptDialog:
			(win as AcceptDialog).dialog_text = reader.required_string("text")
		else:
			reader.fail("text requires an AcceptDialog", {"param": "text", "reason": "invalid_value", "expected": "AcceptDialog"})
	if params_invalid(reader):
		return
	match action:
		"popup_centered":
			if reader.has_param("size"):
				var size: Dictionary = reader.required_dictionary("size")
				if params_invalid(reader):
					return
				var requested_size := Vector2i(CommandParams.json_int(size, "x", 200), CommandParams.json_int(size, "y", 100))
				win.popup_centered(requested_size)
				# Embedded headless windows clamp during centering; explicit sizing is authoritative.
				win.size = requested_size
			else:
				win.popup_centered()
			respond({"success": true, "action": "popup_centered"})
		"popup":
			win.popup()
			respond({"success": true, "action": "popup"})
		"hide":
			win.hide()
			respond({"success": true, "action": "hide"})
		"get_info":
			respond({"success": true, "visible": win.visible, "title": win.title, "size": variant_to_json(win.size)})


# --- Tree items ---
func _cmd_ui_tree(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get_items", ["get_items", "add", "select", "collapse", "expand", "remove"])
	if node != null and not node is Tree:
		_require_class(reader, node, "Tree")
	if params_invalid(reader):
		return

	var tree_node: Tree = node as Tree
	match action:
		"get_items":
			var items: Array = []
			var tree_root: TreeItem = tree_node.get_root()
			if tree_root != null:
				_collect_tree_items(tree_root, items, 0, "")
			respond({"success": true, "action": "get_items", "items": items})
		"add":
			var text: String = reader.required_string("text")
			var column: int = reader.optional_int("column", 0, 0)
			var tree_root: TreeItem = tree_node.get_root()
			if tree_root == null:
				tree_root = tree_node.create_item()
			if column >= tree_node.columns:
				reader.fail("column is out of bounds", {"param": "column", "reason": "out_of_range", "max": tree_node.columns - 1, "value": column})
			var parent: TreeItem = _tree_item_at_path(reader, tree_node, reader.optional_string("item_path", ""), true)
			if params_invalid(reader):
				return
			var item: TreeItem = tree_node.create_item(parent)
			item.set_text(column, text)
			respond({"success": true, "action": "add", "text": text})
		"select", "collapse", "expand", "remove":
			var item_path: String = reader.required_string("item_path")
			var item: TreeItem = _tree_item_at_path(reader, tree_node, item_path, false)
			var column: int = reader.optional_int("column", 0, 0)
			if column >= tree_node.columns:
				reader.fail("column is out of bounds", {"param": "column", "reason": "out_of_range", "max": tree_node.columns - 1, "value": column})
			if params_invalid(reader):
				return
			match action:
				"select": tree_node.set_selected(item, column)
				"collapse": item.collapsed = true
				"expand": item.collapsed = false
				"remove": item.free()
			respond({"success": true, "action": action, "item_path": item_path})


func _collect_tree_items(item: TreeItem, result: Array, depth: int, item_path: String) -> void:
	var columns: Array = []
	for column in item.get_tree().columns:
		columns.append(item.get_text(column))
	result.append({"path": item_path, "text": item.get_text(0), "columns": columns, "depth": depth, "collapsed": item.collapsed, "selected": item.is_selected(0)})
	var child: TreeItem = item.get_first_child()
	var child_index: int = 0
	while child != null:
		var child_path: String = str(child_index) if item_path.is_empty() else "%s/%d" % [item_path, child_index]
		_collect_tree_items(child, result, depth + 1, child_path)
		child = child.get_next()
		child_index += 1


func _tree_item_at_path(reader: CommandParams, tree_node: Tree, item_path: String, allow_root: bool) -> TreeItem:
	var item: TreeItem = tree_node.get_root()
	if item == null:
		reader.fail("Tree has no root item", {"param": "item_path", "reason": "not_found"})
		return null
	if item_path.is_empty():
		if allow_root:
			return item
		reader.fail("item_path must identify a non-root item", {"param": "item_path", "reason": "invalid_value"})
		return null
	for segment: String in item_path.split("/"):
		if not segment.is_valid_int() or segment.to_int() < 0:
			reader.fail("item_path must contain non-negative child indices", {"param": "item_path", "reason": "invalid_value", "value": item_path})
			return null
		var child_index: int = segment.to_int()
		item = item.get_child(child_index)
		if item == null:
			reader.fail("Tree item not found: %s" % item_path, {"param": "item_path", "reason": "not_found", "value": item_path})
			return null
	return item


# --- ItemList / OptionButton items ---
func _cmd_ui_item_list(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	if params_invalid(reader):
		return

	if node is ItemList:
		var item_list: ItemList = node as ItemList
		var action: String = reader.optional_enum("action", "get_items", ["get_items", "select", "add", "remove", "clear"])
		if params_invalid(reader):
			return
		match action:
			"get_items":
				var items: Array = []
				for i in item_list.item_count:
					items.append({"index": i, "text": item_list.get_item_text(i), "selected": item_list.is_selected(i)})
				respond({"success": true, "items": items})
			"select":
				var index: int = reader.required_int("index", 0)
				if index >= item_list.item_count:
					reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": item_list.item_count - 1, "value": index})
				if params_invalid(reader):
					return
				item_list.select(index)
				respond({"success": true, "action": "select"})
			"add":
				@warning_ignore("return_value_discarded")
				item_list.add_item(reader.required_string("text"))
				if params_invalid(reader):
					return
				respond({"success": true, "action": "add"})
			"remove":
				var index: int = reader.required_int("index", 0)
				if index >= item_list.item_count:
					reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": item_list.item_count - 1, "value": index})
				if params_invalid(reader):
					return
				item_list.remove_item(index)
				respond({"success": true, "action": "remove"})
			"clear":
				item_list.clear()
				respond({"success": true, "action": "clear"})
	elif node is OptionButton:
		var option_button: OptionButton = node as OptionButton
		var action: String = reader.optional_enum("action", "get_items", ["get_items", "select", "add", "remove", "clear"])
		if params_invalid(reader):
			return
		match action:
			"get_items":
				var items: Array = []
				for i in option_button.item_count:
					items.append({"index": i, "text": option_button.get_item_text(i)})
				respond({"success": true, "items": items, "selected": option_button.selected})
			"select":
				var index: int = reader.required_int("index", 0)
				if index >= option_button.item_count:
					reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": option_button.item_count - 1, "value": index})
				if params_invalid(reader):
					return
				option_button.select(index)
				respond({"success": true, "action": "select"})
			"add":
				option_button.add_item(reader.required_string("text"))
				if params_invalid(reader):
					return
				respond({"success": true, "action": "add"})
			"remove":
				var index: int = reader.required_int("index", 0)
				if index >= option_button.item_count:
					reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": option_button.item_count - 1, "value": index})
				if params_invalid(reader):
					return
				option_button.remove_item(index)
				respond({"success": true, "action": "remove"})
			"clear":
				option_button.clear()
				respond({"success": true, "action": "clear"})
	else:
		_require_class(reader, node, "ItemList or OptionButton")
		send_params_error(reader)


# --- Tabs ---
func _cmd_ui_tabs(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	if params_invalid(reader):
		return

	if node is TabContainer:
		var tab_container: TabContainer = node as TabContainer
		var action: String = reader.optional_enum("action", "get_tabs", ["get_tabs", "set_current", "set_title"])
		if params_invalid(reader):
			return
		match action:
			"get_tabs":
				var tabs: Array = []
				for i in tab_container.get_tab_count():
					tabs.append({"index": i, "title": tab_container.get_tab_title(i)})
				respond({"success": true, "tabs": tabs, "current": tab_container.current_tab})
			"set_current":
				var index: int = reader.required_int("index", 0)
				if index >= tab_container.get_tab_count():
					reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": tab_container.get_tab_count() - 1, "value": index})
				if params_invalid(reader):
					return
				tab_container.current_tab = index
				respond({"success": true, "action": "set_current"})
			"set_title":
				var index: int = reader.required_int("index", 0)
				var title: String = reader.required_string("title")
				if index >= tab_container.get_tab_count():
					reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": tab_container.get_tab_count() - 1, "value": index})
				if params_invalid(reader):
					return
				tab_container.set_tab_title(index, title)
				respond({"success": true, "action": "set_title"})
	elif node is TabBar:
		var tab_bar: TabBar = node as TabBar
		var action: String = reader.optional_enum("action", "get_tabs", ["get_tabs", "set_current", "set_title"])
		if params_invalid(reader):
			return
		match action:
			"get_tabs":
				var tabs: Array = []
				for i in tab_bar.tab_count:
					tabs.append({"index": i, "title": tab_bar.get_tab_title(i)})
				respond({"success": true, "tabs": tabs, "current": tab_bar.current_tab})
			"set_current":
				var index: int = reader.required_int("index", 0)
				if index >= tab_bar.tab_count:
					reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": tab_bar.tab_count - 1, "value": index})
				if params_invalid(reader):
					return
				tab_bar.current_tab = index
				respond({"success": true, "action": "set_current"})
			"set_title":
				var index: int = reader.required_int("index", 0)
				var title: String = reader.required_string("title")
				if index >= tab_bar.tab_count:
					reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": tab_bar.tab_count - 1, "value": index})
				if params_invalid(reader):
					return
				tab_bar.set_tab_title(index, title)
				respond({"success": true, "action": "set_title"})
	else:
		_require_class(reader, node, "TabContainer or TabBar")
		send_params_error(reader)


# --- Popup menus ---
func _cmd_ui_menu(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get_items", ["get_items", "add", "remove", "set_checked", "clear"])
	if node != null and not node is PopupMenu:
		_require_class(reader, node, "PopupMenu")
	if params_invalid(reader):
		return

	var menu: PopupMenu = node as PopupMenu
	match action:
		"get_items":
			var items: Array = []
			for i in menu.item_count:
				var shortcut: Shortcut = menu.get_item_shortcut(i)
				items.append({"index": i, "text": menu.get_item_text(i), "checked": menu.is_item_checked(i), "disabled": menu.is_item_disabled(i), "id": menu.get_item_id(i), "shortcut": shortcut.get_as_text() if shortcut != null else ""})
			respond({"success": true, "items": items})
		"add":
			var text: String = reader.required_string("text")
			var id: int = reader.optional_int("id", -1)
			if params_invalid(reader):
				return
			menu.add_item(text, id)
			if reader.has_param("shortcut_key"):
				var shortcut_key: String = reader.required_string("shortcut_key")
				var keycode: Key = OS.find_keycode_from_string(shortcut_key)
				if keycode == KEY_NONE:
					reader.fail("Unknown shortcut key: %s" % shortcut_key, {"param": "shortcut_key", "reason": "invalid_value", "value": shortcut_key})
				if params_invalid(reader):
					menu.remove_item(menu.item_count - 1)
					return
				var event: InputEventKey = InputEventKey.new()
				event.keycode = keycode
				var shortcut: Shortcut = Shortcut.new()
				shortcut.events = [event]
				menu.set_item_shortcut(menu.item_count - 1, shortcut)
			respond({"success": true, "action": "add"})
		"remove":
			var index: int = reader.required_int("index", 0)
			if index >= menu.item_count:
				reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": menu.item_count - 1, "value": index})
			if params_invalid(reader):
				return
			menu.remove_item(index)
			respond({"success": true, "action": "remove"})
		"set_checked":
			var index: int = reader.required_int("index", 0)
			if index >= menu.item_count:
				reader.fail("index is out of bounds", {"param": "index", "reason": "out_of_range", "max": menu.item_count - 1, "value": index})
			if not reader.has_param("checked"):
				reader.fail("checked is required", {"param": "checked", "reason": "missing"})
			var checked: bool = reader.optional_bool("checked", false)
			if params_invalid(reader):
				return
			menu.set_item_checked(index, checked)
			respond({"success": true, "action": "set_checked"})
		"clear":
			menu.clear()
			respond({"success": true, "action": "clear"})


# --- Range / ColorPicker values ---
func _cmd_ui_range(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get", ["get", "set"])
	if params_invalid(reader):
		return

	if node is Range:
		var range_node: Range = node as Range
		if action == "get":
			respond({"success": true, "value": range_node.value, "min": range_node.min_value, "max": range_node.max_value, "step": range_node.step})
			return
		if reader.has_param("min_value"): range_node.min_value = reader.required_number("min_value")
		if reader.has_param("max_value"): range_node.max_value = reader.required_number("max_value")
		if reader.has_param("step"): range_node.step = reader.required_number("step")
		if reader.has_param("value"): range_node.value = reader.required_number("value")
		if params_invalid(reader):
			return
		respond({"success": true, "action": "set", "value": range_node.value})
	elif node is ColorPicker:
		var picker: ColorPicker = node as ColorPicker
		if action == "get":
			var c: Color = picker.color
			respond({"success": true, "color": {"r": c.r, "g": c.g, "b": c.b, "a": c.a}})
			return
		var color: Dictionary = reader.required_dictionary("color")
		if params_invalid(reader):
			return
		picker.color = _color_from(color)
		respond({"success": true, "action": "set"})
	else:
		_require_class(reader, node, "Range or ColorPicker")
		send_params_error(reader)
