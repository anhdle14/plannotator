import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";

type SessionEntry = { type: string; customType?: string; data?: unknown };
type Context = ReturnType<typeof createContext>;
type Handler = (event: unknown, context: Context) => unknown;

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	restoreEnv("HOME", originalHome);
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(): string {
	const home = mkdtempSync(join(tmpdir(), "plannotator-runtime-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "plannotator-runtime-cwd-"));
	tempDirs.push(home, cwd);
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	return cwd;
}

function createContext(options: { cwd?: string; entries?: SessionEntry[] } = {}) {
	const entries = options.entries ?? [];
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: true,
		isProjectTrusted: () => true,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			getSessionFile: () => undefined,
			getSessionId: () => "test-session",
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: {
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	};
}

function createRuntime(initialTools: string[]) {
	const commands = new Map<string, { handler: (args: string, context: Context) => unknown }>();
	const handlers = new Map<string, Handler[]>();
	const persisted: Array<Record<string, unknown>> = [];
	const calls = { setActiveTools: 0, setModel: 0, setThinkingLevel: 0 };
	const activeTools = [...initialTools];

	const pi = {
		appendEntry: (_type: string, data: Record<string, unknown>) => persisted.push(data),
		events: { on: () => () => undefined, emit: () => undefined },
		getFlag: () => false,
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (args: string, context: Context) => unknown }) => {
			commands.set(name, command);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerTool: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: () => {
			calls.setActiveTools += 1;
		},
		setModel: async () => {
			calls.setModel += 1;
			return true;
		},
		setThinkingLevel: () => {
			calls.setThinkingLevel += 1;
		},
	};

	plannotator(pi as never);
	return {
		commands,
		calls,
		activeTools,
		lastPersistedState: () => persisted.at(-1),
		run: async (event: string, context: Context) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context);
		},
	};
}

describe("Pi runtime state ownership", () => {
	test("entering and leaving planning preserves Pi tools, model, and thinking", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime(["read", "bash", "patch", "ask_user_question"]);
		const context = createContext({ cwd });
		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		expect(runtime.activeTools).toEqual(["read", "bash", "patch", "ask_user_question"]);
		expect(runtime.calls).toEqual({ setActiveTools: 0, setModel: 0, setThinkingLevel: 0 });
	});

	test("restoring and completing execution preserves Pi runtime state", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "tmp-plan.md"), "- [x] Step one\n", "utf-8");
		const runtime = createRuntime(["read", "bash", "edit", "todo"]);
		const context = createContext({
			cwd,
			entries: [{
				type: "custom",
				customType: "plannotator",
				data: { phase: "executing", lastSubmittedPath: "tmp-plan.md" },
			}],
		});

		await runtime.run("session_start", context);
		await runtime.run("agent_end", context);
		expect(runtime.activeTools).toEqual(["read", "bash", "edit", "todo"]);
		expect(runtime.calls).toEqual({ setActiveTools: 0, setModel: 0, setThinkingLevel: 0 });
		expect(runtime.lastPersistedState()).toMatchObject({ phase: "idle" });
	});
});
