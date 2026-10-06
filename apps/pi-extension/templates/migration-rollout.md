---
template: migration-rollout
description: Infra, data, or dependency change rolled out in reversible stages
status: draft
owner: {{owner}}
created: {{date}}
builder: <operator>
validator: <safety reviewer>
models: plan=frontier; build=per phase (- Model: lines); review=cross-vendor
---
# {{intent}}
## Target and guardrails
- Current -> target: ...
- Success metrics: ...
- Rollback threshold: ...
- Maintenance window / owners: ...
## Phases
### Phase 1 - Prepare
- [ ] Builder: inventory, backup, and dry run.
- [ ] Validator: verify prerequisites and recovery path.
- Validate: `<preflight>`; `<backup/snapshot check>`
- Exit: rollback is ready.
### Phase 2 - Canary
- [ ] Builder: execute the smallest reversible step.
- [ ] Validator: compare health and consistency metrics.
- Validate: `<migration>`; `<health check>`; `<consistency check>`
- Exit: metrics stay within thresholds.
### Phase 3 - Expand and close
- [ ] Builder: complete rollout and cleanup.
- [ ] Validator: verify final state and monitoring.
- Validate: `<rollout>`; `<final verification>`
- Exit: target state is evidenced.
## Recovery and outcome
- Rollback steps / rollback validation: ...
- Final state / metrics / deviations / follow-up: ...
