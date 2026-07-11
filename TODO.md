# TypeScript Audit TODOs

The current baseline is clean: build, lint, and all 492 tests pass. The items below cover improvements not currently caught by the test suite.

## High priority

- [x] Strengthen filesystem sandboxing. `validatePath()` only rejects paths containing `..` and does not enforce project boundaries or resolve symlinks ([src/utils.ts:71](src/utils.ts:71)). Apply allowed-root checks consistently to editor launch, file operations, directory creation, project creation, and project configuration tools. Centralize path resolution using `realpath` and validate project-relative paths separately.
- [x] Correct headless-process failure handling. `HeadlessOperationRunner` returns exit status/signal information and `HeadlessOperationService` treats every non-zero exit as a failure.
- [x] Fix connection lifecycle races. `GameConnection.connect()` is asynchronous and not cancellable ([src/game-connection.ts:50](src/game-connection.ts:50)). Add connection generations/session IDs, cancel pending retries on disconnect, and ensure stale socket callbacks cannot mutate newer connection state.
- [ ] Establish a versioned Godot Runtime API over JSON-RPC 2.0. Keep newline-delimited JSON over the existing TCP socket as the framing layer, replace the ad hoc `{ command, params, id }` and arbitrary response objects with standard JSON-RPC request/response/error envelopes, and add handshake/version/capability negotiation. Define the domain contract separately in OpenRPC or JSON Schema: method names, parameter/result schemas, structured error codes, Godot value serialization, concurrency, and timeout behavior. Generate or validate both TypeScript and GDScript bindings from the contract, and add cross-side contract tests.
- [ ] Add subprocess timeouts and output limits. Several Godot invocations lack timeouts, and the process manager stores stdout/stderr indefinitely ([src/godot-process-manager.ts:34](src/godot-process-manager.ts:34)). Define standard timeout/max-buffer settings, cap retained logs with ring buffers, and support graceful termination followed by forced kill.

## Medium priority

- [ ] Add runtime argument validation. Tool schemas are advertised but raw arguments are dispatched directly ([src/index.ts:369](src/index.ts:369)); `ToolArguments` is effectively `Record<string, any>` ([src/utils.ts:6](src/utils.ts:6)). Use typed schemas for parsing before dispatch and generate definitions/types from a shared source.
- [ ] Split the large project-handler class into focused services: project file I/O, project configuration, script validation, export, and scene operations. This will reduce repeated normalization, path checks, and inconsistent error handling.
- [ ] Encapsulate mutable connection state. Connection fields are publicly mutable ([src/game-connection.ts:22](src/game-connection.ts:22)). Make state private and expose read-only getters and intentional state-transition methods.
- [ ] Make registry validation bidirectional. `composeToolHandlerRegistries()` checks duplicate and missing handlers ([src/domain-tool-registries.ts:14](src/domain-tool-registries.ts:14)) but does not reject extra handlers. Add an unknown-handler check to prevent definition/implementation drift.

## Lower priority

- [ ] Use package metadata for the MCP server version. The server reports `0.1.0` while `package.json` is `3.0.0` ([src/index.ts:204](src/index.ts:204)). Use one version source during build.
- [ ] Replace heuristic Godot result parsing such as `stderr.includes('ERROR')` and `stderr.includes('Failed to')` with structured exit status and machine-readable output where available.
- [ ] Validate generated CI and Docker inputs. Platform names, Docker base images, versions, and export presets are interpolated into generated files ([src/tool-handlers/project-tool-handlers.ts:1644](src/tool-handlers/project-tool-handlers.ts:1644)). Validate allowed values and escape YAML/Dockerfile values.
- [ ] Expand tests for non-zero Godot exits with empty stderr, subprocess timeouts, stale connection callbacks, disconnect during retries, symlink path escapes, allowed-root enforcement, malformed arguments, unknown fields, and bounded process output.
