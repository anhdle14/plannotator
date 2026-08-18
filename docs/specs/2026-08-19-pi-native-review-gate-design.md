# Pi-Native Plannotator Review Gate Design

Status: Approved and implemented on `feat/pi-native-review-gate`

## Summary

The maintained `anhdle14/plannotator` fork will preserve Plannotator's upstream review and annotation features while making Pi the sole owner of model behavior, tools, context, and implementation workflow.

Plannotator will provide a browser review gate and a mandatory human grill between plan approval and implementation.
It will not modify Pi's system prompt, active tools, model, thinking level, loaded AGENTS files, or skills.
Phase framing will remain in one-shot conversation messages, matching upstream `v0.27.4` behavior.

## Goals

- Update the existing fork from Plannotator `v0.21.4` to the upstream `v0.27.4` release.
- Preserve all upstream Plannotator features and the fork's Shift+Tab plan-mode shortcut.
- Load the fork directly from the local checkout as a Pi package.
- Preserve Pi's global, ancestor, and cwd AGENTS context without re-parsing or replacing it.
- Default plans to `<cwd>/tmp/plans/<slug>.md` unless an applicable AGENTS file or explicit user instruction selects another safe Markdown path inside cwd.
- Preserve Pi's active tools, model, thinking level, prompt metadata, skills, and provider behavior.
- Require browser plan approval, then a human grill against relevant documentation and code, before implementation can start.
- Require another browser review whenever grilling changes the approved plan.
- Fail closed without interactive review support or browser assets; never auto-approve an unreviewed plan.
- Work with every model currently configured in Pi.
- Install and record Bun so the fork can run upstream's native test, typecheck, and build workflow.

## Non-goals

- Reimplement Plannotator's browser UI, plan renderer, annotation system, code review, archive, or sharing features.
- Parse natural-language AGENTS files into a second configuration system.
- Replace Pi tools with Plannotator-specific read, search, edit, or execution tools.
- Force a model, thinking level, or reduced active-tool set for planning.
- Guarantee write isolation for arbitrary third-party tools whose mutation behavior Plannotator cannot identify.
- Automatically commit, push, or publish the fork.

## Source ownership and installation

The existing public fork at `github.com/anhdle14/plannotator` remains the source of truth.
Development occurs on a dedicated branch and worktree based on upstream release `v0.27.4`.
The existing Shift+Tab customization is retained if upstream has not added equivalent behavior.

Pi loads the package from:

```text
~/Developer/github.com/anhdle14/plannotator/apps/pi-extension
```

The dotfiles repository records that local path in `dot_pi/agent/modify_settings.json`.
Bun is installed through Homebrew and recorded in `dot_init/Brewfile` so upstream tests and builds are reproducible.
The dotfiles bootstrap scripts clone the fork on a fresh machine, install runtime dependencies, run `apps/pi-extension/vendor.sh`, and fetch the browser HTML assets for the matching release.

The duplicate source under `dot_pi/agent/extensions/plannotator/` is removed only after the fork loads and passes parity tests.
This leaves one editable source tree and prevents duplicate extension registration.

## AGENTS and Pi prompt behavior

Pi already loads context in this order:

1. `~/.pi/agent/AGENTS.md` for global instructions.
2. Applicable AGENTS or CLAUDE files from ancestor directories while walking toward cwd.
3. The AGENTS or CLAUDE file in cwd.
4. `AGENTS.override.md` instead of same-directory AGENTS or CLAUDE content when present.

Plannotator does not return a `systemPrompt` override from `before_agent_start`.
It delivers narrow phase guidance as one-shot conversation messages, matching upstream `v0.27.4` behavior.
It never reconstructs the base prompt, copies AGENTS content into a separate prompt, or changes Pi's context-file order.
It respects `--no-context-files` rather than silently bypassing an explicit Pi setting.

Every Plannotator phase instruction states that applicable AGENTS and explicit user instructions are authoritative.
When an AGENTS instruction conflicts with the default plan location, the AGENTS instruction wins as long as the resulting plan is a Markdown file inside cwd.

## Plan location

The default plan location is:

```text
<cwd>/tmp/plans/<slug>.md
```

