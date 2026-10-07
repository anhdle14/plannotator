import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePlanTarget, writePlanIfUnchanged } from "./model-routing.ts";
import {
	normalizePlanInputPath,
	type PlanStore,
	planStoreRoots,
	planStoreRule,
	resolvePlanStore,
	submitPlanToolText,
} from "./plan-store.ts";
import { isPlanWritePathAllowed } from "./tool-scope.ts";

const savedEnv = {
	GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
	GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
let base: string;
let mainDir: string;
let linkedDir: string;
let detachedDir: string;
let storeRoot: string;
let outsideDir: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function restoreEnv(key: keyof typeof savedEnv): void {
	if (savedEnv[key] === undefined) delete process.env[key];
	else process.env[key] = savedEnv[key];
}

function storeFor(cwd: string): PlanStore {
	const store = resolvePlanStore(cwd, { planStore: { root: storeRoot } });
	if (!store) throw new Error(`no plan store for ${cwd}`);
	return store;
}

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	base = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-plan-store-")));
	mainDir = join(base, "myrepo");
	linkedDir = join(base, "wt-feat-x");
	detachedDir = join(base, "wt-detached");
	storeRoot = join(base, "store");
	outsideDir = join(base, "outside");
	mkdirSync(mainDir);
	mkdirSync(outsideDir);
	git(mainDir, "init", "-q", "-b", "trunk");
	git(mainDir, "-c", "commit.gpgSign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");
	git(mainDir, "worktree", "add", "-q", "-b", "feat/x", linkedDir);
	git(mainDir, "worktree", "add", "-q", "--detach", detachedDir);
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	restoreEnv("GIT_CONFIG_GLOBAL");
	restoreEnv("GIT_CONFIG_NOSYSTEM");
});

describe("resolvePlanStore", () => {
	test("is off without a configured root or outside a git repository", () => {
		expect(resolvePlanStore(mainDir, {})).toBeUndefined();
		expect(resolvePlanStore(mainDir, { planStore: null })).toBeUndefined();
		expect(resolvePlanStore(mainDir, { planStore: {} })).toBeUndefined();
		expect(resolvePlanStore(outsideDir, { planStore: { root: storeRoot } })).toBeUndefined();
	});

	test("keys every worktree by the main worktree basename", () => {
		for (const cwd of [mainDir, linkedDir, detachedDir]) {
			const store = storeFor(cwd);
			expect(store.root).toBe(storeRoot);
			expect(store.repo).toBe("myrepo");
			expect(store.repoDir).toBe(join(storeRoot, "myrepo"));
			expect(store.sharedDir).toBe(join(storeRoot, "myrepo", "main"));
		}
	});

	test("the main checkout owns the shared dir regardless of its branch, also from a subdirectory", () => {
		mkdirSync(join(mainDir, "src"), { recursive: true });
		expect(storeFor(mainDir).ownDir).toBe(join(storeRoot, "myrepo", "main"));
		expect(storeFor(join(mainDir, "src")).ownDir).toBe(join(storeRoot, "myrepo", "main"));
	});

	test("a linked worktree owns a nested dir for its branch", () => {
		expect(storeFor(linkedDir).ownDir).toBe(join(storeRoot, "myrepo", "feat", "x"));
	});

	test("a detached worktree owns a dir named by its short SHA", () => {
		const sha = git(detachedDir, "rev-parse", "--short", "HEAD");
		expect(storeFor(detachedDir).ownDir).toBe(join(storeRoot, "myrepo", sha));
	});

	test("expands a ~/ root and never creates directories", () => {
		const name = `.plannotator-plan-store-test-${process.pid}-${Date.now()}`;
		const store = resolvePlanStore(linkedDir, { planStore: { root: `~/${name}` } });
		expect(store?.root).toBe(join(homedir(), name));
		expect(store?.ownDir).toBe(join(homedir(), name, "myrepo", "feat", "x"));
		expect(existsSync(join(homedir(), name))).toBe(false);
	});
});

