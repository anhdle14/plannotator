---
template: refactor
description: Change structure without changing behavior, behind a safety net
status: draft
owner: {{owner}}
created: {{date}}
builder: <implementer>
validator: <reviewer>
models: plan=frontier; build=per phase (- Model: lines); review=cross-vendor
---
# {{intent}}
## Target shape and invariants
- Current structure: ...
- Target structure: ...
- Behavior that must not change: ...
- Non-goals: ...
## Phases
### Phase 1 - Characterize
- [ ] Builder: map callers, interfaces, and current behavior.
- [ ] Validator: confirm the map covers every entry point.
- Validate: `<search/inventory command>`
- Exit: the behavior to preserve is written down.
- Gate: human approval of the target shape.
### Phase 2 - Safety net
- [ ] Builder: add or confirm characterization tests for that behavior.
- [ ] Validator: check the tests fail when behavior changes.
- Validate: `<focused test>`
- Exit: tests are green and cover the invariants.
### Phase 3 - Small moves
- [ ] Builder: move in small steps, running the safety net after each.
- [ ] Validator: review each step's diff for behavior drift.
- Validate: `<focused test>`; `<full test>`
- Exit: target shape reached with behavior tests unchanged.
### Phase 4 - Verify parity
- [ ] Builder: remove dead code and compare before/after behavior.
- [ ] Validator: confirm no test was deleted, skipped, or weakened.
- Validate: `<full test>`; `<lint/typecheck>`
- Exit: behavior tests unchanged and green.
## Risks and rollback
- Risk / mitigation / rollback: ...
## Outcome
- Delivered / evidence / follow-up: ...
