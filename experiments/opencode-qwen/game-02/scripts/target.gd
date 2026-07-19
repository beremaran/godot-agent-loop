extends Area2D

signal target_caught
signal target_missed

const FALL_SPEED = 250.0

var screen_size: Vector2 = Vector2(800, 600)
var caught := false

func _enter_tree() -> void:
	position.x = randf_range(64.0, screen_size.x - 64.0)
	position.y = -40.0
	body_entered.connect(_on_body_entered)

func _ready() -> void:
	pass

func _process(delta: float) -> void:
	if caught:
		return
	position.y += FALL_SPEED * delta
	if position.y > screen_size.y + 40.0:
		target_missed.emit()
		queue_free()

func _on_body_entered(body: Node2D) -> void:
	if caught:
		return
	caught = true
	target_caught.emit()
	queue_free()
