import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";
import { BIFROST_LOCK_EVENT, BIFROST_RELEASE_EVENT, chooseReviewer, DEFAULT_MODEL_ROUTING, reviewerInstruction } from "./model-routing.ts";
import { isolateAgentDir } from "./test-setup/agent-dir.ts";

type LockPayload = { tier: string; owner: string; reply: (result: unknown) => void };
type Responder = (payload: LockPayload) => void;

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const ANTHROPIC = { provider: "wovey", id: "global.anthropic.claude-opus-5-5" };
const TWO_PHASE_PLAN = "# Plan\n\n## Phase 1 - Prep\n\n- Model: quick\n\n- [ ] Prep step\n\n## Phase 2 - Build\n\n- Model: general\n\n- [ ] Build step\n";
const UNROUTED_PLAN = "# Plan\n\n## Phase 1 - Prep\n\n- [ ] Prep step\n";

isolateAgentDir();

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.setTimeout = originalSetTimeout;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(plan?: string): string {
	const root = mkdtempSync(join(tmpdir(), "plannotator-routing-events-"));
	tempDirs.push(root);
	const cwd = join(root, "cwd");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "plannotator.json"), JSON.stringify({ modelRouting: { enabled: true } }));
	if (plan !== undefined) writeFileSync(join(cwd, "PLAN.md"), plan);
	return cwd;
}

const acknowledge: Responder = (payload) => payload.reply({ ok: true, tier: payload.tier });
const flush = () => new Promise((resolve) => originalSetTimeout(resolve, 0));

function executingEntries(extra: Record<string, unknown> = {}) {
	return [
		{ type: "custom", customType: "plannotator", data: { phase: "executing", lastSubmittedPath: "PLAN.md", ...extra } },
		{ type: "custom", customType: "plannotator-execute", data: {} },
	];
}

function createHarness(cwd: string, options: { entries?: unknown[]; startInPlan?: boolean; respond?: Responder } = {}) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const bus: Array<{ channel: string; tier?: string }> = [];
	const appended: Array<{ type: string; data: any }> = [];
	const notices: Array<{ message: string; level?: string }> = [];
	const entries = options.entries ?? [];
	const harness = { respond: options.respond ?? acknowledge };

	const pi = {
		events: {
			on: () => () => undefined,
			emit: (channel: string, payload: LockPayload) => {
				bus.push({ channel, ...(channel === BIFROST_LOCK_EVENT ? { tier: payload.tier } : {}) });
				if (channel === BIFROST_LOCK_EVENT) harness.respond(payload);
			},
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		getFlag: () => options.startInPlan === true,
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: () => undefined,
		setModel: async () => true,
		setThinkingLevel: () => undefined,
	};

	const ctx = {
		cwd,
		hasUI: false,
		model: ANTHROPIC,
		isProjectTrusted: () => true,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string, level?: string) => notices.push({ message, level }),
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	};

	const fire = async (event: string, payload: unknown) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
		return result;
	};

	return Object.assign(harness, {
		bus,
		appended,
		notices,
		ctx,
		fire,
		locks: () => bus.filter((event) => event.channel === BIFROST_LOCK_EVENT).map((event) => event.tier),
		lastBusEvent: () => bus.at(-1)?.channel,
		async start(): Promise<void> {
			plannotator(pi as never);
			await fire("session_start", { reason: "startup" });
		},
		prompt: (text = "do the work") => fire("input", { text, source: "interactive" }),
		togglePlanMode: () => commands.get("plannotator-plan-mode")!.handler("", ctx),
		submitPlan: (signal?: AbortSignal) => tools.get("plannotator_submit_plan")!.execute("submit", { filePath: "PLAN.md" }, signal, undefined, ctx),
		assistantSays: (text: string) => fire("turn_end", { message: { role: "assistant", content: [{ type: "text", text }] } }),
	});
}

