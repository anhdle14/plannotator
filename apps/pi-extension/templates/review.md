---
template: review
description: Review a PR, design, or another agent's work with cited findings
status: draft
owner: {{owner}}
created: {{date}}
builder: <reviewer>
validator: <second reviewer>
---
# {{intent}}
## Subject and intent
- What is reviewed (PR, branch, design, plan): ...
- Stated intent and acceptance criteria: ...
- Out of scope: ...
## Phases
### Phase 1 - Intent check
- [ ] Builder: compare the change against its stated intent.
- [ ] Validator: confirm the intent reading.
- Validate: `<diff/log command>`
- Exit: mismatches between intent and change are listed.
### Phase 2 - Risk areas
- [ ] Builder: list the risky areas (data, security, concurrency, compatibility).
- [ ] Validator: add missing risk areas.
- Exit: every risk area has an owner question.
### Phase 3 - Evidence and findings
- [ ] Builder: gather evidence per risk area and write findings.
- [ ] Validator: reproduce each finding; drop unsupported ones.
- Validate: `<test/repro command>`
- Exit: every finding cites `file:line` and evidence.
## Findings
- Severity / `file:line` / evidence / recommendation: ...
## Outcome
- Verdict / accepted findings / follow-up: ...
