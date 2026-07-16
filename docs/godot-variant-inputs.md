# Godot Variant input shapes

Variant-valued tool fields use the canonical shapes in
[`godot-variant-shapes.json`](godot-variant-shapes.json). Prefer an explicit
`{ "type": "…", "value": … }` wrapper when a JSON array, string, or object
would otherwise be ambiguous. Component objects remain supported when the
target Godot property type is already known.

Vector and colour components must be numeric and complete for the target type.
Conversion failures report `invalid_variant_shape`, the target property type,
the accepted component shape, and the invalid component. Resource wrappers use
`res://` paths. `NodePath` and `StringName` wrappers carry strings.

Typed wrappers contain exactly `type` and `value`. Vector and quaternion
wrappers may use fixed-length component arrays; integer-vector arrays require
integers. Resource wrappers require an existing `res://` path. Wrapper types
that conflict with a known target property type are rejected.

Arrays and dictionaries remain intentionally open because they may contain
nested Variants. RID values are diagnostic-only: the server does not recreate
arbitrary live RIDs from JSON. Mutation tools reject that shape instead of
reporting a successful write that did not occur.