The model chooses a concise kebab-case slug from the task and reuses the same file across revisions.
The planning prompt, submit-tool description, errors, examples, documentation, and tests all use this default.

The location is a prompt default rather than a hardcoded natural-language parser.
An applicable AGENTS file or explicit user instruction may choose a different `.md` or `.mdx` path inside cwd.
Absolute paths outside cwd and traversal outside cwd remain rejected.

## Responsibilities retained by Plannotator

The fork retains only the workflow mechanics necessary to make review enforceable:

- `idle`, `planning`, `grilling`, and `executing` states.
- The `/plannotator` command, `--plan` flag, and Shift+Tab shortcut.
- The `plannotator_submit_plan` browser-review tool.
- The new `plannotator_finish_grill` completion tool.
- Pre-implementation mutation gates for known file-writing tools.
- Phase persistence and restoration across session lifecycle events.
- Existing browser, annotation, review, archive, sharing, and integration features.

The fork does not set the Pi model, thinking level, or active tool list.
Phase transitions do not disable, replace, or add general-purpose Pi tools.

## Pre-implementation mutation safety

While the phase is `planning` or `grilling`, Plannotator intercepts known direct file-mutation tools:

- Pi's built-in `write` tool.
- Pi's built-in `edit` tool.
- The installed `patch` tool.

Those tools may modify only `.md` or `.mdx` files inside cwd.
This preserves plan editing while blocking direct source-code edits before the gate opens.

Read, search, web, browser, todo, subagent, and other Pi tools remain active.
Bash and unknown third-party tools remain governed by Pi's system prompt, applicable AGENTS instructions, and user direction because safely classifying arbitrary commands or schemas is outside Plannotator's scope.

## State machine

### Idle to planning

`/plannotator`, `--plan`, or Shift+Tab enters `planning`.
Plannotator stores the current phase without capturing or replacing Pi's model, thinking, or active-tool state.

The appended planning guidance requires the agent to:

- Read applicable AGENTS instructions.
- Investigate code and documentation before asking factual questions.
- Write the plan under `tmp/plans/` by default.
- Use `ask_user_question` for unresolved preferences when it is active.
- Submit the plan through `plannotator_submit_plan`.
- Avoid implementation until the full review and grill gate completes.

### Planning to browser review

`plannotator_submit_plan` validates that the plan exists, is non-empty, is Markdown, and resolves inside cwd.
It opens the unchanged upstream browser review experience.

A denial keeps the phase at `planning` and returns annotations or feedback to Pi.
A dismissal keeps implementation locked and reports that no approval was received.
Print/JSON mode, missing HTML assets, or any other unavailable interactive-review condition fails closed in `planning`; the fork never auto-approves or hands off an unreviewed plan.

### Approval to grilling

Approval moves the phase to `grilling`, not `executing`.
Plannotator stores the approved plan path and a SHA-256 hash of its exact contents.
Approval notes are included in the grill context.

After the approving turn settles, Plannotator queues a follow-up message that starts the mandatory grill.
It never queues the current upstream message that immediately continues implementation.

### Human grill

During `grilling`, Pi must:

1. Read the approved plan.
2. Read applicable AGENTS instructions already present in Pi's context.
3. Read documentation and code relevant to the plan.
4. Resolve factual questions through investigation rather than asking the user.
5. Ask the user decision questions one at a time with `ask_user_question` when available.
6. Include a recommended answer for every decision question.
7. Incorporate every material resolved decision into the plan.
8. Ask the user to confirm shared understanding after all branches are resolved.

No implementation is allowed during this phase.

### Changed plan after grilling

If the plan changes during grilling, its content hash no longer matches the approved hash.
`plannotator_finish_grill` rejects completion and instructs the agent to resubmit the revised plan.
The browser review repeats against the same file, preserving Plannotator's version-diff behavior.
Every subsequent approval records a new approved hash and begins another grill.

### Unchanged plan after grilling

When the plan is unchanged and the user explicitly confirms shared understanding, the agent calls `plannotator_finish_grill` with the confirmation and a concise decision summary.
The tool verifies the phase, plan file, and approved hash before moving to `executing`.

The tool appends a persistent session entry containing the plan path, approved hash, and grill summary.
Its result tells Pi that implementation is now unlocked.

