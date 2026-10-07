import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import plannotator from "./index.ts";

type Context = ReturnType<typeof createContext>;
type Handler = (event: unknown, context: Context) => unknown;
type Tool = {
	name: string;
	description: string;
	parameters: { properties: { filePath: { description: string } } };
	execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: Context) => Promise<{
		content: Array<{ text: string }>;
		details: Record<string, unknown>;
	}>;
};

const savedEnv = {
	GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
	GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
	HOME: process.env.HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
let base: string;
let mainDir: string;
let linkedDir: string;
let storeRoot: string;
let agentDir: string;

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createContext(cwd: string) {
	return {
		cwd,
		hasUI: false,
		isProjectTrusted: () => false,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionFile: () => undefined,
			getSessionId: () => "plan-store-session",
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { bold: (text: string) => text, fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	};
}

function createRuntime() {
	const commands = new Map<string, { handler: (args: string, context: Context) => unknown }>();
	const handlers = new Map<string, Handler[]>();
	const registrations: Tool[] = [];
	const userMessages: string[] = [];
	const pi = {
		appendEntry: () => undefined,
		events: { on: () => () => undefined, emit: () => undefined },
		getFlag: () => false,
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, command: { handler: (args: string, context: Context) => unknown }) => commands.set(name, command),
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerTool: (tool: Tool) => registrations.push(tool),
		sendMessage: () => undefined,
		sendUserMessage: (content: string) => userMessages.push(content),
	};
	plannotator(pi as never);
	const submitTool = () => registrations.filter((tool) => tool.name === "plannotator_submit_plan").at(-1) as Tool;
	return {
		commands,
		registrations,
		userMessages,
		submitTool,
		run: async (event: string, payload: unknown, context: Context) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, context));
			return results;
		},
	};
}

function writeGlobalConfig(config: unknown): void {
	writeFileSync(join(agentDir, "plannotator.json"), JSON.stringify(config), "utf-8");
}

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	base = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-plan-store-runtime-")));
	mainDir = join(base, "myrepo");
	linkedDir = join(base, "wt-feat-x");
	storeRoot = join(base, "store");
	agentDir = join(base, "home", ".pi", "agent");
	mkdirSync(mainDir);
	mkdirSync(agentDir, { recursive: true });
	process.env.HOME = join(base, "home");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	git(mainDir, "init", "-q", "-b", "trunk");
	git(mainDir, "-c", "commit.gpgSign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");
	git(mainDir, "worktree", "add", "-q", "-b", "feat/x", linkedDir);
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("plan store in the Pi runtime", () => {
	test("a linked worktree scaffolds, writes, and submits plans in its store dir", async () => {
		writeGlobalConfig({ planStore: { root: storeRoot } });
		const ownDir = join(storeRoot, "myrepo", "feat", "x");
		const sharedDir = join(storeRoot, "myrepo", "main");
		const runtime = createRuntime();
		const context = createContext(linkedDir);
		await runtime.run("session_start", {}, context);

		const submit = runtime.submitTool();
		expect(runtime.registrations.filter((tool) => tool.name === "plannotator_submit_plan")).toHaveLength(2);
		expect(submit.description).toContain(join(ownDir, "<descriptive-kebab-case-slug>.md"));
		expect(submit.description).toContain(sharedDir);
		expect(submit.parameters.properties.filePath.description).toContain(join(storeRoot, "myrepo"));

		expect(existsSync(ownDir)).toBe(false);
		await runtime.commands.get("plannotator")?.handler("implementation shared store", context);
		const prompt = runtime.userMessages.at(-1) ?? "";
		const scaffold = /scaffold from the built-in template is at (.+\.md)\./.exec(prompt)?.[1] ?? "";
		expect(isAbsolute(scaffold)).toBe(true);
		expect(scaffold.startsWith(`${ownDir}/`)).toBe(true);
		expect(existsSync(scaffold)).toBe(true);
		expect(existsSync(join(linkedDir, "tmp"))).toBe(false);

		const gate = async (path: string) => (await runtime.run("tool_call", { toolName: "write", input: { path } }, context))[0];
		expect(await gate(scaffold)).toBeUndefined();
		expect(await gate(join(sharedDir, "shared.md"))).toBeUndefined();
		expect(await gate("tmp/plans/local.md")).toBeUndefined();
		expect(await gate(join(storeRoot, "otherrepo", "main", "plan.md"))).toMatchObject({
			block: true,
			reason: expect.stringContaining(`inside cwd or ${join(storeRoot, "myrepo")}`),
		});
		expect(await gate(join(ownDir, "notes.ts"))).toMatchObject({ block: true });

		const framing = (await runtime.run("before_agent_start", {}, context))[0] as { message: { content: string } };
		expect(framing.message.content).toContain(`- Plan store: write new plans to ${join(ownDir, "<descriptive-kebab-case-slug>.md")}`);

		writeFileSync(scaffold, "# Plan\n\n- [ ] Step one\n", "utf-8");
		const accepted = await submit.execute("1", { filePath: scaffold }, undefined, undefined, context);
		expect(accepted.details).toMatchObject({ approved: false, reviewUnavailable: true });

		mkdirSync(join(storeRoot, "otherrepo"), { recursive: true });
		writeFileSync(join(storeRoot, "otherrepo", "plan.md"), "# Other\n", "utf-8");
		const rejected = await submit.execute("2", { filePath: join(storeRoot, "otherrepo", "plan.md") }, undefined, undefined, context);
		expect(rejected.content[0].text).toContain(`inside the working directory or the plan store ${join(storeRoot, "myrepo")}`);
		const missing = await submit.execute("3", {}, undefined, undefined, context);
		expect(missing.content[0].text).toContain(`(default: "${join(ownDir, "<slug>.md")}")`);
	});

	test("without a plan store the runtime keeps plans in cwd", async () => {
		writeGlobalConfig({});
		const runtime = createRuntime();
		const context = createContext(linkedDir);
		await runtime.run("session_start", {}, context);
		expect(runtime.registrations.filter((tool) => tool.name === "plannotator_submit_plan")).toHaveLength(1);
		expect(runtime.submitTool().description).toContain("Use tmp/plans/<descriptive-kebab-case-slug>.md by default");

		await runtime.commands.get("plannotator")?.handler("implementation local plan", context);
		const scaffold = /scaffold from the built-in template is at (.+\.md)\./.exec(runtime.userMessages.at(-1) ?? "")?.[1] ?? "";
		expect(scaffold.startsWith("tmp/plans/")).toBe(true);
		expect(readFileSync(join(linkedDir, scaffold), "utf-8").length).toBeGreaterThan(0);

		const blocked = (await runtime.run("tool_call", { toolName: "write", input: { path: join(storeRoot, "myrepo", "main", "plan.md") } }, context))[0];
		expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("limited to markdown files inside cwd. Blocked:") });
		const framing = (await runtime.run("before_agent_start", {}, context))[0] as { message: { content: string } };
		expect(framing.message.content).not.toContain("Plan store");
	});
});
