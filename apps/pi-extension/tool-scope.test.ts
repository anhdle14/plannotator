import { describe, expect, test } from "bun:test";
import {
	getFileMutationPath,
	isPlanWritePathAllowed,
	isPreImplementationPhase,
} from "./tool-scope.ts";

describe("pre-implementation phases", () => {
	test("covers planning and grilling only", () => {
		expect(isPreImplementationPhase("planning")).toBe(true);
		expect(isPreImplementationPhase("grilling")).toBe(true);
		expect(isPreImplementationPhase("idle")).toBe(false);
		expect(isPreImplementationPhase("executing")).toBe(false);
	});
});

describe("file mutation tools", () => {
	test("extracts paths from write, edit, and patch", () => {
		for (const toolName of ["write", "edit", "patch"]) {
			expect(getFileMutationPath(toolName, { path: "tmp/plans/auth.md" })).toBe(
				"tmp/plans/auth.md",
			);
		}
	});

	test("ignores non-mutating tools and malformed inputs", () => {
		expect(getFileMutationPath("read", { path: "src/app.ts" })).toBeUndefined();
		expect(getFileMutationPath("edit", {})).toBeUndefined();
		expect(getFileMutationPath("patch", null)).toBeUndefined();
	});
});

describe("plan write path gate", () => {
	const cwd = "/r";

	test("allows markdown files anywhere inside cwd", () => {
		expect(isPlanWritePathAllowed("PLAN.md", cwd)).toBe(true);
		expect(isPlanWritePathAllowed("plans/auth.md", cwd)).toBe(true);
		expect(isPlanWritePathAllowed("deeply/nested/dir/notes.mdx", cwd)).toBe(true);
	});

	test("rejects non-markdown extensions", () => {
		expect(isPlanWritePathAllowed("src/app.ts", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("notes.txt", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("config.json", cwd)).toBe(false);
	});

	test("rejects files with no extension or bare directories", () => {
		expect(isPlanWritePathAllowed("plans", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("PLAN", cwd)).toBe(false);
	});

	test("rejects traversal and absolute paths outside cwd", () => {
		expect(isPlanWritePathAllowed("../escape.md", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("../../etc/passwd.md", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("/tmp/leak.md", cwd)).toBe(false);
	});

	test("allows absolute paths that resolve inside cwd", () => {
		expect(isPlanWritePathAllowed("/r/plans/foo.md", cwd)).toBe(true);
	});

	test("rejects empty path and the cwd itself", () => {
		expect(isPlanWritePathAllowed("", cwd)).toBe(false);
		expect(isPlanWritePathAllowed(".", cwd)).toBe(false);
	});

	test("extension check is case-insensitive", () => {
		expect(isPlanWritePathAllowed("PLAN.MD", cwd)).toBe(true);
		expect(isPlanWritePathAllowed("notes.MdX", cwd)).toBe(true);
	});
});
