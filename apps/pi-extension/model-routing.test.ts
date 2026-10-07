import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyModelLines,
	BIFROST_LOCK_EVENT,
	BIFROST_RELEASE_EVENT,
	buildSystemOneRequest,
	chooseReviewer,
	classifyPhases,
	countWrittenLines,
	currentPhaseIndex,
	DEFAULT_MODEL_ROUTING,
	formatModelLine,
	LOCK_UNAVAILABLE_REASON,
	parsePlanPhases,
	releaseTierLock,
	requestTierLock,
	reviewerInstruction,
	vendorOf,
	writePlanIfUnchanged,
} from "./model-routing.ts";

const TIERS = DEFAULT_MODEL_ROUTING.phaseTiers;

const PLAN = `# Ship the thing

## Goal

Make the thing ship.

## Phase 1 - Bump versions

- [ ] Bump package.json

## Phase 2 - Design protocol

- Model: frontier (grill decision)

- [ ] Write the protocol
- [x] Review notes

\`\`\`md
## Phase 9 - not a heading
- Model: quick
\`\`\`

### Detail under phase 2

- [ ] Nested step

## Phase 3 - Docs

- Model: undecided (System One suggests general at p=0.40; decide in the grill)

- [ ] Update README

## Risks

- [ ] Not in a phase
`;

describe("parsePlanPhases", () => {
	test("finds phase sections, tiers, and undecided markers", () => {
		const phases = parsePlanPhases(PLAN, TIERS);
		expect(phases.map((phase) => phase.title)).toEqual(["Phase 1 - Bump versions", "Phase 2 - Design protocol", "Phase 3 - Docs"]);
		expect(phases.map((phase) => phase.assignedTier)).toEqual([undefined, "frontier", undefined]);
		expect(phases.map((phase) => phase.undecided)).toEqual([false, false, true]);
		expect(phases[1].body).toContain("Nested step");
		expect(phases[2].body).not.toContain("Not in a phase");
	});

	test("a nested Phase heading ends its parent so sections never overlap", () => {
		const plan = "## Phase 1\n\n- [ ] Parent step\n\n### Phase 1.1\n\n- Model: quick\n\n- [ ] Child step\n\n## Phase 2\n\n- Model: frontier\n\n- [ ] Later step\n";
		const phases = parsePlanPhases(plan, TIERS);
		expect(phases.map((phase) => phase.title)).toEqual(["Phase 1", "Phase 1.1", "Phase 2"]);
		expect(phases.map((phase) => phase.assignedTier)).toEqual([undefined, "quick", "frontier"]);
		expect(phases[0].body).toBe("- [ ] Parent step");
		expect(phases[0].endLine).toBe(phases[1].headingLine);
		expect(phases[1].endLine).toBe(phases[2].headingLine);
		expect([0, 1, 2].map((done) => currentPhaseIndex(plan, phases, new Set(Array.from({ length: done }, (_, i) => i + 1))))).toEqual([0, 1, 2]);
	});

	test("treats a Model line naming an unknown tier as undecided", () => {
		const [phase] = parsePlanPhases("## Phase 1\n\n- Model: gigantic\n", TIERS);
		expect(phase.assignedTier).toBeUndefined();
		expect(phase.undecided).toBe(true);
	});
});

