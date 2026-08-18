import { extname, isAbsolute, relative, resolve } from "node:path";

export type Phase = "idle" | "planning" | "grilling" | "executing";

export const PLAN_SUBMIT_TOOL = "plannotator_submit_plan";
export const GRILL_FINISH_TOOL = "plannotator_finish_grill";

const ALLOWED_PLAN_EXTENSIONS = new Set<string>([".md", ".mdx"]);
const FILE_MUTATION_TOOLS = new Set(["write", "edit", "patch"]);

export function isPreImplementationPhase(phase: Phase): boolean {
	return phase === "planning" || phase === "grilling";
}

export function getFileMutationPath(
	toolName: string,
	input: unknown,
): string | undefined {
	if (!FILE_MUTATION_TOOLS.has(toolName) || !input || typeof input !== "object") {
		return undefined;
	}
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" ? path : undefined;
}

// Used by both the planning-phase write gate and plannotator_submit_plan.
// Path must resolve inside cwd (no traversal, no absolute escape) and end
// in a permitted markdown extension.
export function isPlanWritePathAllowed(inputPath: string, cwd: string): boolean {
	if (!inputPath) return false;
	const targetAbs = resolve(cwd, inputPath);
	const rel = relative(resolve(cwd), targetAbs);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	const ext = extname(targetAbs).toLowerCase();
	return ALLOWED_PLAN_EXTENSIONS.has(ext);
}
