extends CharacterBody2D

const SPEED = 400.0
const SCREEN_MARGIN = 32.0

@export var screen_size: Vector2 = Vector2(800, 600)

func _process(delta: float) -> void:
	var direction := 0.0
	if Input.is_action_pressed("move_right"):
		direction = 1.0
	if Input.is_action_pressed("move_left"):
		direction = -1.0
	velocity.x = direction * SPEED
	move_and_slide()
	position.x = clamp(position.x, SCREEN_MARGIN, screen_size.x - SCREEN_MARGIN)