describe("plan writes", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const workspace = () => {
		const root = mkdtempSync(join(tmpdir(), "plannotator-plan-write-"));
		dirs.push(root);
		mkdirSync(join(root, "cwd"));
		return { cwd: join(root, "cwd"), outside: join(root, "outside.md") };
	};

	test("replaces an unchanged plan atomically and refuses a changed one", () => {
		const { cwd } = workspace();
		const plan = join(cwd, "plan.md");
		writeFileSync(plan, "old");
		expect(writePlanIfUnchanged(cwd, plan, "old", "new")).toBeUndefined();
		expect(readFileSync(plan, "utf-8")).toBe("new");
		expect(writePlanIfUnchanged(cwd, plan, "old", "newer")).toContain("changed");
		expect(readFileSync(plan, "utf-8")).toBe("new");
		expect(readdirSync(cwd)).toEqual(["plan.md"]);
	});

	test("refuses a plan symlinked outside cwd and writes through an inside symlink to its target", () => {
		const { cwd, outside } = workspace();
		writeFileSync(outside, "secret");
		symlinkSync(outside, join(cwd, "escape.md"));
		expect(writePlanIfUnchanged(cwd, join(cwd, "escape.md"), "secret", "pwned")).toContain("outside the working directory");
		expect(readFileSync(outside, "utf-8")).toBe("secret");

		writeFileSync(join(cwd, "real.md"), "old");
		symlinkSync(join(cwd, "real.md"), join(cwd, "alias.md"));
		expect(writePlanIfUnchanged(cwd, join(cwd, "alias.md"), "old", "new")).toBeUndefined();
		expect(lstatSync(join(cwd, "alias.md")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(cwd, "real.md"), "utf-8")).toBe("new");
	});
});

describe("currentPhaseIndex", () => {
	test("returns the phase holding the first open checklist step", () => {
		const phases = parsePlanPhases(PLAN, TIERS);
		expect(currentPhaseIndex(PLAN, phases, new Set())).toBe(0);
		expect(currentPhaseIndex(PLAN, phases, new Set([1]))).toBe(1);
		expect(currentPhaseIndex(PLAN, phases, new Set([1, 2, 4]))).toBe(2);
		expect(currentPhaseIndex(PLAN, phases, new Set([1, 2, 4, 5]))).toBe(-1);
		expect(currentPhaseIndex(PLAN, phases, new Set([1, 2, 4, 5, 6]))).toBe(-1);
	});
});

describe("applyModelLines", () => {
	test("inserts a Model line under the heading or replaces the existing one", () => {
		const phases = parsePlanPhases(PLAN, TIERS);
		const updated = applyModelLines(PLAN, phases, new Map([
			[0, "- Model: quick (System One p=0.90)"],
			[2, "- Model: general (grill decision)"],
		]));
		const reparsed = parsePlanPhases(updated, TIERS);
		expect(reparsed.map((phase) => phase.assignedTier)).toEqual(["quick", "frontier", "general"]);
		expect(updated).toContain("## Phase 1 - Bump versions\n\n- Model: quick (System One p=0.90)\n\n- [ ] Bump package.json");
		expect(updated).toContain("- Model: quick\n```");
	});
});