function judgeReplies(...probabilities: number[][]) {
	const calls: unknown[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		calls.push(JSON.parse(String(init.body)));
		const levels = probabilities[calls.length - 1];
		return new Response(JSON.stringify({ answers: { tier: { type: "score", probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])), confidence: 0.3 } } }));
	}) as unknown as typeof fetch;
	return calls;
}

describe("planning tier lock", () => {
	test("acquires the planning tier and revalidates it on every prompt", async () => {
		const harness = createHarness(workspace(), { startInPlan: true });
		await harness.start();
		expect(harness.locks()).toEqual(["frontier"]);
		expect(await harness.prompt()).toBeUndefined();
		expect(await harness.prompt()).toBeUndefined();
		expect(harness.locks()).toEqual(["frontier", "frontier", "frontier"]);
		expect(await harness.prompt("/plannotator-plan-mode")).toBeUndefined();
		expect(harness.locks()).toHaveLength(3);
	});

	test("holds prompts back once Bifrost routing is turned off or the session is pinned", async () => {
		const harness = createHarness(workspace(), { startInPlan: true });
		await harness.start();
		for (const reason of ["Bifrost routing is off", "delegate sessions stay pinned to the model they were launched with"]) {
			harness.respond = (payload) => payload.reply({ ok: false, reason });
			expect(await harness.prompt()).toEqual({ action: "handled" });
			expect(harness.notices.at(-1)).toEqual({ message: expect.stringContaining(reason), level: "error" });
			expect(harness.lastBusEvent()).toBe(BIFROST_RELEASE_EVENT);
		}
		harness.respond = acknowledge;
		expect(await harness.prompt()).toBeUndefined();
	});

	test("rejects an ack for a different tier and releases it", async () => {
		const harness = createHarness(workspace(), { startInPlan: true, respond: (payload) => payload.reply({ ok: true, tier: "quick" }) });
		await harness.start();
		expect(harness.lastBusEvent()).toBe(BIFROST_RELEASE_EVENT);
		expect(await harness.prompt()).toEqual({ action: "handled" });
		expect(harness.notices.at(-1)).toEqual({ message: expect.stringContaining("acknowledged tier quick instead of frontier"), level: "error" });
		expect(harness.lastBusEvent()).toBe(BIFROST_RELEASE_EVENT);
	});

	test("releases a lock that Bifrost grants only after plan mode was exited", async () => {
		let pending: LockPayload | undefined;
		const harness = createHarness(workspace(), { respond: (payload) => { pending = payload; } });
		await harness.start();
		const entering = harness.togglePlanMode();
		await flush();
		const exiting = harness.togglePlanMode();
		await flush();
		expect(harness.lastBusEvent()).toBe(BIFROST_LOCK_EVENT);
		pending!.reply({ ok: true, tier: "frontier" });
		await Promise.all([entering, exiting]);
		expect(harness.bus.map((event) => event.channel)).toEqual([BIFROST_LOCK_EVENT, BIFROST_RELEASE_EVENT]);
	});

	test("releases a lock whose grant arrives after the request timed out", async () => {
		globalThis.setTimeout = ((fn: () => void, delay?: number) => originalSetTimeout(fn, delay === 5_000 ? 5 : delay)) as typeof setTimeout;
		let pending: LockPayload | undefined;
		const harness = createHarness(workspace(), { startInPlan: true, respond: (payload) => { pending = payload; } });
		await harness.start();
		expect(harness.bus.map((event) => event.channel)).toEqual([BIFROST_LOCK_EVENT, BIFROST_RELEASE_EVENT]);
		await harness.togglePlanMode();
		const released = harness.bus.length;
		pending!.reply({ ok: true, tier: "frontier" });
		await flush();
		await flush();
		expect(harness.bus.slice(released).map((event) => event.channel)).toEqual([BIFROST_RELEASE_EVENT]);
	});

	test("releases on session shutdown and on navigating to a branch outside plan mode", async () => {
		const entries: unknown[] = [];
		const harness = createHarness(workspace(), { startInPlan: true, entries });
		await harness.start();
		entries.push({ type: "custom", customType: "plannotator", data: { phase: "idle" } });
		await harness.fire("session_tree", {});
		expect(harness.bus.map((event) => event.channel)).toEqual([BIFROST_LOCK_EVENT, BIFROST_RELEASE_EVENT]);
		entries.push({ type: "custom", customType: "plannotator", data: { phase: "planning" } });
		await harness.fire("session_tree", {});
		expect(harness.lastBusEvent()).toBe(BIFROST_LOCK_EVENT);
		await harness.fire("session_shutdown", {});
		await flush();
		expect(harness.lastBusEvent()).toBe(BIFROST_RELEASE_EVENT);
	});
});

