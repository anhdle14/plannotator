---
template: bug-investigation
description: Reproduce a bug or incident first, then prove the root cause and fix
status: investigating
owner: {{owner}}
created: {{date}}
builder: <implementer>
validator: <reviewer>
---
# {{intent}}
## Symptom and context
- Expected: ...
- Observed: ...
- Reproduction: ...
- Scope / non-goals: ...
## Plan
### Phase 1 - Reproduce and localize
- [ ] Builder: reproduce and identify the failing boundary.
- [ ] Validator: reproduce independently and test the hypothesis.
- Validate: `<reproduction>`; `<diagnostic>`
- Exit: failure is captured and root cause is evidenced.
### Phase 2 - Fix and regress
- [ ] Builder: implement the smallest safe fix and regression test.
- [ ] Validator: test adjacent failure modes and review the diff.
- Validate: `<focused test>`; `<full test>`
- Exit: tests pass and the root cause is documented.
## Risks and rollback
- Regression risk: ...
- Rollback: ...
## Outcome
- Root cause / fix / evidence: ...
