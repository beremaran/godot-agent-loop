# GodotServer Refactor TODO

The domain-specific tool handlers have been extracted from `GodotServer` into
dedicated game and project handler modules. The remaining work is focused on
finishing the separation and improving maintainability.

- [x] Extract the five lifecycle handlers still in `GodotServer`:
  - `launch_editor`
  - `run_project`
  - `get_debug_output`
  - `stop_project`
  - `get_godot_version`
- [x] Move remaining project-support helpers out of `GodotServer`:
  - project discovery
  - project structure scanning
  - .NET detection
  - key/scancode mapping
  - script-validation and changed-file helpers
- [x] Replace callback-heavy handler contexts with clearer service interfaces,
  especially around `gameCommand`, `headlessOp`, and executable access.
- [x] Split the large manual tool registry into composable domain registries.
- [x] Add direct unit tests for the extracted handler modules.
- [x] Replace brittle source-structure tests with behavior-focused tests where
  practical.
- [ ] Introduce stronger argument types and reduce remaining `any` usage.
