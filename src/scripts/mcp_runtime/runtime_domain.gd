extends Node

# Base class for a runtime command domain.
#
# A domain owns the handlers for one Godot subsystem plus any state those
# handlers keep (held keys, debug-draw objects, sockets), and registers them
# with the server's command registry. Domains are children of the interaction
# server node, so get_tree() and get_viewport() resolve exactly as they did
# when the handlers lived on the server itself.
#
# This class is the only place domain code touches the server: handlers call
# the helpers below and never see sessions, sockets, request IDs, or the
# registry. That keeps the transport layer free of subsystem knowledge and
# lets a domain move without changing the protocol implementation.

const CommandParams = preload("res://mcp_runtime/command_params.gd")
const VariantCodec = preload("res://mcp_runtime/variant_codec.gd")
# The composition root is always the autoload at res://mcp_interaction_server.gd.
# It loads its domains by path at runtime rather than preloading them, so naming
# its script here types every transport helper below without a preload cycle.
const InteractionServer = preload("res://mcp_interaction_server.gd")

var _server: InteractionServer
var _registrar: Callable
var _codec: VariantCodec


# Called by the composition root before register_commands(). `registrar` is the
# server's _register_command(command, handler) callable, which is what decides
# cancellability from the transport's declarative CANCELLABLE_COMMANDS list.
func setup(server: InteractionServer, registrar: Callable) -> void:
	_server = server
	_registrar = registrar
	_codec = server._codec


# Overridden by each domain to register its commands via register_command().
func register_commands() -> void:
	pass


func register_command(command: String, handler: Callable) -> void:
	_registrar.call(command, handler)


# --- Transport helpers ---
# Mirrors of the server-side helpers, so a handler body reads the same whether
# it lives in a domain or in the composition root.

# Completes the active request. A result dictionary is sent as the JSON-RPC
# result; an {"error": ...} dictionary becomes a standardized command failure.
func respond(result: Dictionary) -> void:
	_server._send_response(result)


# Sends the standardized -32000 failure and reports whether the handler must
# stop. Every handler calls this once after reading its parameters.
func params_invalid(reader: CommandParams) -> bool:
	var invalid: bool = _server._params_invalid(reader)
	return invalid


# The same failure for a handler that failed the reader itself, on a rule the
# accessors cannot express, and is about to stop.
func send_params_error(reader: CommandParams) -> void:
	_server._send_params_error(reader)


func require_node(reader: CommandParams, param_name: String = "node_path", default_path: String = "") -> Node:
	var node: Node = _server._require_node(reader, param_name, default_path)
	return node


func godot_error_data(err: int) -> Dictionary:
	var data: Dictionary = _server._godot_error_data(err)
	return data


# JSON-safe encoding and typed decoding are owned by the shared codec service.
func variant_to_json(value: Variant) -> Variant:
	_codec.configure(_server.max_json_nesting_depth, _server.max_json_collection_items)
	var encoded: Variant = _codec.encode(value)
	return encoded

func json_to_variant(value: Variant, type_hint: String = "") -> Variant:
	_codec.configure(_server.max_json_nesting_depth, _server.max_json_collection_items)
	return _codec.decode(value, type_hint)


func json_to_variant_for_property(node: Node, property: String, value: Variant) -> Variant:
	_codec.configure(_server.max_json_nesting_depth, _server.max_json_collection_items)
	return _codec.decode_for_property(node, property, value)


# Async signal waits query cancellation and report timeout through transport
# helpers without gaining access to sessions or request IDs.
func cancellation_requested() -> bool:
	return _server._is_active_request_cancelled()


func respond_timeout(message: String, details: Dictionary = {}) -> void:
	_server._send_timeout_response(message, details)
