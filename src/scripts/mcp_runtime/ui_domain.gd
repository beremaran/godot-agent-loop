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


func _color_from(value: Dictionary) -> Color:
	return Color(float(value.get("r", 0)), float(value.get("g", 0)), float(value.get("b", 0)), float(value.get("a", 1)))


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

	var colors: Dictionary = overrides.get("colors", {})
	for name in colors:
		ctrl.add_theme_color_override(name, _color_from(colors[name]))
		applied.append("color:" + name)

	var constants: Dictionary = overrides.get("constants", {})
	for name in constants:
		ctrl.add_theme_constant_override(name, int(constants[name]))
		applied.append("constant:" + name)

	var font_sizes: Dictionary = overrides.get("fontSizes", overrides.get("font_sizes", {}))
	for name in font_sizes:
		ctrl.add_theme_font_size_override(name, int(font_sizes[name]))
		applied.append("font_size:" + name)

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
				ctrl.custom_minimum_size = Vector2(float(min_size.get("x", 0)), float(min_size.get("y", 0)))
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
		return int(value)
	if value is String:
		var key: String = (value as String).to_lower()
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
		if not node is RichTextLabel:
			_require_class(reader, node, "RichTextLabel")
			params_invalid(reader)
			return
		var rtl: RichTextLabel = node as RichTextLabel
		rtl.bbcode_enabled = true
		rtl.text = str(params.get("text", ""))
		respond({"success": true, "action": "bbcode"})
		return

	if not (node is LineEdit or node is TextEdit or node is RichTextLabel):
		_require_class(reader, node, "text control (LineEdit/TextEdit/RichTextLabel)")
		params_invalid(reader)
		return

	match action:
		"get":
			var text: String = ""
			if node is LineEdit: text = (node as LineEdit).text
			elif node is TextEdit: text = (node as TextEdit).text
			elif node is RichTextLabel: text = (node as RichTextLabel).text
			respond({"success": true, "text": text})
		"set":
			var text: String = str(params.get("text", ""))
			if node is LineEdit: (node as LineEdit).text = text
			elif node is TextEdit: (node as TextEdit).text = text
			elif node is RichTextLabel: (node as RichTextLabel).text = text
			respond({"success": true, "action": "set"})
		"append":
			var text: String = str(params.get("text", ""))
			if node is TextEdit: (node as TextEdit).text += text
			elif node is RichTextLabel: (node as RichTextLabel).append_text(text)
			elif node is LineEdit: (node as LineEdit).text += text
			respond({"success": true, "action": "append"})
		"clear":
			if node is LineEdit: (node as LineEdit).text = ""
			elif node is TextEdit: (node as TextEdit).text = ""
			elif node is RichTextLabel: (node as RichTextLabel).clear()
			respond({"success": true, "action": "clear"})


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
	match action:
		"popup_centered":
			if reader.has_param("size"):
				var size: Dictionary = reader.required_dictionary("size")
				if params_invalid(reader):
					return
				win.popup_centered(Vector2i(int(size.get("x", 200)), int(size.get("y", 100))))
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
	var action: String = reader.optional_enum("action", "get_items", ["get_items", "add"])
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
				_collect_tree_items(tree_root, items, 0)
			respond({"success": true, "action": "get_items", "items": items})
		"add":
			var text: String = reader.optional_string("text", "Item")
			var column: int = reader.optional_int("column", 0, 0)
			if params_invalid(reader):
				return
			var tree_root: TreeItem = tree_node.get_root()
			if tree_root == null:
				tree_root = tree_node.create_item()
			var item: TreeItem = tree_node.create_item(tree_root)
			item.set_text(column, text)
			respond({"success": true, "action": "add", "text": text})