### Executing

The mutation gate is lifted in `executing`.
Pi continues with its existing tools, model, thinking level, AGENTS context, and skills.
Plannotator delivers plan progress through conversation messages and does not modify the base system prompt.

## Persistence and recovery

Persisted Plannotator state includes:

- Current phase.
- Submitted plan path.
- Approved plan hash.
- Approval notes needed by the grill.
- Completed grill summary when available.

State rebuild uses existing custom session entries and branch replay.
Reload, resume, fork, compaction, and tree navigation restore the latest valid state on the active branch.

If the plan file is missing or unreadable when restoring `planning` or `grilling`, Plannotator keeps implementation locked and asks for a new plan submission.
If the file changes outside Pi during `grilling`, the hash check still requires re-review.

## Model compatibility

The workflow uses Pi's provider-neutral extension APIs and simple TypeBox schemas.
It does not depend on provider-specific tool references, forced tool choice, prompt roles, or model-name checks.

Controlled verification covers the configured GPT-5.6 Sol, Terra, and Luna routes and the Claude Fable and Opus routes.

The current LiteLLM Claude routes fail before tool selection because Pi sends `reasoning_effort` to a backend that rejects it.
The dotfiles model definitions for Fable and Opus will set `compat.supportsReasoningEffort` to `false` so those requests reach the model.
This transport correction is required before claiming cross-model Plannotator compatibility.

## Upstream update strategy

The fork tracks stable upstream release tags rather than upstream main.
The repository gains an `upstream` remote pointing to `backnotprop/plannotator`.

For each update:

1. Fetch the selected upstream release tag.
2. Merge it into the fork's feature branch without rewriting history.
3. Resolve only conflicts in the isolated Pi workflow patch.
4. Run upstream tests and the fork-specific Pi tests.
5. Regenerate the Pi extension's vendored modules.
6. Fetch HTML assets at the same release version.
7. Run cross-model and browser workflow verification.
8. Update the dotfiles bootstrap pin only after verification passes.

## Verification

### Unit and integration tests

Tests cover:

- Base system prompt, AGENTS context, skills, and tool guidance surviving every phase.
- No calls to set Pi's model, thinking level, or active tools.
- Default `tmp/plans/<slug>.md` guidance and safe in-cwd AGENTS overrides.
- Rejection of absolute escapes, traversal, and non-Markdown plan paths.
- Planning and grilling mutation gates for `write`, `edit`, and `patch`.
- Approval entering `grilling` rather than `executing`.
- Approved SHA-256 capture.
- Changed-plan grill completion rejection.
- Revised-plan browser re-review.
- Unchanged-plan explicit confirmation entering `executing`.
- Branch-aware state restoration after reload, resume, compaction, and tree navigation.
- Browser dismissal keeping implementation locked.
- Print/JSON mode and missing browser assets failing closed without automatic approval or external handoff.
- Bun-backed upstream tests, typecheck, and Pi-extension build completing successfully.

### Model verification

Run the same controlled workflow with:

- GPT-5.6 Sol.
- GPT-5.6 Terra.
- GPT-5.6 Luna.
- Claude Fable.
- Claude Opus.

Each model must create or reuse the expected plan path, call the browser-review tool, remain in grilling after approval, ask one recommended decision question at a time, and avoid implementation before grill completion.

### Browser verification

Exercise the real browser UI for:

- Plan approval.
- Plan denial with annotations.
- Approval with notes.
- Changed-plan diff and re-review.
- Dismissal without approval.
- Final unchanged-plan approval followed by successful grill completion.

The browser UI itself is expected to remain upstream-identical.

### Dotfiles verification

Verify that:

- Pi loads exactly one Plannotator extension from the local fork path.
- A fresh-machine bootstrap clones and prepares the fork.
- The local package has generated modules, runtime dependencies, and matching HTML assets.
- The old deployed extension directory is absent.
- Scoped `chezmoi diff` is clean after apply.
- Existing unrelated dotfiles changes remain untouched.

## Rollback

Before removing the vendored extension, retain the current source diff until the fork passes all checks.
If the local package fails to load, remove its package-path entry and restore the prior chezmoi deployment.
No plan data under `~/.plannotator` is deleted during migration.