describe("plan path allowance with a plan store", () => {
	test("allows the worktree's own dir, the shared main dir, and cwd", () => {
		const store = storeFor(linkedDir);
		const roots = planStoreRoots(store);
		expect(isPlanWritePathAllowed(join(store.ownDir, "plan.md"), linkedDir, roots)).toBe(true);
		expect(isPlanWritePathAllowed(join(store.sharedDir, "shared.mdx"), linkedDir, roots)).toBe(true);
		expect(isPlanWritePathAllowed("tmp/plans/local.md", linkedDir, roots)).toBe(true);
	});

	test("accepts ~/ paths only when they land in the store", () => {
		const name = `.plannotator-plan-store-test-${process.pid}-${Date.now()}`;
		const store = resolvePlanStore(linkedDir, { planStore: { root: `~/${name}` } });
		if (!store) throw new Error("no plan store");
		const roots = planStoreRoots(store);
		const own = normalizePlanInputPath(`~/${name}/myrepo/feat/x/plan.md`, store);
		expect(own).toBe(join(store.ownDir, "plan.md"));
		expect(isPlanWritePathAllowed(own, linkedDir, roots)).toBe(true);
		expect(isPlanWritePathAllowed(normalizePlanInputPath(`~/${name}/myrepo/main/shared.md`, store), linkedDir, roots)).toBe(true);
		expect(isPlanWritePathAllowed(normalizePlanInputPath("~/elsewhere.md", store), linkedDir, roots)).toBe(false);
		expect(normalizePlanInputPath("~/elsewhere.md", undefined)).toBe("~/elsewhere.md");
		expect(existsSync(join(homedir(), name))).toBe(false);
	});

	test("rejects other repos, the store root, the repo dir itself, traversal, and non-markdown", () => {
		const store = storeFor(linkedDir);
		const roots = planStoreRoots(store);
		expect(isPlanWritePathAllowed(join(storeRoot, "otherrepo", "main", "plan.md"), linkedDir, roots)).toBe(false);
		expect(isPlanWritePathAllowed(join(storeRoot, "plan.md"), linkedDir, roots)).toBe(false);
		expect(isPlanWritePathAllowed(store.repoDir, linkedDir, roots)).toBe(false);
		expect(isPlanWritePathAllowed(`${store.ownDir}/../../../otherrepo/plan.md`, linkedDir, roots)).toBe(false);
		expect(isPlanWritePathAllowed(`${store.repoDir}/../escape.md`, linkedDir, roots)).toBe(false);
		expect(isPlanWritePathAllowed(join(store.ownDir, "plan.ts"), linkedDir, roots)).toBe(false);
		expect(isPlanWritePathAllowed(join(store.ownDir, "notes.txt"), linkedDir, roots)).toBe(false);
	});

	test("rejects store paths when the store is off", () => {
		const store = storeFor(linkedDir);
		expect(isPlanWritePathAllowed(join(store.ownDir, "plan.md"), linkedDir)).toBe(false);
		expect(isPlanWritePathAllowed(join(store.ownDir, "plan.md"), linkedDir, planStoreRoots(undefined))).toBe(false);
	});
});

describe("realpath plan target with a plan store", () => {
	test("accepts real store files and rewrites them in place", () => {
		const store = storeFor(linkedDir);
		mkdirSync(store.sharedDir, { recursive: true });
		const plan = join(store.sharedDir, "real.md");
		writeFileSync(plan, "# Plan\n", "utf-8");
		expect(resolvePlanTarget(linkedDir, plan, planStoreRoots(store))).toEqual({ target: realpathSync(plan) });
		expect(writePlanIfUnchanged(linkedDir, plan, "# Plan\n", "# Plan v2\n", planStoreRoots(store))).toBeUndefined();
		expect(readFileSync(plan, "utf-8")).toBe("# Plan v2\n");
	});

	test("rejects store files without store roots and symlinks escaping the store", () => {
		const store = storeFor(linkedDir);
		mkdirSync(store.ownDir, { recursive: true });
		const plan = join(store.ownDir, "own.md");
		writeFileSync(plan, "# Own\n", "utf-8");
		expect(resolvePlanTarget(linkedDir, plan)).toEqual({ error: `${plan} resolves outside the working directory` });

		const secret = join(outsideDir, "secret.md");
		writeFileSync(secret, "secret\n", "utf-8");
		const link = join(store.ownDir, "escape.md");
		symlinkSync(secret, link);
		expect(isPlanWritePathAllowed(link, linkedDir, planStoreRoots(store))).toBe(true);
		expect(resolvePlanTarget(linkedDir, link, planStoreRoots(store))).toEqual({
			error: `${link} resolves outside the working directory and the plan store`,
		});
		expect(writePlanIfUnchanged(linkedDir, link, "secret\n", "pwned\n", planStoreRoots(store))).toContain("resolves outside");
		expect(readFileSync(secret, "utf-8")).toBe("secret\n");
	});
});

describe("plan store prompts", () => {
	test("keeps the default submit text unchanged without a store", () => {
		expect(submitPlanToolText(undefined)).toEqual({
			description:
				"Submit a markdown plan for mandatory browser review. " +
				"Use tmp/plans/<descriptive-kebab-case-slug>.md by default unless applicable AGENTS or the user specifies another markdown path inside cwd. " +
				"Approval begins a human docs/code grill; it never starts implementation directly. " +
				"If denied or changed during grilling, edit the same file and submit it again.",
			filePathDescription:
				"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
			defaultPath: "tmp/plans/<slug>.md",
		});
		expect(planStoreRule(undefined)).toBe("");
	});

	test("points the submit text and plan rule at the own dir and the shared dir", () => {
		const store = storeFor(linkedDir);
		const text = submitPlanToolText(store);
		expect(text.defaultPath).toBe(join(store.ownDir, "<slug>.md"));
		expect(text.description).toContain(`Use ${join(store.ownDir, "<descriptive-kebab-case-slug>.md")} by default`);
		expect(text.description).toContain(store.sharedDir);
		expect(text.filePathDescription).toContain(store.repoDir);
		const rule = planStoreRule(store);
		expect(rule).toStartWith(`- Plan store: write new plans to ${join(store.ownDir, "<descriptive-kebab-case-slug>.md")}`);
		expect(rule).toContain(store.sharedDir);
		expect(rule).toEndWith("\n");
	});
});