func _collect_tree_items(item: TreeItem, result: Array, depth: int) -> void:
	var col: int = 0
	result.append({"text": item.get_text(col), "depth": depth, "collapsed": item.collapsed})
	var child: TreeItem = item.get_first_child()
	while child != null:
		_collect_tree_items(child, result, depth + 1)
		child = child.get_next()


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
				item_list.select(reader.optional_int("index", 0, 0))
				if params_invalid(reader):
					return
				respond({"success": true, "action": "select"})
			"add":
				item_list.add_item(reader.optional_string("text", "Item"))
				if params_invalid(reader):
					return
				respond({"success": true, "action": "add"})
			"remove":
				item_list.remove_item(reader.optional_int("index", 0, 0))
				if params_invalid(reader):
					return
				respond({"success": true, "action": "remove"})
			"clear":
				item_list.clear()
				respond({"success": true, "action": "clear"})
	elif node is OptionButton:
		var option_button: OptionButton = node as OptionButton
		var action: String = reader.optional_enum("action", "get_items", ["get_items", "select", "add"])
		if params_invalid(reader):
			return
		match action:
			"get_items":
				var items: Array = []
				for i in option_button.item_count:
					items.append({"index": i, "text": option_button.get_item_text(i)})
				respond({"success": true, "items": items, "selected": option_button.selected})
			"select":
				option_button.select(reader.optional_int("index", 0, 0))
				if params_invalid(reader):
					return
				respond({"success": true, "action": "select"})
			"add":
				option_button.add_item(reader.optional_string("text", "Item"))
				if params_invalid(reader):
					return
				respond({"success": true, "action": "add"})
	else:
		_require_class(reader, node, "ItemList or OptionButton")
		params_invalid(reader)


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
				tab_container.current_tab = reader.optional_int("index", 0, 0)
				if params_invalid(reader):
					return
				respond({"success": true, "action": "set_current"})
			"set_title":
				tab_container.set_tab_title(reader.optional_int("index", 0, 0), reader.optional_string("title", ""))
				if params_invalid(reader):
					return
				respond({"success": true, "action": "set_title"})
	elif node is TabBar:
		var tab_bar: TabBar = node as TabBar
		var action: String = reader.optional_enum("action", "get_tabs", ["get_tabs", "set_current"])
		if params_invalid(reader):
			return
		match action:
			"get_tabs":
				var tabs: Array = []
				for i in tab_bar.tab_count:
					tabs.append({"index": i, "title": tab_bar.get_tab_title(i)})
				respond({"success": true, "tabs": tabs, "current": tab_bar.current_tab})
			"set_current":
				tab_bar.current_tab = reader.optional_int("index", 0, 0)
				if params_invalid(reader):
					return
				respond({"success": true, "action": "set_current"})
	else:
		_require_class(reader, node, "TabContainer or TabBar")
		params_invalid(reader)


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
				items.append({"index": i, "text": menu.get_item_text(i), "checked": menu.is_item_checked(i), "disabled": menu.is_item_disabled(i), "id": menu.get_item_id(i)})
			respond({"success": true, "items": items})
		"add":
			var text: String = reader.optional_string("text", "Item")
			var id: int = reader.optional_int("id", -1)
			if params_invalid(reader):
				return
			menu.add_item(text, id)
			respond({"success": true, "action": "add"})
		"remove":
			menu.remove_item(reader.optional_int("index", 0, 0))
			if params_invalid(reader):
				return
			respond({"success": true, "action": "remove"})
		"set_checked":
			menu.set_item_checked(reader.optional_int("index", 0, 0), reader.optional_bool("checked", true))
			if params_invalid(reader):
				return
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
		if reader.has_param("value"): range_node.value = reader.required_number("value")
		if reader.has_param("min_value"): range_node.min_value = reader.required_number("min_value")
		if reader.has_param("max_value"): range_node.max_value = reader.required_number("max_value")
		if reader.has_param("step"): range_node.step = reader.required_number("step")
		if params_invalid(reader):
			return
		respond({"success": true, "action": "set", "value": range_node.value})
	elif node is ColorPicker:
		var picker: ColorPicker = node as ColorPicker
		if action == "get":
			var c: Color = picker.color
			respond({"success": true, "color": {"r": c.r, "g": c.g, "b": c.b, "a": c.a}})
			return
		if reader.has_param("color"):
			var color: Dictionary = reader.required_dictionary("color")
			if params_invalid(reader):
				return
			picker.color = _color_from(color)
		respond({"success": true, "action": "set"})
	else:
		_require_class(reader, node, "Range or ColorPicker")
		params_invalid(reader)
