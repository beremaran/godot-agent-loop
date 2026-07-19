extends Node2D

@onready var player: CharacterBody2D = $Player
@onready var score_label: Label = $UI/ScoreLabel
@onready var misses_label: Label = $UI/MissesLabel
@onready var controls_label: Label = $UI/ControlsLabel
@onready var result_label: Label = $UI/ResultLabel

var score: int = 0
var misses: int = 0
var game_over: bool = false
var spawn_timer: float = 0.0
var spawn_interval: float = 3.0
var target_scene: PackedScene = preload("res://scenes/target.tscn")
var active_targets: Array = []

func _ready() -> void:
	score_label.text = "Score: 0 / 3"
	misses_label.text = "Misses: 0 / 3"
	controls_label.text = "Controls: A/D or Left/Right to move | R to restart"
	result_label.text = ""

func _process(delta: float) -> void:
	if game_over:
		if Input.is_action_just_pressed("restart"):
			get_tree().reload_current_scene()
		return
	
	# Player movement
	var move_dir := 0.0
	if Input.is_action_pressed("move_left"):
		move_dir -= 1.0
	if Input.is_action_pressed("move_right"):
		move_dir += 1.0
	player.velocity.x = move_dir * 400.0
	player.velocity.y = 0.0
	player.move_and_slide()
	
	# Clamp player to screen
	player.position.x = clampf(player.position.x, 32.0, 1968.0)
	
	# Check for catches (player overlap with targets)
	var caught_targets: Array = []
	for target in active_targets:
		if target is Area2D and target.is_inside_tree():
			var overlapping = target.get_overlapping_bodies()
			for body in overlapping:
				if body == player:
					caught_targets.append(target)
					break
	
	for target in caught_targets:
		score += 1
		score_label.text = "Score: %d / 3" % score
		if target.is_inside_tree():
			target.queue_free()
			active_targets.erase(target)
		if score >= 3:
			_win()
	
	# Check for off-screen targets (misses)
	var missed_targets: Array = []
	for target in active_targets:
		if target is Area2D and target.is_inside_tree():
			if target.position.y > 900.0:
				missed_targets.append(target)
	
	for target in missed_targets:
		misses += 1
		misses_label.text = "Misses: %d / 3" % misses
		if target.is_inside_tree():
			target.queue_free()
			active_targets.erase(target)
		if misses >= 3:
			_lose()
	
	# Spawn targets
	spawn_timer += delta
	if spawn_timer >= spawn_interval:
		spawn_timer = 0.0
		_spawn_target()

func _spawn_target() -> void:
	if game_over:
		return
	var target := target_scene.instantiate()
	add_child(target)
	active_targets.append(target)

func _win() -> void:
	game_over = true
	result_label.text = "YOU WIN!"
	result_label.add_theme_color_override("font_color", Color(0.0, 0.8, 0.0, 1.0))

func _lose() -> void:
	game_over = true
	result_label.text = "YOU LOSE!"
	result_label.add_theme_color_override("font_color", Color(0.8, 0.0, 0.0, 1.0))
