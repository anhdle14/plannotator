import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PlanStoreConfig {
	root?: string;
}

export interface PlanStore {
	/** Absolute store root, shared by every repository. */
	root: string;
	/** Basename of the repository's main worktree. */
	repo: string;
	/** `<root>/<repo>`: every plan path under it is allowed. */
	repoDir: string;
	/** `<root>/<repo>/main`: plans shared with the main checkout. */
	sharedDir: string;
	/** Plans owned by the current worktree: `sharedDir` in the main checkout, otherwise `<repoDir>/<branch or short SHA>`. */
	ownDir: string;
}

export const SHARED_PLAN_DIR = "main";

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
}

/** Resolve the per-repo plan store for cwd; undefined when no store root is configured or cwd is not in a git worktree. */
export function resolvePlanStore(cwd: string, config: { planStore?: PlanStoreConfig | null }): PlanStore | undefined {
	const configuredRoot = config.planStore?.root?.trim();
	if (!configuredRoot) return undefined;
	const listing = git(cwd, ["worktree", "list", "--porcelain"]);
	const mainWorktree = listing?.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
	if (!mainWorktree) return undefined;
	const repo = basename(mainWorktree);
	if (!repo || repo === "." || repo === "..") return undefined;

	const root = resolve(expandHome(configuredRoot));
	const repoDir = join(root, repo);
	const sharedDir = join(repoDir, SHARED_PLAN_DIR);
	const toplevel = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (toplevel && samePath(toplevel, mainWorktree)) return { root, repo, repoDir, sharedDir, ownDir: sharedDir };

	const owner = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]) || git(cwd, ["rev-parse", "--short", "HEAD"]);
	if (!owner) return undefined;
	const ownDir = join(repoDir, ...owner.split("/"));
	if (!isInsideDir(repoDir, ownDir)) return undefined;
	return { root, repo, repoDir, sharedDir, ownDir };
}

/** Lexical containment: target is strictly inside dir (not dir itself, no `..` escape). */
export function isInsideDir(dir: string, target: string): boolean {
	const rel = relative(resolve(dir), resolve(target));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Roots beyond cwd where plan files are allowed. */
export function planStoreRoots(store: PlanStore | undefined): string[] {
	return store ? [store.repoDir] : [];
}

/** Store paths may be given as `~/...`; without a store, input paths are used exactly as today. */
export function normalizePlanInputPath(inputPath: string, store: PlanStore | undefined): string {
	return store ? expandHome(inputPath) : inputPath;
}

export interface SubmitPlanToolText {
	description: string;
	filePathDescription: string;
	defaultPath: string;
}

export function submitPlanToolText(store: PlanStore | undefined): SubmitPlanToolText {
	if (!store) {
		return {
			description:
				"Submit a markdown plan for mandatory browser review. " +
				"Use tmp/plans/<descriptive-kebab-case-slug>.md by default unless applicable AGENTS or the user specifies another markdown path inside cwd. " +
				"Approval begins a human docs/code grill; it never starts implementation directly. " +
				"If denied or changed during grilling, edit the same file and submit it again.",
			filePathDescription:
				"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
			defaultPath: "tmp/plans/<slug>.md",
		};
	}
	return {
		description:
			"Submit a markdown plan for mandatory browser review. " +
			`Use ${join(store.ownDir, "<descriptive-kebab-case-slug>.md")} by default unless applicable AGENTS or the user specifies another markdown path inside cwd or the plan store ${store.repoDir}. ` +
			`Plans shared with the main checkout live in ${store.sharedDir}. ` +
			"Approval begins a human docs/code grill; it never starts implementation directly. " +
			"If denied or changed during grilling, edit the same file and submit it again.",
		filePathDescription: `Path to the markdown plan file, absolute or relative to the working directory. Must end in .md or .mdx and resolve inside cwd or ${store.repoDir}.`,
		defaultPath: join(store.ownDir, "<slug>.md"),
	};
}

/** Planning rule that points new plans at the store; empty without a store. */
export function planStoreRule(store: PlanStore | undefined): string {
	if (!store) return "";
	return (
		`- Plan store: write new plans to ${join(store.ownDir, "<descriptive-kebab-case-slug>.md")} instead of tmp/plans/. ` +
		`Plans shared with the main checkout live in ${store.sharedDir}. ` +
		`Markdown files anywhere under ${store.repoDir} are allowed alongside markdown inside cwd.\n`
	);
}

/** Write a new scaffold under `<cwd>/tmp/plans` (returning the cwd-relative path), or under `dir` (returning the absolute path). */
export function writePlanScaffold(cwd: string, date: string, slug: string, text: string, dir?: string): string {
	const targetDir = dir ?? join(cwd, "tmp", "plans");
	mkdirSync(targetDir, { recursive: true });
	for (let attempt = 1; ; attempt += 1) {
		const name = `${date}-${slug}${attempt === 1 ? "" : `-${attempt}`}.md`;
		const planPath = dir ? join(dir, name) : join("tmp", "plans", name);
		try {
			writeFileSync(dir ? planPath : join(cwd, planPath), text, { encoding: "utf-8", flag: "wx" });
			return planPath;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
}
