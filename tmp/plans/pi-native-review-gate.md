# Pi-Native Plannotator Review Gate Implementation Plan

## Context

The existing `anhdle14/plannotator` fork is at `v0.21.4`, while the approved design targets upstream `v0.27.4`.
The fork must keep upstream Plannotator review features and the existing Shift+Tab customization while making Pi the sole owner of AGENTS context, model selection, thinking level, and general-purpose tools.

The approved design is `docs/specs/2026-08-19-pi-native-review-gate-design.md`.
No implementation may begin until this plan is reviewed and the mandatory documentation/code grill completes.

## Approach

Update the fork to upstream `v0.27.4`, preserve upstream's one-shot conversation framing, and isolate the customization to the Pi extension's state machine and safety gates.
Replace immediate approval-to-execution with approval-to-grilling, verify the approved plan by hash, and unlock implementation only through an explicit grill-completion tool.

Load the fork as a local Pi package and remove the duplicate chezmoi-vendored extension only after fork, model, and browser verification pass.

## Files to modify

### Plannotator fork

- `AGENTS.md`
- `apps/pi-extension/index.ts`
- `apps/pi-extension/tool-scope.ts`
- `apps/pi-extension/tool-scope.test.ts`
- `apps/pi-extension/config.ts`
- `apps/pi-extension/config.test.ts`
- `apps/pi-extension/plannotator.json`
- `apps/pi-extension/README.md`
- Focused new Pi-extension state-machine tests if extracting pure transition helpers is necessary

### Dotfiles source

- `dot_init/Brewfile`
- `dot_pi/agent/modify_settings.json`
- `dot_pi/agent/models.json`
- `run_onchange_after_44-install-local-pi-packages.sh.tmpl`
- `run_after_43-fetch-plannotator-html.sh.tmpl`, renamed to run after local-package bootstrap
- `run_onchange_after_42-install-pi-extension-deps.sh.tmpl`
- `.chezmoiignore`
- `AGENTS.md`
- Remove `dot_pi/agent/extensions/plannotator/` after migration verification

## Reuse

- Preserve upstream `v0.27.4` one-shot phase framing in `apps/pi-extension/index.ts`; it already avoids system-prompt modification.
- Reuse upstream browser review, plan diff, annotations, approval notes, archive, sharing, and external handoff behavior.
- Reuse `isPlanWritePathAllowed()` from `apps/pi-extension/tool-scope.ts` for in-cwd Markdown validation.
- Reuse existing custom session entries and branch replay for state restoration.
- Reuse `ask_user_question` for the one-question-at-a-time human grill.
- Reuse the dotfiles local-package bootstrap pattern already used for `piflo`.
- Reuse upstream published `v0.27.4` HTML assets because the browser UI remains unchanged.

## Steps

- [ ] 1. Install Bun directly, record it in `dot_init/Brewfile`, and verify the executable before relying on upstream build commands.
- [ ] 2. Synchronize the fork branch with upstream release `v0.27.4` without rewriting history, regenerate the Pi extension, and run the unmodified upstream Pi-extension tests as a baseline.
- [ ] 3. Reapply the fork's Shift+Tab plan-mode shortcut if upstream `v0.27.4` does not provide equivalent behavior.
- [ ] 4. Make Pi runtime state authoritative: remove Plannotator model/thinking/general-tool mutation paths and their obsolete config surface while retaining status labels, one-shot instructions, review tools, and existing UI behavior.
- [ ] 5. Extend the persisted phase model with `grilling`, approved plan SHA-256, approval notes, and grill summary; update reload, resume, compaction, tree-navigation, and missing-file recovery paths.
- [ ] 6. Replace every no-UI, missing-asset, automatic, and external approval shortcut with a fail-closed or approval-to-grilling transition. Record the approved hash and queue the mandatory grill instead of implementation or handoff.
- [ ] 7. Add `plannotator_finish_grill` with provider-neutral TypeBox parameters. Require explicit confirmation, verify the approved file hash, reject changed plans for re-review, and only then enter automatic execution or emit the existing external handoff.
- [ ] 8. Update one-shot planning and grilling instructions: applicable AGENTS and explicit user instructions are authoritative; default plans use `tmp/plans/<slug>.md`; facts come from docs/code; user decisions are asked one at a time with recommendations; implementation remains forbidden until grill completion.
- [ ] 9. Extend pre-implementation mutation gating to `planning` and `grilling`, covering built-in `write`/`edit` and the installed `patch` tool while retaining all Pi tools in the active set.
- [ ] 10. Add or update fork tests for Pi-state preservation, default/override paths, tool gates, approval-to-grill transitions, hash validation, changed-plan re-review, unchanged-plan completion, fail-closed noninteractive behavior, external handoff timing, branch replay, compaction, and dismissal behavior.
- [ ] 11. Update fork documentation and `AGENTS.md` with the Pi-native invariants, state machine, plan location, grill protocol, local build, and upstream release-update procedure.
- [ ] 12. Correct the LiteLLM Claude model definitions in `dot_pi/agent/models.json` so configured Fable and Opus routes omit unsupported `reasoning_effort`, then verify requests reach tool selection.
- [ ] 13. Add the fork's `apps/pi-extension` local package path to Pi settings and extend fresh-machine bootstrap to clone the fork, install runtime dependencies, run `vendor.sh`, and fetch matching `v0.27.4` browser assets after checkout creation.
- [ ] 14. Load the fork explicitly for verification and confirm Pi sees exactly one Plannotator instance. Only after parity passes, remove the chezmoi-vendored Plannotator tree and apply the local-package configuration.
- [ ] 15. Run Bun-backed unit, type, lint, build, model, session-restoration, scoped chezmoi, and real-browser review verification. Do not commit, merge, push, or publish without explicit user instruction.