describe("System One", () => {
	const settings = { ...DEFAULT_MODEL_ROUTING, enabled: true };
	const phases = parsePlanPhases(PLAN, TIERS).slice(0, 1);

	test("builds one score question per phase over that phase's text only", () => {
		const request = buildSystemOneRequest(phases[0], settings) as {
			model: string;
			state: string;
			questions: { tier: { type: string; criteria: string[] } };
		};
		expect(request.model).toBe("von-latest");
		expect(request.state).toBe("Phase 1 - Bump versions\n- [ ] Bump package.json");
		expect(request.questions.tier.type).toBe("score");
		expect(request.questions.tier.criteria).toEqual(TIERS.map((tier) => DEFAULT_MODEL_ROUTING.criteria[tier]));
	});

	const answer = (probabilities: number[], confidence: number) =>
		new Response(JSON.stringify({ answers: { tier: { type: "score", probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])), confidence } } }));

	test("maps the most probable level to a tier and gates it on that tier's probability, one request at a time", async () => {
		const two = parsePlanPhases(PLAN, TIERS).slice(0, 2);
		const replies = [answer([0.8, 0.15, 0.05], 0.2), answer([0.2, 0.45, 0.35], 0.12)];
		let inFlight = 0;
		let maxInFlight = 0;
		const fetchImpl = (async () => {
			maxInFlight = Math.max(maxInFlight, ++inFlight);
			await Bun.sleep(5);
			inFlight -= 1;
			return replies.shift()!;
		}) as unknown as typeof fetch;
		const judgments = await classifyPhases({ phases: two, settings, fetchImpl });
		expect(judgments).toEqual([
			{ kind: "assigned", tier: "quick", probability: 0.8 },
			{ kind: "uncertain", tier: "general", probability: 0.45 },
		]);
		expect(maxInFlight).toBe(1);
	});

	test("reports unavailable on HTTP errors, network errors, and bad answers", async () => {
		const httpError = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
		expect((await classifyPhases({ phases, settings, fetchImpl: httpError }))[0]).toEqual({
			kind: "unavailable",
			reason: "System One returned HTTP 503",
		});
		let calls = 0;
		const network = (async () => { calls += 1; throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
		const down = await classifyPhases({ phases: parsePlanPhases(PLAN, TIERS), settings, fetchImpl: network });
		expect(down.map((judgment) => judgment.kind)).toEqual(["unavailable", "unavailable", "unavailable"]);
		expect(calls).toBe(1);
		const bad = (async () => new Response(JSON.stringify({ answers: { tier: { probabilities: {}, confidence: 1 } } }))) as unknown as typeof fetch;
		expect((await classifyPhases({ phases, settings, fetchImpl: bad }))[0].kind).toBe("unavailable");
	});

	test("rejects incomplete, out-of-range, and unnormalized probabilities", async () => {
		for (const probabilities of [[2, -1, 0], [0.9, 0.1], [0.5, 0.2, 0.1], [0.7, 0.3, Number.NaN]]) {
			const fetchImpl = (async () => answer(probabilities, 0.9)) as unknown as typeof fetch;
			expect((await classifyPhases({ phases, settings, fetchImpl }))[0].kind).toBe("unavailable");
		}
		const nearlyOne = (async () => answer([0.701, 0.2, 0.1], 0.3)) as unknown as typeof fetch;
		expect((await classifyPhases({ phases, settings, fetchImpl: nearlyOne }))[0]).toEqual({ kind: "assigned", tier: "quick", probability: 0.701 });
	});

	test("rejects on caller cancellation instead of reporting System One unreachable", async () => {
		const controller = new AbortController();
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			controller.abort(new Error("user cancelled"));
			throw init.signal?.reason;
		}) as unknown as typeof fetch;
		await expect(classifyPhases({ phases, settings, fetchImpl, signal: controller.signal })).rejects.toThrow("user cancelled");
		let calls = 0;
		const counted = (async () => { calls += 1; return answer([0.8, 0.1, 0.1], 0.5); }) as unknown as typeof fetch;
		await expect(classifyPhases({ phases, settings, fetchImpl: counted, signal: AbortSignal.abort() })).rejects.toBeDefined();
		expect(calls).toBe(0);
	});

	test("formats Model lines that parse back to the same decision", () => {
		const lines = [
			formatModelLine({ kind: "assigned", tier: "general", probability: 0.8 }, "frontier"),
			formatModelLine({ kind: "uncertain", tier: "quick", probability: 0.4 }, "frontier"),
			formatModelLine({ kind: "unavailable", reason: "down" }, "frontier"),
		];
		const parsed = lines.map((line) => parsePlanPhases(`## Phase 1\n\n${line}\n`, TIERS)[0]);
		expect(parsed.map((phase) => phase.assignedTier)).toEqual(["general", undefined, "frontier"]);
		expect(parsed.map((phase) => phase.undecided)).toEqual([false, true, false]);
	});
});

