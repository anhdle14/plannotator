# Plannotator for Pi

Plannotator integration for the [Pi coding agent](https://github.com/earendil-works/pi). Adds file-based plan mode with a visual browser UI for reviewing, annotating, and approving agent plans.

## Install

**From npm** (recommended):

```bash
pi install npm:@plannotator/pi-extension
```

**From source:**

```bash
git clone https://github.com/backnotprop/plannotator.git
pi install ./plannotator/apps/pi-extension
```

**Try without installing:**

```bash
pi -e npm:@plannotator/pi-extension
```

## Pi version and project trust

Plannotator requires **Pi 0.79.1 or newer**. Updating only the Plannotator
extension does not repair the security behavior of an older Pi host; update Pi
itself before loading the extension.

Pi 0.79 introduced project trust for repository-local inputs. In interactive
sessions, Pi asks before loading project settings, instructions, resources, and
packages, and can save the decision for that working directory. Plannotator
honors the same decision for `.pi/plannotator.json`.

Noninteractive sessions ignore project-local inputs unless the project already
has a saved trust decision or Pi is started with `--approve` (`-a`). Use
`--no-approve` (`-na`) to disable project inputs for a run even when the project
was previously trusted.

## Uninstall

Remove a standalone Pi installation with:

```bash
pi remove npm:@plannotator/pi-extension
```

If Pi was configured by the full Plannotator installer, `plannotator uninstall`
also detects and removes the extension through Pi.

## Build from source

If installing from a local clone, build the HTML assets first:

```bash
cd plannotator
bun install
bun run build:pi
```

This builds the plan review and code review UIs and copies them into `apps/pi-extension/`.

## Usage

### Plan mode

Start Pi in plan mode:

```bash
pi --plan
```

Toggle it during a session with `/plannotator-plan-mode`, `Ctrl+Alt+P`, or Shift+Tab.

Pi's global, ancestor, and cwd AGENTS files remain authoritative. Plannotator does not change the active model, thinking level, system prompt, or general-purpose tools. Known file mutation tools are limited to Markdown inside cwd until review and grilling finish.

Plans default to `<cwd>/tmp/plans/<descriptive-kebab-case-slug>.md`. An applicable AGENTS file or explicit user instruction may choose another Markdown path inside cwd.

The agent explores the codebase and relevant documentation, then writes a plan using markdown checklists:

```markdown
- [ ] Add validation to the login form
- [ ] Write tests for the new validation logic
- [ ] Update error messages in the UI
```

When the agent calls `plannotator_submit_plan`, the Plannotator UI opens in your browser. You can:

- **Approve** the plan to begin the mandatory human grill
- **Deny with annotations** to send structured feedback back to the agent
- **Approve with notes** to carry guidance into the grill

Approval never begins implementation directly. During grilling, Pi reads the approved plan, applicable AGENTS files, relevant docs, and code; resolves factual questions itself; and asks one recommended decision question at a time. If the plan changes, it must pass browser review again. An unchanged approved plan plus explicit shared-understanding confirmation unlocks execution through `plannotator_finish_grill`.

Print/JSON mode and missing browser assets fail closed. The fork never auto-approves or hands off an unreviewed plan. On resubmission, Plan Diff highlights what changed between versions.

### Plan templates

Start a plan from a template with `/plannotator <type> [intent]`, for example `/plannotator bug-investigation flaky gateway test`.
Run `/plannotator` with no arguments to list the available templates and where each one comes from.

The command writes the template to `tmp/plans/<YYYY-MM-DD>-<slug>.md`, enters planning, and asks the agent to fill that file in place and submit it.
The slug comes from the intent, or from the template name when no intent is given.
An existing plan file is never overwritten; the command adds `-2`, `-3`, and so on instead.
The command refuses to start a new plan while a plan is in grilling, execution, or review.

Built-in templates: `research-decision`, `bug-investigation`, `implementation`, `migration-rollout`, `refactor`, and `review`.
Templates are Markdown files resolved in this order, where a later layer overrides a file with the same name:

1. Built-in templates shipped in `templates/`.
1. User templates in `~/.pi/agent/plannotator/templates/*.md` (or `$PI_CODING_AGENT_DIR/plannotator/templates/`).
1. Project templates in `<cwd>/.pi/plannotator/templates/*.md`, loaded only when Pi trusts the project.

The file name without `.md` is the template type.
An optional `description:` front matter line provides the listing text and is removed from the scaffolded plan.
Templates support `{{date}}`, `{{intent}}`, and `{{owner}}` (Git `user.name`, falling back to the OS user); unknown placeholders are left as-is and reported.

### Programmatic plan-mode control

Other Pi extensions can enter, exit, toggle, or query Plannotator plan mode through the shared Pi event bus without invoking the `/plannotator-plan-mode` slash command:

```ts
import { PLANNOTATOR_REQUEST_CHANNEL } from "@plannotator/pi-extension/plannotator-events";

const response = await new Promise((resolve) => {
  pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
    requestId: crypto.randomUUID(),
    action: "plan-mode",
    payload: { mode: "enter" }, // "enter" | "exit" | "toggle" | "status"
    respond: resolve,
  });
});
```

A handled response returns the resulting phase, for example `{ status: "handled", result: { phase: "planning" } }`.

### Configuring per-phase behavior

Plannotator loads configuration in three layers:

1. Built-in base config shipped with the package: `plannotator.json`
2. Global user config: `~/.pi/agent/plannotator.json`
3. Project-local config: `<cwd>/.pi/plannotator.json`

Later layers overwrite earlier ones. If a field is omitted, it inherits the value from lower-precedence layers. `null` or an empty string clears an inherited value. You can also set `defaults` or an entire phase object to `null` to clear inherited settings.

#### Top-level shape

```json
{
  "executionMode": "automatic",
  "defaults": {
    "statusLabel": "Ready",
    "instructions": "Optional phase-entry message template"
  },
  "phases": {
    "planning": {
      "statusLabel": "⏸ plan",
      "instructions": "[PLANNING]\nPlan file: ${planFilePath}"
    },
    "grilling": {
      "statusLabel": "🔥 grill",
      "instructions": "[GRILLING]\nValidate ${planFilePath} against docs and code."
    },
    "executing": {
      "statusLabel": "",
      "instructions": "[EXECUTING]\nExecute ${planFilePath}.\n\nEntry checklist:\n${todoList}"
    }
  }
}
```

#### Option reference

| Option | Type | Meaning |
|--------|------|---------|
| `executionMode` | `automatic` \| `external` | After grill completion, `automatic` executes in the current Pi session and `external` emits a handoff event |
| `defaults` | object | Base values applied to every phase before phase-specific overrides |
| `phases` | object | Phase-specific overrides |
| `phases.planning` | object | Settings for planning mode |
| `phases.grilling` | object | Settings for the mandatory post-approval grill |
| `phases.executing` | object | Settings for execution mode |
| `phases.reviewing` | object | Reserved for future review-mode customization |
| `statusLabel` | string \| `null` | Optional UI label for the phase; empty/null clears it |
| `instructions` | string \| `null` | Phase framing template, delivered once as a hidden conversation message when the phase is entered; empty/null disables the framing message |

#### Prompt variables

Use these inside `instructions` strings. They render once, when the phase is entered:

- `${planFilePath}` — current plan file path
- `${todoList}` — remaining checklist items as markdown checkboxes (an entry-time snapshot; live updates arrive as separate per-turn messages)
- `${completedCount}` — completed checklist count
- `${totalCount}` — total checklist count
- `${remainingCount}` — remaining checklist count
- `${phase}` — current runtime phase (`planning`, `grilling`, `executing`, `reviewing`, or `idle`)

#### Behavior notes

- **Plannotator never modifies Pi's system prompt.** Pi's base prompt (AGENTS.md context, the skills catalog, tools guidance, `--append-system-prompt` text, working directory) always reaches the model untouched. Phase framing is injected as conversation messages instead, so prompt-cache invalidation reduces to appends at the tail of the conversation plus one history adjustment per phase transition.
- The `instructions` template is delivered exactly once per phase entry as a hidden message; later prompts in the same phase inject nothing. During execution, a small todo-status message is added per prompt as steps complete. Only the newest framing for the current phase is kept in model context: stale framing from other phases or earlier plan cycles is filtered out, and everything Plannotator injected is filtered while idle.
- Executing `instructions` that do not reference `${todoList}` get the entry-time todo snapshot appended automatically, so the first executing prompt always carries the checklist.
- The old `systemPrompt` config key is obsolete and ignored; a warning at session start points to `instructions`.
- Unknown template variables trigger a warning in the UI and are rendered as empty strings.
- Plannotator never calls Pi's model, thinking-level, or active-tool setters. The Pi runtime remains authoritative in every phase.
- The `model`, `thinking`, `thinkingLevel`, and `activeTools` config keys are ignored with a warning.
- Known `write`, `edit`, and `patch` calls are restricted to Markdown inside cwd during planning and grilling without disabling those tools.
- Browser approval records a SHA-256 hash and enters grilling. `plannotator_finish_grill` rejects a changed plan until browser re-review succeeds.
- Execution progress remains dynamic (`[DONE:n]` plus checklist tracking), even if `statusLabel` is set.
- `executionMode` defaults to `automatic`. Both automatic execution and external handoff occur only after grill completion.

#### Example files

- Built-in base config shipped with the package: `apps/pi-extension/plannotator.json`
- Global user override: `~/.pi/agent/plannotator.json`
- Project-local override: `<cwd>/.pi/plannotator.json`

### Model routing

Plannotator can route each plan phase to a model tier without choosing models itself.
It needs a Pi-Bifrost build that answers the `bifrost:lock` and `bifrost:release` events, and a System One server (`POST /v1/systemone`).
Routing is off by default; enable it with `modelRouting` in any config layer:

```json
{
  "modelRouting": {
    "enabled": true,
    "planningTier": "frontier",
    "phaseTiers": ["quick", "general", "frontier"],
    "systemOneUrl": "http://127.0.0.1:8008",
    "systemOneModel": "von-latest",
    "minProbability": 0.6,
    "reviewers": {
      "anthropic": "wovey/gpt-6.1-sol",
      "openai": "wovey/global.anthropic.claude-opus-5-5"
    }
  }
}
```

- Planning and grilling hold Bifrost on `planningTier`, and Plannotator asks Bifrost again before every prompt, so turning Bifrost routing off or pinning the session takes effect at once.
  If Bifrost cannot hold that tier, prompts are not sent and Plannotator shows the reason; exit plan mode to work without it.
- On submit, every `## Phase` to `#### Phase` section without a decided `- Model:` line gets one System One `score` question over that phase's own text; requests are sent one at a time.
  A Phase heading at any of those depths ends the previous phase, so a nested `### Phase 1.1` is its own phase.
  The answer is written into the plan as `- Model: <tier> (System One p=<x>)`, so the browser review shows it and you can edit it.
  Answers whose top tier probability is below `minProbability` become `- Model: undecided (...)` and the grill asks you to choose.
  An answer that does not give every tier a probability in [0, 1], summing to 1, counts as unreachable.
  If System One is unreachable, phases get `planningTier` with an explicit note.
  The plan is rewritten only if it still matches what was judged and still resolves inside the working directory; otherwise, or if you cancel, the submission fails and you resubmit.
  Delete a phase's Model line to have it judged again on the next submit.
- During execution, Plannotator locks the tier of the phase that holds the first open checklist step, and moves the lock when steps are marked `[DONE:n]` or ticked in the plan file; Bifrost still picks the model, filters unhealthy routes, and fails over.
  Lock failures during execution only warn, and Bifrost routes normally.
  A lock that Bifrost grants after Plannotator stopped waiting for it, or after plan mode ended, is released.
- Cross-vendor review: Plannotator counts planning turns and changed lines written per model.
  The execution prompt tells the agent to delegate review with an explicit `acp_delegate` model from the other vendor: `reviewers.anthropic` reviews Anthropic-written work, and `reviewers.openai` reviews OpenAI-written work.
  When both vendors wrote code, the vendor with fewer changed lines reviews, and the prompt flags it for confirmation.
- `criteria` overrides the tier descriptions sent to System One, keyed by tier name.
- Tier names use letters, digits, `_`, or `-`, start with a letter, and must be unique; `timeoutMs` is a whole number of milliseconds; an invalid field is ignored with a warning that names it.
- `planningTier` must be one of `phaseTiers`; otherwise Plannotator warns and turns routing off.
- `systemOneUrl` falls back to `SYSTEM_ONE_BASE_URL` when that is an http(s) URL, then loopback port 8008.

### Code review

Run `/plannotator-review` to open your current VCS changes in the code review UI. Annotate specific lines, switch between the modes supported by the detected Git, GitButler, or JJ provider, and submit feedback that gets sent to the agent. Pass `--git` or `--gitbutler` to force that provider; GitButler requires `but` 0.21.0 or newer on `PATH`.

### Shared Plannotator event API

Plannotator also listens on the shared `plannotator:request` event channel so other extensions can reuse the same browser review flows without importing Plannotator internals.

Supported actions and payloads:

- `plan-review`: `{ planContent, planFilePath? }`
- `review-status`: `{ reviewId }`
- `code-review`: `{ cwd?, defaultBranch?, diffType? }`
- `annotate`: `{ filePath, markdown?, mode?, folderPath? }`
- `annotate-last`: `{ markdown? }`
- `archive`: `{ customPlanPath? }`

Plan review is asynchronous:

- callers send `plannotator:request` with action `plan-review`
- Plannotator opens the browser review and immediately responds with `{ status: "handled", result: { status: "pending", reviewId } }`
- when the human approves or rejects in the browser, Plannotator emits `plannotator:review-result` with `{ reviewId, approved, feedback, savedPath?, agentSwitch?, permissionMode? }`
- callers can query `review-status` with the same `reviewId` to recover from startup races or session restarts

The other shared actions remain request/response flows. Payloads are intentionally minimal and only include fields the shared implementation actually uses.

#### External plan execution handoff

Set `executionMode` to `external` when another Pi extension should orchestrate a reviewed and grilled plan instead of executing it in the current session:

```json
{
  "executionMode": "external"
}
```

After browser approval and successful `plannotator_finish_grill`, Plannotator returns to idle and emits `plannotator:plan-approved` with:

```ts
{
  cwd: string;
  planFilePath: string;
  planContent: string;
  feedback?: string;
}
```

`planFilePath` is the path exactly as it was submitted, so it is normally relative to `cwd`. Resolve it against `cwd` before reading the file rather than against the companion extension's own working directory.

Companion extensions can subscribe through the shared event bus:

```ts
import { PLANNOTATOR_PLAN_APPROVED_CHANNEL } from "@plannotator/pi-extension/plannotator-events";
import { resolve } from "node:path";

pi.events.on(PLANNOTATOR_PLAN_APPROVED_CHANNEL, (event) => {
  const planPath = resolve(event.cwd, event.planFilePath);
  // Compile and dispatch the approved plan with an external orchestrator.
});
```

As with `plannotator:request`, the channel is a plain string, so a companion can listen with `pi.events.on("plannotator:plan-approved", ...)` and never import Plannotator internals. The constant and the `PlannotatorPlanApprovedEvent` type are exported purely as a typing convenience.

Plannotator does not enter its executing phase or track checklist progress in this mode. The companion extension owns execution after the reviewed plan completes grilling and the handoff fires.

### Markdown annotation

Run `/plannotator-annotate <file.md>` to open any markdown file in the annotation UI. Useful for reviewing documentation or design specs with the agent.

### Annotate last message

Run `/plannotator-last` to annotate the agent's most recent response. The message opens in the annotation UI where you can highlight text, add comments, and send structured feedback back to the agent.

### Archive browser

The Plannotator archive browser is available through the shared event API as `archive`, which opens the saved plan/decision browser for future callers. The orchestrator does not expose a dedicated archive command yet.

### Progress tracking

During execution, the agent marks completed steps with `[DONE:n]` markers. Progress is shown in the status line and as a checklist widget in the terminal.

## Commands

| Command | Description |
|---------|-------------|
| `/plannotator [<type> [intent]]` | List plan templates, or scaffold `tmp/plans/<date>-<slug>.md` from one and enter planning |
| `/plannotator-plan-mode` | Toggle plan mode. Plans default to `tmp/plans/<slug>.md` and require browser review plus grilling |
| `/plannotator-review` | Open code review UI for current changes |
| `/plannotator-annotate <file>` | Open markdown file in annotation UI |
| `/plannotator-last` | Annotate the last assistant message |

## Flags

| Flag | Description |
|------|-------------|
| `--plan` | Start in plan mode |

## Keyboard shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Alt+P` | Toggle plan mode |
| `Shift+Tab` | Toggle plan mode (fork customization) |

## How it works

The extension manages this state machine:

```text
idle -> planning -> browser review -> grilling -> executing -> idle
                          ^             |
                          | plan changed|
                          +-------------+
```

During **planning**:

- Pi's existing AGENTS context, tools, model, thinking level, and skills remain authoritative.
- Plans default to `tmp/plans/<slug>.md` unless AGENTS or the user chooses another in-cwd Markdown path.
- Known direct file mutation tools may only modify Markdown inside cwd.
- Browser review fails closed when interactive UI or assets are unavailable.

During **grilling**:

- The approved plan is checked against relevant docs and code.
- Factual questions are investigated; human decisions are asked one at a time with recommendations.
- The same Markdown mutation gate remains active.
- A changed plan must pass browser review again.
- An unchanged plan requires explicit user confirmation through `plannotator_finish_grill`.

During **executing**:

- The mutation gate is lifted without changing the Pi tool set.
- Progress is tracked through `[DONE:n]` markers.
- The plan is re-read from disk each turn.

State, approved plan hash, approval notes, and grill summary persist through Pi's `appendEntry` API.

## Requirements

- [Pi](https://github.com/earendil-works/pi) >= 0.79.1
- Bun for source builds, tests, and typechecking
