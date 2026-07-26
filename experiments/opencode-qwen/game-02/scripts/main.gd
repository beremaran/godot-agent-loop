extends Node2D

const TARGET_SCENE := preload("res://scenes/target.tscn")

const TARGETS_TO_WIN := 3
const MISSES_TO_LOSE := 3
const SPAWN_INTERVAL := 1.2
const INITIAL_DELAY := 0.5

var caught_count := 0
var miss_count := 0
var game_over := false
var spawn_timer := 0.0
var initial_delay_timer := 0.0
var initial_delay_active := true

@onready var catch_label: Label = $CatchLabel
@onready var miss_label: Label = $MissLabel
@onready var message_label: Label = $MessageLabel
@onready var player = $Player

var screen_size := Vector2(800, 600)

func _ready() -> void:
	player.set("screen_size", screen_size)
	_update_labels()

func _process(delta: float) -> void:
	if game_over:
		return

	# Test-only: force win - held key triggers immediately
	if Input.is_action_pressed("force_win"):
		caught_count = TARGETS_TO_WIN - 1
		_update_labels()
		_on_target_caught()
		return

	# Test-only: force lose - held key triggers immediately
	if Input.is_action_pressed("force_lose"):
		miss_count = MISSES_TO_LOSE - 1
		_update_labels()
		_on_target_missed()
		return

	# Initial delay before spawning targets (allows force inputs to work)
	if initial_delay_active:
		initial_delay_timer += delta
		if initial_delay_timer >= INITIAL_DELAY:
			initial_delay_active = false
		return

	spawn_timer += delta
	if spawn_timer >= SPAWN_INTERVAL:
		spawn_timer = 0.0
		_spawn_target()

func _input(event: InputEvent) -> void:
	if event.is_action_pressed("restart") and game_over:
		get_tree().reload_current_scene()

func _spawn_target() -> void:
	var target := TARGET_SCENE.instantiate()
	target.set("screen_size", screen_size)
	target.connect("target_caught", Callable(self, "_on_target_caught"))
	target.connect("target_missed", Callable(self, "_on_target_missed"))
	add_child(target)

func _on_target_caught() -> void:
	if game_over:
		return
	caught_count += 1
	_update_labels()
	if caught_count >= TARGETS_TO_WIN:
		_show_message("YOU WIN!")
		game_over = true

func _on_target_missed() -> void:
	if game_over:
		return
	miss_count += 1
	_update_labels()
	if miss_count >= MISSES_TO_LOSE:
		_show_message("GAME OVER")
		game_over = true

func _update_labels() -> void:
	catch_label.text = "Caught: %d/%d" % [caught_count, TARGETS_TO_WIN]
	miss_label.text = "Missed: %d/%d" % [miss_count, MISSES_TO_LOSE]

func _show_message(msg: String) -> void:
	message_label.text = msg
	message_label.visible = true
