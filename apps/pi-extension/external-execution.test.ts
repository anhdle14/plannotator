import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";
import { hashPlanContent } from "./grill.ts";
import { PLANNOTATOR_PLAN_APPROVED_CHANNEL } from "./plannotator-events.ts";

const tempDirs: string[] = [];
const PLAN_CONTENT = "# Plan\n\n- [ ] Implement the change\n";

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePlannotatorConfig(cwd: string, config: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "plannotator.json"), JSON.stringify(config));
}

function grillingEntry() {
	return {
		type: "custom",
		customType: "plannotator",
		data: {
			phase: "grilling",
			lastSubmittedPath: "PLAN.md",
			approvedPlanHash: hashPlanContent(PLAN_CONTENT),
		},
	};
}

function createHarness(cwd: string, options: { entries?: unknown[]; startInPlan?: boolean } = {}) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const appendedEntries: Array<{ type: string; data: unknown }> = [];
	const branchEntries = options.entries ?? [];
	const state = {
		activeTools: ["read", "bash", "edit", "write"],
		thinkingLevel: "medium",
		selectedModel: { provider: "test", id: "original-model" },
	};

	const pi = {
		events: {
			on: () => () => undefined,
			emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: () => undefined,
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		getFlag: () => options.startInPlan === true,
		appendEntry: (type: string, data: unknown) => appendedEntries.push({ type, data }),
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: (tools: string[]) => { state.activeTools = [...tools]; },
		setModel: async (model: { provider: string; id: string }) => {
			state.selectedModel = model;
			return true;
		},
		setThinkingLevel: (level: string) => { state.thinkingLevel = level; },
	};

	const ctx = {
		cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => branchEntries,
			getEntries: () => branchEntries,
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	};

	return {
		tools,
		handlers,
		emitted,
		appendedEntries,
		state,
		async startSession(): Promise<void> {
			plannotator(pi as never);
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
		},
		submitPlan(filePath: string) {
			return tools.get("plannotator_submit_plan")!.execute("submit", { filePath }, undefined, undefined, ctx);
		},
		finishGrill() {
			return tools.get("plannotator_finish_grill")!.execute(
				"finish",
				{ confirmed: true, summary: "All decisions resolved." },
				undefined,
				undefined,
				ctx,
			);
		},
	};
}

describe("review and grill execution gates", () => {
	test("noninteractive submission fails closed without handoff", async () => {
		const cwd = makeTempDir("plannotator-fail-closed-");
		writePlannotatorConfig(cwd, { executionMode: "external" });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		const harness = createHarness(cwd, { startInPlan: true });
		await harness.startSession();

		const result = await harness.submitPlan("PLAN.md") as {
			details: { approved: boolean; reviewUnavailable?: boolean };
		};
		expect(result.details).toEqual({ approved: false, reviewUnavailable: true });
		expect(harness.emitted).toEqual([]);
		expect(harness.appendedEntries.some((entry) => entry.type === "plannotator-execute")).toBe(false);
		expect(harness.appendedEntries.some((entry) => entry.type === "plannotator-handoff")).toBe(false);
	});

	test("external handoff occurs only after grill completion", async () => {
		const cwd = makeTempDir("plannotator-external-grill-");
		writePlannotatorConfig(cwd, { executionMode: "external" });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		const harness = createHarness(cwd, { entries: [grillingEntry()] });
		await harness.startSession();

		const result = await harness.finishGrill() as {
			details: { completed: boolean; handedOff?: boolean };
			terminate?: boolean;
		};
		expect(result.details).toMatchObject({ completed: true, handedOff: true });
		expect(result.terminate).toBe(true);
		expect(harness.emitted).toContainEqual({
			channel: PLANNOTATOR_PLAN_APPROVED_CHANNEL,
			payload: { cwd, planFilePath: "PLAN.md", planContent: PLAN_CONTENT },
		});
		expect(harness.appendedEntries).toContainEqual({
			type: "plannotator-handoff",
			data: { planFilePath: "PLAN.md" },
		});
	});

	test("automatic execution unlocks only after grill completion", async () => {
		const cwd = makeTempDir("plannotator-automatic-grill-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		const harness = createHarness(cwd, { entries: [grillingEntry()] });
		await harness.startSession();

		const result = await harness.finishGrill() as {
			details: { completed: boolean; planFilePath?: string };
		};
		expect(result.details).toMatchObject({ completed: true, planFilePath: "PLAN.md" });
		expect(harness.emitted).toEqual([]);
		expect(harness.appendedEntries.some((entry) => entry.type === "plannotator-handoff")).toBe(false);
		expect(harness.appendedEntries).toContainEqual({
			type: "plannotator-grill-complete",
			data: {
				planFilePath: "PLAN.md",
				approvedPlanHash: hashPlanContent(PLAN_CONTENT),
				grillSummary: "All decisions resolved.",
			},
		});
		expect((harness.appendedEntries.at(-1)?.data as { phase?: string }).phase).toBe("executing");
		expect(harness.state).toEqual({
			activeTools: ["read", "bash", "edit", "write"],
			thinkingLevel: "medium",
			selectedModel: { provider: "test", id: "original-model" },
		});
	});
});
