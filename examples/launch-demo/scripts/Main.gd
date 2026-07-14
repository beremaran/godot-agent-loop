extends Node2D
class_name Main

enum State { PLAYING, WIN, LOSE }

var state: State = State.PLAYING
var speed: float = 200.0
var win_distance: float = 40.0

@onready var player: ColorRect = $Player
@onready var goal: ColorRect = $Goal
@onready var status_label: Label = $StatusLabel

func _ready() -> void:
	_update_label()

func _process(delta: float) -> void:
	if state != State.PLAYING:
		return

	if Input.is_action_just_pressed("lose"):
		_set_state(State.LOSE)
		return

	if Input.is_action_pressed("move_right"):
		player.position.x += speed * delta

	if player.position.distance_to(goal.position) < win_distance:
		_set_state(State.WIN)

func _set_state(new_state: State) -> void:
	state = new_state
	_update_label()

func _update_label() -> void:
	match state:
		State.PLAYING:
			status_label.text = "PLAYING"
		State.WIN:
			status_label.text = "WIN"
		State.LOSE:
			status_label.text = "LOSE"
	print(status_label.text)