describe("execution tier lock", () => {
	test("locks the first open phase's tier and advances it as checklist steps complete", async () => {
		const cwd = workspace(TWO_PHASE_PLAN);
		const harness = createHarness(cwd, { entries: executingEntries() });
		await harness.start();
		expect(harness.locks()).toEqual(["quick"]);
		await harness.prompt();
		expect(harness.locks()).toEqual(["quick"]);
		await harness.assistantSays("Prep is finished. [DONE:1]");
		expect(harness.locks()).toEqual(["quick", "general"]);
		await harness.assistantSays("[DONE:2]");
		expect(harness.lastBusEvent()).toBe(BIFROST_RELEASE_EVENT);
	});

	test("follows a checklist ticked on disk before the next prompt", async () => {
		const cwd = workspace(TWO_PHASE_PLAN);
		const harness = createHarness(cwd, { entries: executingEntries() });
		await harness.start();
		writeFileSync(join(cwd, "PLAN.md"), TWO_PHASE_PLAN.replace("- [ ] Prep step", "- [x] Prep step"));
		await harness.prompt();
		expect(harness.locks()).toEqual(["quick", "general"]);
	});

	test("adds the cross-vendor reviewer to the first execution prompt from the bundled template", async () => {
		const usage = { planners: { "wovey/global.anthropic.claude-opus-5-5": 4 }, builders: {} };
		const harness = createHarness(workspace(TWO_PHASE_PLAN), { entries: executingEntries({ modelUsage: usage }) });
		await harness.start();
		const result = await harness.fire("before_agent_start", {}) as { message: { customType: string; content: string } };
		expect(result.message.customType).toBe("plannotator-framing");
		expect(result.message.content).toContain(reviewerInstruction(chooseReviewer(usage, DEFAULT_MODEL_ROUTING.reviewers))!);
		expect(result.message.content).toContain(DEFAULT_MODEL_ROUTING.reviewers.anthropic);
	});
});

