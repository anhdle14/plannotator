import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatTemplateList,
	loadPlanTemplates,
	localDate,
	parsePlannotatorArgs,
	renderPlanTemplate,
	slugify,
	writePlanScaffold,
} from "./plan-templates.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeTemplate(dir: string, name: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), content, "utf-8");
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("plan templates", () => {
	test("ships the six built-in templates with descriptions", () => {
		process.env.PI_CODING_AGENT_DIR = makeTempDir("plan-templates-agent-");
		const { templates, warnings } = loadPlanTemplates(makeTempDir("plan-templates-cwd-"), { projectTrusted: true });
		expect(warnings).toEqual([]);
		expect(templates.map((template) => template.name)).toEqual([
			"bug-investigation",
			"implementation",
			"migration-rollout",
			"refactor",
			"research-decision",
			"review",
		]);
		for (const template of templates) {
			expect(template.source).toBe("built-in");
			expect(template.description).toBeTruthy();
			expect(template.content).toContain(`template: ${template.name}`);
		}
	});

	test("user overrides built-in and project overrides user", () => {
		const agentDir = makeTempDir("plan-templates-agent-");
		const cwd = makeTempDir("plan-templates-cwd-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeTemplate(join(agentDir, "plannotator", "templates"), "implementation", "user impl");
		writeTemplate(join(agentDir, "plannotator", "templates"), "spike", "---\ndescription: Time-boxed spike\n---\n");
		writeTemplate(join(cwd, ".pi", "plannotator", "templates"), "implementation", "project impl");

		const { templates } = loadPlanTemplates(cwd, { projectTrusted: true });
		const implementation = templates.find((template) => template.name === "implementation");
		expect(implementation?.source).toBe("project");
		expect(implementation?.content).toBe("project impl");
		const spike = templates.find((template) => template.name === "spike");
		expect(spike?.source).toBe("user");
		expect(spike?.description).toBe("Time-boxed spike");
	});

	test("project templates are ignored when the project is not trusted", () => {
		const agentDir = makeTempDir("plan-templates-agent-");
		const cwd = makeTempDir("plan-templates-cwd-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeTemplate(join(agentDir, "plannotator", "templates"), "implementation", "user impl");
		writeTemplate(join(cwd, ".pi", "plannotator", "templates"), "implementation", "project impl");
		writeTemplate(join(cwd, ".pi", "plannotator", "templates"), "project-only", "x");

		const { templates } = loadPlanTemplates(cwd, { projectTrusted: false });
		expect(templates.find((template) => template.name === "implementation")?.source).toBe("user");
		expect(templates.some((template) => template.name === "project-only")).toBe(false);
	});

	test("renders known placeholders, drops description, and reports unknown ones", () => {
		const { text, unknownPlaceholders } = renderPlanTemplate(
			"---\ntemplate: x\ndescription: listing text\nowner: {{owner}}\ncreated: {{ date }}\n---\n# {{intent}}\n{{ticket}} {{ticket}}\n",
			{ date: "2026-10-06", intent: "Flaky gateway test", owner: "Duc Le" },
		);
		expect(text).toBe("---\ntemplate: x\nowner: Duc Le\ncreated: 2026-10-06\n---\n# Flaky gateway test\n{{ticket}} {{ticket}}\n");
		expect(unknownPlaceholders).toEqual(["ticket"]);
	});

	test("slugifies intent text", () => {
		expect(slugify("Flaky gateway test!")).toBe("flaky-gateway-test");
		expect(slugify("  Café   déjà vu  ")).toBe("cafe-deja-vu");
		expect(slugify("!!!")).toBe("");
		const long = slugify("word ".repeat(30));
		expect(long.length).toBeLessThanOrEqual(60);
		expect(long.endsWith("-")).toBe(false);
	});

	test("parses type and intent", () => {
		expect(parsePlannotatorArgs("")).toEqual({ intent: "" });
		expect(parsePlannotatorArgs("  bug-investigation   flaky  gateway test ")).toEqual({
			type: "bug-investigation",
			intent: "flaky gateway test",
		});
	});

	test("never overwrites an existing plan file", () => {
		const cwd = makeTempDir("plan-templates-write-");
		expect(writePlanScaffold(cwd, "2026-10-06", "flaky", "one")).toBe(join("tmp", "plans", "2026-10-06-flaky.md"));
		expect(writePlanScaffold(cwd, "2026-10-06", "flaky", "two")).toBe(join("tmp", "plans", "2026-10-06-flaky-2.md"));
		expect(writePlanScaffold(cwd, "2026-10-06", "flaky", "three")).toBe(join("tmp", "plans", "2026-10-06-flaky-3.md"));
		expect(readFileSync(join(cwd, "tmp", "plans", "2026-10-06-flaky.md"), "utf-8")).toBe("one");
		expect(existsSync(join(cwd, "tmp", "plans", "2026-10-06-flaky-3.md"))).toBe(true);
	});

	test("formats local dates and template listings", () => {
		expect(localDate(new Date(2026, 0, 5))).toBe("2026-01-05");
		const listing = formatTemplateList([
			{ name: "review", description: "Review work", source: "built-in", path: "/x", content: "" },
			{ name: "spike", source: "user", path: "/y", content: "" },
		]);
		expect(listing).toContain("review  [built-in]  Review work");
		expect(listing).toMatch(/spike   \[user\]$/m);
	});
});
