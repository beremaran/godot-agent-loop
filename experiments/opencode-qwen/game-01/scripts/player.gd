extends CharacterBody2D

func _ready() -> void:
	position = Vector2(1000, 850)
	
	var sprite := Sprite2D.new()
	var img := Image.create(60, 40, false, Image.FORMAT_RGBA8)
	img.fill(Color(0.2, 0.6, 1.0, 1.0))
	var tex := ImageTexture.create_from_image(img)
	sprite.texture = tex
	sprite.position = Vector2(0, -20)
	add_child(sprite)
	
	var col := CollisionShape2D.new()
	var shape := CapsuleShape2D.new()
	shape.height = 40.0
	shape.radius = 20.0
	col.shape = shape
	add_child(col)
