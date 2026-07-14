extends Node2D


func _ready() -> void:
	add_to_group("harness-owned-game-ready")
	var proof := Label.new()
	proof.name = "RuntimeProof"
	proof.text = "real game running in harness-owned main loop"
	add_child(proof)