describe("Bifrost tier lock", () => {
	test("resolves with Bifrost's reply", async () => {
		const sent: Array<{ channel: string; data: any }> = [];
		const events = {
			emit(channel: string, data: any) {
				sent.push({ channel, data });
				if (channel === BIFROST_LOCK_EVENT) data.reply({ ok: true, tier: data.tier, model: "wovey/x" });
			},
		};
		expect(await requestTierLock(events, "frontier")).toEqual({ ok: true, tier: "frontier", model: "wovey/x" });
		expect(sent[0].data.owner).toBe("plannotator");
		releaseTierLock(events);
		expect(sent[1]).toEqual({ channel: BIFROST_RELEASE_EVENT, data: { owner: "plannotator" } });
	});

	test("passes through rejections, rejects a wrong-tier ack, and times out when Bifrost is absent", async () => {
		const rejecting = { emit: (_channel: string, data: any) => data.reply({ ok: false, reason: "no healthy frontier route" }) };
		expect(await requestTierLock(rejecting, "frontier")).toEqual({ ok: false, reason: "no healthy frontier route" });
		const wrongTier = { emit: (_channel: string, data: any) => data.reply({ ok: true, tier: "quick" }) };
		expect(await requestTierLock(wrongTier, "frontier")).toEqual({ ok: false, reason: "Bifrost acknowledged tier quick instead of frontier" });
		const noTier = { emit: (_channel: string, data: any) => data.reply({ ok: true }) };
		expect((await requestTierLock(noTier, "frontier")).ok).toBe(false);
		expect(await requestTierLock({ emit() {} }, "frontier", { timeoutMs: 10 })).toEqual({ ok: false, reason: LOCK_UNAVAILABLE_REASON });
	});

	test("reports a reply that arrives after the timeout", async () => {
		let reply: ((result: unknown) => void) | undefined;
		const late: unknown[] = [];
		const events = { emit: (_channel: string, data: any) => { reply = data.reply; } };
		const result = await requestTierLock(events, "frontier", { timeoutMs: 10, onLateReply: (lateResult) => late.push(lateResult) });
		expect(result.ok).toBe(false);
		reply?.({ ok: true, tier: "frontier" });
		expect(late).toEqual([{ ok: true, tier: "frontier" }]);
	});
});

describe("cross-vendor review", () => {
	const reviewers = DEFAULT_MODEL_ROUTING.reviewers;

	test("classifies vendors from model keys", () => {
		expect(vendorOf("wovey/global.anthropic.claude-opus-5-5")).toBe("anthropic");
		expect(vendorOf("wovey/gpt-6.1-sol")).toBe("openai");
		expect(vendorOf("openai-codex/gpt-5.6-luna")).toBe("openai");
		expect(vendorOf("local/mlx-community/Qwen3.8-27B-4bit")).toBe("other");
	});

	test("picks the opposite vendor and flags mixed authorship", () => {
		expect(chooseReviewer({ planners: {}, builders: {} }, reviewers)).toBeUndefined();
		expect(chooseReviewer({ planners: { "wovey/global.anthropic.claude-opus-5-5": 3 }, builders: {} }, reviewers)?.model).toBe(reviewers.anthropic);
		expect(chooseReviewer({ planners: {}, builders: { "wovey/gpt-6.1-sol": 10 } }, reviewers)?.model).toBe(reviewers.openai);
		const mixed = chooseReviewer({
			planners: { "wovey/global.anthropic.claude-opus-5-5": 5 },
			builders: { "wovey/gpt-6.1-sol": 40, "wovey/global.anthropic.claude-opus-5-5": 10 },
		}, reviewers);
		expect(mixed?.model).toBe(reviewers.openai);
		expect(mixed?.flag).toContain("anthropic 10, openai 40");
		expect(reviewerInstruction(mixed)).toContain(`model "${reviewers.openai}"`);
	});

	test("counts written lines from write, edit, and patch inputs", () => {
		expect(countWrittenLines({ path: "a", content: "x\ny\nz" })).toBe(3);
		expect(countWrittenLines({ path: "a", edits: [{ old_str: "a", new_str: "b\nc" }, { old_str: "d", new_str: "" }] })).toBe(2);
		expect(countWrittenLines({ path: "a", oldText: "q", newText: "r" })).toBe(1);
	});
});
