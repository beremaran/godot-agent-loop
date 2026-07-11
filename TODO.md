# TypeScript Audit TODOs

The current baseline is clean: build, lint, and all 492 tests pass. The items below cover improvements not currently caught by the test suite.

## High priority

- [x] Strengthen filesystem sandboxing. `validatePath()` only rejects paths containing `..` and does not enforce project boundaries or resolve symlinks ([src/utils.ts:71](src/utils.ts:71)). Apply allowed-root checks consistently to editor launch, file operations, directory creation, project creation, and project configuration tools. Centralize path resolution using `realpath` and validate project-relative paths separately.
- [x] Correct headless-process failure handling. `HeadlessOperationRunner` returns exit status/signal information and `HeadlessOperationService` treats every non-zero exit as a failure.
- [x] Fix connection lifecycle races. `GameConnection.connect()` is asynchronous and not cancellable ([src/game-connection.ts:50](src/game-connection.ts:50)). Add connection generations/session IDs, cancel pending retries on disconnect, and ensure stale socket callbacks cannot mutate newer connection state.
- [x] Establish a versioned Godot Runtime API over JSON-RPC 2.0. Keep newline-delimited JSON over the existing TCP socket as the framing layer, replace the ad hoc `{ command, params, id }` and arbitrary response objects with standard JSON-RPC request/response/error envelopes, and add handshake/version/capability negotiation. Define the domain contract separately in OpenRPC or JSON Schema: method names, parameter/result schemas, structured error codes, Godot value serialization, concurrency, and timeout behavior. Generate or validate both TypeScript and GDScript bindings from the contract, and add cross-side contract tests.
- [x] Add subprocess timeouts and output limits. Defined shared timeout/max-buffer settings for Godot CLI calls, capped runtime stdout/stderr with ring buffers, and added graceful termination followed by forced kill.

## Medium priority

- [x] Add runtime argument validation. Tool definitions now provide the shared typed schema contract used by both `list_tools` and dispatch; arguments are parsed before handlers run, rejecting missing required fields, invalid types/enums/array items, and unknown top-level fields.
- [x] Split the large project-handler class into focused services: project file I/O, project configuration, script validation, export, and scene operations. This will reduce repeated normalization, path checks, and inconsistent error handling.
- [x] Encapsulate mutable connection state. Connection fields are private; callers use read-only state getters and explicit project/interaction-server lifecycle methods.
- [x] Make registry validation bidirectional. `composeToolHandlerRegistries()` checks duplicate and missing handlers ([src/domain-tool-registries.ts:14](src/domain-tool-registries.ts:14)) but does not reject extra handlers. Add an unknown-handler check to prevent definition/implementation drift.

## Lower priority

- [x] Use package metadata for the MCP server version. The server now reads the version from `package.json`, keeping its MCP initialization metadata aligned with the published package.
- [x] Replace heuristic Godot result parsing such as `stderr.includes('ERROR')` and `stderr.includes('Failed to')` with structured exit status and machine-readable output where available.
- [ ] Validate generated CI and Docker inputs. Platform names, Docker base images, versions, and export presets are interpolated into generated files ([src/tool-handlers/project-tool-handlers.ts:1644](src/tool-handlers/project-tool-handlers.ts:1644)). Validate allowed values and escape YAML/Dockerfile values.
- [ ] Expand tests for non-zero Godot exits with empty stderr, subprocess timeouts, stale connection callbacks, disconnect during retries, symlink path escapes, allowed-root enforcement, malformed arguments, unknown fields, and bounded process output.
