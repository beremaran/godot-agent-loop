extends Node2D

var cell_position := Vector2i(-1, -1)

var food_rect: ColorRect


func _ready() -> void:
	food_rect = ColorRect.new()
	food_rect.name = "food_rect"
	food_rect.color = Color(1.0, 0.2, 0.2)
	food_rect.position = Vector2(0, 0)
	food_rect.size = Vector2(32, 32)
	add_child(food_rect)


func spawn(empty_cells: Array[Vector2i]) -> void:
	if empty_cells.is_empty():
		visible = false
		return

	var idx := randi() % empty_cells.size()
	cell_position = empty_cells[idx]
	var pos := Vector2(cell_position.x * 33, cell_position.y * 33)
	position = pos
	visible = true


func is_eaten(head_pos: Vector2i) -> bool:
	return visible and cell_position == head_pos