describe("model usage persistence", () => {
	test("persisted and restored usage never alias the live counters", async () => {
		const stored = { planners: { "openai-codex/gpt-5.6-luna": 2 }, builders: {} };
		const entries = [{ type: "custom", customType: "plannotator", data: { phase: "planning", modelUsage: stored } }];
		const harness = createHarness(workspace(), { entries });
		await harness.start();
		await harness.fire("before_agent_start", {});
		expect(stored).toEqual({ planners: { "openai-codex/gpt-5.6-luna": 2 }, builders: {} });
		await harness.fire("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
		const snapshot = harness.appended.filter((entry) => entry.type === "plannotator").at(-1)!.data.modelUsage;
		expect(snapshot.planners["wovey/global.anthropic.claude-opus-5-5"]).toBe(1);
		await harness.fire("before_agent_start", {});
		expect(snapshot.planners["wovey/global.anthropic.claude-opus-5-5"]).toBe(1);
	});
});

describe("plan submission routing", () => {
	test("writes System One tiers into the plan before review", async () => {
		const cwd = workspace(UNROUTED_PLAN);
		const calls = judgeReplies([0.8, 0.15, 0.05]);
		const harness = createHarness(cwd, { startInPlan: true });
		await harness.start();
		await harness.submitPlan();
		expect(calls).toHaveLength(1);
		expect(readFileSync(join(cwd, "PLAN.md"), "utf-8")).toContain("- Model: quick (System One p=0.80)");
	});

	test("fails the submission instead of overwriting an edit made while System One was judging", async () => {
		const cwd = workspace(UNROUTED_PLAN);
		const edited = `${UNROUTED_PLAN}\n- [ ] Added during judging\n`;
		globalThis.fetch = (async () => {
			writeFileSync(join(cwd, "PLAN.md"), edited);
			return new Response(JSON.stringify({ answers: { tier: { type: "score", probabilities: { 0: 0.8, 1: 0.1, 2: 0.1 }, confidence: 0.3 } } }));
		}) as unknown as typeof fetch;
		const harness = createHarness(cwd, { startInPlan: true });
		await harness.start();
		const result = await harness.submitPlan() as { content: Array<{ text: string }>; details: { approved: boolean } };
		expect(result.details.approved).toBe(false);
		expect(result.content[0].text).toContain("changed");
		expect(readFileSync(join(cwd, "PLAN.md"), "utf-8")).toBe(edited);
	});

	test("refuses to route a plan symlinked outside the working directory", async () => {
		const cwd = workspace();
		const outside = join(cwd, "..", "outside.md");
		writeFileSync(outside, UNROUTED_PLAN);
		symlinkSync(outside, join(cwd, "PLAN.md"));
		const calls = judgeReplies([0.8, 0.15, 0.05]);
		const harness = createHarness(cwd, { startInPlan: true });
		await harness.start();
		const result = await harness.submitPlan() as { content: Array<{ text: string }>; details: { approved: boolean } };
		expect(result.details.approved).toBe(false);
		expect(result.content[0].text).toContain("outside the working directory");
		expect(calls).toHaveLength(0);
		expect(readFileSync(outside, "utf-8")).toBe(UNROUTED_PLAN);
	});

	test("refuses to follow a symlink swapped in for the plan while System One was judging", async () => {
		const cwd = workspace(UNROUTED_PLAN);
		const outside = join(cwd, "..", "outside.md");
		writeFileSync(outside, UNROUTED_PLAN);
		globalThis.fetch = (async () => {
			rmSync(join(cwd, "PLAN.md"));
			symlinkSync(outside, join(cwd, "PLAN.md"));
			return new Response(JSON.stringify({ answers: { tier: { type: "score", probabilities: { 0: 0.8, 1: 0.1, 2: 0.1 }, confidence: 0.3 } } }));
		}) as unknown as typeof fetch;
		const harness = createHarness(cwd, { startInPlan: true });
		await harness.start();
		const result = await harness.submitPlan() as { content: Array<{ text: string }>; details: { approved: boolean } };
		expect(result.details.approved).toBe(false);
		expect(result.content[0].text).toContain("outside the working directory");
		expect(readFileSync(outside, "utf-8")).toBe(UNROUTED_PLAN);
	});

	test("treats cancellation as a cancelled submission, not an unreachable judge", async () => {
		const cwd = workspace(UNROUTED_PLAN);
		const controller = new AbortController();
		globalThis.fetch = (async () => {
			controller.abort(new Error("user cancelled"));
			throw new Error("aborted");
		}) as unknown as typeof fetch;
		const harness = createHarness(cwd, { startInPlan: true });
		await harness.start();
		const result = await harness.submitPlan(controller.signal) as { content: Array<{ text: string }>; details: { approved: boolean } };
		expect(result.details.approved).toBe(false);
		expect(result.content[0].text).toContain("cancelled");
		expect(readFileSync(join(cwd, "PLAN.md"), "utf-8")).toBe(UNROUTED_PLAN);
		expect(harness.notices.some((notice) => notice.message.includes("System One"))).toBe(false);
	});
});
