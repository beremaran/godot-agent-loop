extends Area2D

var fall_speed: float = 60.0

func _ready() -> void:
	add_to_group("target")
	position.x = randf_range(50.0, 1950.0)
	position.y = 50.0
	
	var sprite := Sprite2D.new()
	var img := Image.create(40, 40, false, Image.FORMAT_RGBA8)
	img.fill(Color(1.0, 0.8, 0.0, 1.0))
	var tex := ImageTexture.create_from_image(img)
	sprite.texture = tex
	sprite.position = Vector2(0, 0)
	add_child(sprite)
	
	var col := CollisionShape2D.new()
	var shape := CircleShape2D.new()
	shape.radius = 20.0
	col.shape = shape
	add_child(col)

func _process(delta: float) -> void:
	position.y += fall_speed * delta
