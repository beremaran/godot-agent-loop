extends Node2D

const TICK_INTERVAL := 0.15
const WIN_SCORE := 3
const GRID_COLS := 20
const GRID_ROWS := 15

enum GameState { PLAYING, WON, GAME_OVER }

var state: GameState = GameState.PLAYING
var score: int = 0
var time_accum: float = 0.0

var grid_node: Node2D
var snake_node: Node2D
var food_node: Node2D

var ui_score: Label
var ui_game_over: PanelContainer
var ui_game_over_label: Label
var ui_win: PanelContainer
var ui_win_label: Label

var initial_snake_positions: Array[Vector2i] = [
	Vector2i(10, 7),
	Vector2i(9, 7),
	Vector2i(8, 7),
]


func _ready() -> void:
	grid_node = $Grid
	snake_node = $Grid/Snake
	food_node = $Grid/Food

	ui_score = $UI/score_label as Label
	ui_game_over = $UI/game_over_panel as PanelContainer
	ui_win = $UI/win_panel as PanelContainer

	ui_game_over_label = ui_game_over.get_node("game_over_label") as Label
	ui_win_label = ui_win.get_node("win_label") as Label

	_setup_ui()
	reset_game()


func _setup_ui() -> void:
	ui_score.position = Vector2(10, 10)
	ui_score.add_theme_font_size_override("font_size", 24)
	ui_score.add_theme_color_override("font_color", Color.WHITE)

	ui_game_over.visible = false
	ui_game_over.position = Vector2(160, 160)
	ui_game_over.add_theme_background_color_override("panel_color", Color(0, 0, 0, 0.7))
	ui_game_over_label.text = "GAME OVER"
	ui_game_over_label.add_theme_font_size_override("font_size", 48)
	ui_game_over_label.add_theme_color_override("font_color", Color(1, 0.2, 0.2))

	ui_win.visible = false
	ui_win.position = Vector2(160, 160)
	ui_win.add_theme_background_color_override("panel_color", Color(0, 0, 0, 0.7))
	ui_win_label.text = "YOU WIN!"
	ui_win_label.add_theme_font_size_override("font_size", 48)
	ui_win_label.add_theme_color_override("font_color", Color(0.2, 1, 0.2))


func reset_game() -> void:
	state = GameState.PLAYING
	score = 0

	snake_node.positions = initial_snake_positions.duplicate()
	snake_node.direction = Vector2i.RIGHT
	snake_node.next_direction = Vector2i.RIGHT
	snake_node.food_eaten = false
	snake_node._create_visuals()
	snake_node.update_visuals()

	food_node.visible = false

	ui_score.text = "Score: 0"
	hide_ui_panels()

	spawn_food()


func hide_ui_panels() -> void:
	ui_game_over.visible = false
	ui_win.visible = false


func is_won() -> bool:
	return score >= WIN_SCORE


func _game_over() -> void:
	state = GameState.GAME_OVER
	ui_game_over.visible = true
	ui_score.text = "Score: %d" % score


func _win() -> void:
	state = GameState.WON
	ui_win.visible = true
	ui_score.text = "Score: %d" % score


func restart_game() -> void:
	reset_game()


func _handle_input(direction_input: Vector2i) -> void:
	if state != GameState.PLAYING:
		return

	if direction_input + snake_node.direction != Vector2i.ZERO:
		snake_node.next_direction = direction_input


func _tick() -> void:
	if state != GameState.PLAYING:
		return

	var head: Vector2i = snake_node.positions[0]
	var new_head: Vector2i = head + snake_node.direction

	var out_of_bounds: bool = new_head.x < 0 or new_head.x >= GRID_COLS or new_head.y < 0 or new_head.y >= GRID_ROWS
	var self_collision: bool = false

	for pos in snake_node.positions:
		if pos == new_head:
			self_collision = true
			break

	if out_of_bounds or self_collision:
		snake_node.positions.insert(0, new_head)
		snake_node.food_eaten = false
		snake_node.update_visuals()
		_game_over()
		return

	snake_node.positions.insert(0, new_head)

	if food_node.visible and food_node.cell_position == new_head:
		score += 1
		snake_node.food_eaten = true
		ui_score.text = "Score: %d" % score
		spawn_food()
		if is_won():
			_win()
			return
	else:
		snake_node.positions.pop_back()
		snake_node.food_eaten = false

	snake_node.update_visuals()


func _process(delta: float) -> void:
	if state != GameState.PLAYING:
		return

	time_accum += delta
	while time_accum >= TICK_INTERVAL:
		time_accum -= TICK_INTERVAL
		_tick()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey:
		var key: InputEventKey = event as InputEventKey
		if key.pressed:
			if key.keycode == KEY_R:
				restart_game()
				get_viewport().set_input_as_handled()

			if key.keycode == KEY_F1:
				_debug_force_win()
				get_viewport().set_input_as_handled()

			if key.keycode == KEY_F2:
				_debug_force_wall_loss()
				get_viewport().set_input_as_handled()

			if key.keycode == KEY_F3:
				_debug_force_self_loss()
				get_viewport().set_input_as_handled()


func _debug_force_win() -> void:
	if state != GameState.PLAYING:
		return

	var occupied: Dictionary = {}
	for pos in snake_node.positions:
		occupied[pos] = true
	var empty: Array[Vector2i] = _get_empty_cells(occupied)

	snake_node.positions = [Vector2i(5, 5)]
	score = 0

	for i in range(3):
		if empty.is_empty():
			break
		var pos: Vector2i = empty.pop_at(randi() % empty.size())
		snake_node.positions.append(pos)
		occupied[pos] = true

	spawn_food()
	score = 2
	ui_score.text = "Score: 2"

	empty = _get_empty_cells(occupied)
	for p in empty:
		snake_node.positions.append(p)
		score += 1
		ui_score.text = "Score: %d" % score
		if score >= WIN_SCORE:
			break
		occupied[p] = true

	spawn_food()
	_win()


func _debug_force_wall_loss() -> void:
	if state != GameState.PLAYING:
		return

	snake_node.positions = [Vector2i(0, 0)]
	snake_node.direction = Vector2i.LEFT
	snake_node.next_direction = Vector2i.LEFT
	snake_node.food_eaten = false
	snake_node.update_visuals()
	_game_over()


func _debug_force_self_loss() -> void:
	if state != GameState.PLAYING:
		return

	snake_node.positions = [
		Vector2i(5, 5),
		Vector2i(5, 6),
		Vector2i(5, 7),
		Vector2i(4, 7),
		Vector2i(3, 7),
	]
	snake_node.direction = Vector2i.LEFT
	snake_node.next_direction = Vector2i.RIGHT
	snake_node.food_eaten = false
	snake_node.update_visuals()

	_tick()


func _get_empty_cells(occupied: Dictionary) -> Array[Vector2i]:
	var empty: Array[Vector2i] = []
	for x in range(GRID_COLS):
		for y in range(GRID_ROWS):
			var cell: Vector2i = Vector2i(x, y)
			if not occupied.has(cell):
				empty.append(cell)
	return empty


func spawn_food() -> void:
	var occupied: Dictionary = {}
	for pos in snake_node.positions:
		occupied[pos] = true
	var empty: Array[Vector2i] = _get_empty_cells(occupied)

	food_node.spawn(empty)
