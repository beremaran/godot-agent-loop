extends Node2D

const CELL_SIZE := 32
const GRID_COLS := 20
const GRID_ROWS := 15
const PLAY_WIDTH := CELL_SIZE * GRID_COLS
const PLAY_HEIGHT := CELL_SIZE * GRID_ROWS
const GAP := 1
const STEP := CELL_SIZE + GAP


func _ready() -> void:
	var bg := ColorRect.new()
	bg.name = "background"
	bg.position = Vector2.ZERO
	bg.size = Vector2(PLAY_WIDTH, PLAY_HEIGHT)
	bg.color = Color(0.05, 0.05, 0.05)
	add_child(bg)


func position_at_cell(cell: Vector2i, node: Node2D) -> void:
	var pos := Vector2(cell.x * STEP, cell.y * STEP)
	node.position = pos
	node.size = Vector2(CELL_SIZE, CELL_SIZE)


func get_cell_position(cell: Vector2i) -> Vector2:
	return Vector2(cell.x * STEP, cell.y * STEP)
