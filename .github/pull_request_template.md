## Public surface

- [ ] This change does not add or alter a public tool/action.
- [ ] If it does, the schema, strict downstream parameters, one-to-one routing,
  privilege, timeout, cancellation, mutation, and cleanup semantics are updated.
- [ ] The traceability manifest and generated coverage report are updated.

## Verification

- [ ] Unit and protocol/contract coverage is included where applicable.
- [ ] Direct-Godot behavior and full MCP-to-Godot happy/failure paths are tested.
- [ ] Final effects are observed independently of command responses.
- [ ] Repetition, partial failure, teardown, and leak behavior are covered.
- [ ] Version, platform, renderer, build-flavor, and export applicability is
  declared, with a tested limitation when a case is not supported.

## Documentation and risk

- [ ] Prerequisites, privilege/trust boundary, side effects, limitations, and
  recovery behavior are documented.
- [ ] Any allowed warning or quarantine has an owner, issue, reason, and expiry.
