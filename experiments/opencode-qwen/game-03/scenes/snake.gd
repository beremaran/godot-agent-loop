extends Node2D

var positions: Array[Vector2i] = []
var direction := Vector2i.RIGHT
var next_direction := Vector2i.RIGHT
var food_eaten := false

var segments_container: Node2D


func _ready() -> void:
	segments_container = Node2D.new()
	segments_container.name = "segments"
	add_child(segments_container)

	positions = [
		Vector2i(10, 7),
		Vector2i(9, 7),
		Vector2i(8, 7),
	]

	direction = Vector2i.RIGHT
	next_direction = Vector2i.RIGHT

	_create_visuals()
	update_visuals()


func _create_visuals() -> void:
	for seg in segments_container.get_children():
		seg.queue_free()

	for i in range(positions.size()):
		var color := Color(0.2, 0.8, 0.2) if i == 0 else Color(0.15, 0.65, 0.15)
		var rect := ColorRect.new()
		rect.name = "seg_%d" % i
		rect.color = color
		rect.position = Vector2(0.5, 0.5)
		rect.size = Vector2(31, 31)
		segments_container.add_child(rect)


func move() -> void:
	direction = next_direction

	var head := positions[0]
	var new_head := head + direction

	var out_of_bounds := new_head.x < 0 or new_head.x >= 20 or new_head.y < 0 or new_head.y >= 15
	var self_collision := false

	for pos in positions:
		if pos == new_head:
			self_collision = true
			break

	if out_of_bounds or self_collision:
		positions.insert(0, new_head)
		food_eaten = false
		update_visuals()
		return

	positions.insert(0, new_head)

	if not food_eaten:
		positions.pop_back()

	update_visuals()


func check_food(food_pos: Vector2i) -> bool:
	if positions[0] == food_pos:
		positions.append(positions.back())
		food_eaten = true
		update_visuals()
		return true
	return false


func set_direction(new_dir: Vector2i) -> void:
	if new_dir + direction != Vector2i.ZERO:
		next_direction = new_dir


func update_visuals() -> void:
	var children := segments_container.get_children()
	for i in range(positions.size()):
		if i < children.size():
			var child := children[i] as Node2D
			var pos := Vector2(positions[i].x * 33, positions[i].y * 33)
			child.position = pos
			child.size = Vector2(32, 32)