## Verification

### Fork checks

- Run the upstream Plannotator test suite and focused `apps/pi-extension` tests.
- Run the repository typecheck after `apps/pi-extension/vendor.sh` regenerates ignored modules.
- Confirm no Pi-extension code calls `pi.setModel()`, `pi.setThinkingLevel()`, or `pi.setActiveTools()`.
- Confirm `before_agent_start` never returns a `systemPrompt` override.
- Confirm the fork worktree contains only intended custom changes beyond upstream `v0.27.4` and the preserved Shift+Tab behavior.

### Workflow checks

- Start plan mode with global, ancestor, and cwd AGENTS files and verify all remain in Pi's effective context.
- Confirm the default plan path is `<cwd>/tmp/plans/<slug>.md`.
- Confirm an applicable AGENTS instruction can select another `.md` or `.mdx` path inside cwd.
- Confirm traversal, outside-cwd paths, and non-Markdown files remain rejected.
- Confirm `write`, `edit`, and `patch` cannot mutate source files in `planning` or `grilling`.
- Confirm print/JSON mode and missing browser assets fail closed without approval, execution, or external handoff.
- Confirm approval enters `grilling` and does not start implementation.
- Confirm the grill investigates documentation/code and asks one recommended decision question at a time.
- Confirm a changed plan cannot finish grilling and must pass browser review again.
- Confirm an unchanged plan plus explicit shared-understanding confirmation enters `executing`.
- Confirm external execution handoff occurs after grill completion, never immediately after review.
- Confirm reload, resume, fork, compaction, and tree navigation restore the correct phase and approved hash.

### Model checks

Run the same controlled review/grill flow with:

- GPT-5.6 Sol.
- GPT-5.6 Terra.
- GPT-5.6 Luna.
- Claude Fable.
- Claude Opus.

Each model must use the existing Pi tools, preserve AGENTS guidance, call Plannotator tools with valid schemas, and avoid implementation before the grill gate opens.

### Browser checks

Exercise the actual Plannotator browser UI for approval, denial with annotations, approval with notes, dismissal, changed-plan diff/re-review, and final unchanged-plan grill completion.
The UI should remain visually and functionally identical to upstream `v0.27.4`.

### Dotfiles checks

- Confirm Bun is installed and recorded in `dot_init/Brewfile`.
- Preview every source change with scoped `chezmoi diff` before apply.
- Confirm the fork checkout is reproducibly bootstrapped on a missing-checkout simulation.
- Confirm generated modules, runtime dependencies, and `v0.27.4` HTML assets exist in the local package.
- Confirm the old `~/.pi/agent/extensions/plannotator` deployment is absent after migration.
- Confirm `pi list` and startup load exactly one fork package.
- Confirm scoped `chezmoi diff` is clean after apply.
- Run Markdown lint and preserve every unrelated dirty-tree change.
