import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PlanTemplateSource = "built-in" | "user" | "project";

export interface PlanTemplate {
	name: string;
	description?: string;
	source: PlanTemplateSource;
	path: string;
	content: string;
}

export interface PlanTemplateDir {
	source: PlanTemplateSource;
	dir: string;
}

export interface PlanTemplateVariables {
	date: string;
	intent: string;
	owner: string;
}

const BUILT_IN_TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");
const KNOWN_PLACEHOLDERS = new Set<keyof PlanTemplateVariables>(["date", "intent", "owner"]);
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SLUG_LENGTH = 60;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || homedir(), ".pi", "agent");
}

export function planTemplateDirs(cwd: string, options: { projectTrusted: boolean }): PlanTemplateDir[] {
	const dirs: PlanTemplateDir[] = [
		{ source: "built-in", dir: BUILT_IN_TEMPLATE_DIR },
		{ source: "user", dir: join(agentDir(), "plannotator", "templates") },
	];
	if (options.projectTrusted) dirs.push({ source: "project", dir: join(cwd, ".pi", "plannotator", "templates") });
	return dirs;
}

function parseFrontMatter(content: string): Record<string, string> {
	const match = FRONT_MATTER.exec(content);
	if (!match) return {};
	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (field) fields[field[1]] = field[2].trim();
	}
	return fields;
}

export function loadPlanTemplates(
	cwd: string,
	options: { projectTrusted: boolean },
): { templates: PlanTemplate[]; warnings: string[] } {
	const byName = new Map<string, PlanTemplate>();
	const warnings: string[] = [];
	for (const { source, dir } of planTemplateDirs(cwd, options)) {
		if (!existsSync(dir)) continue;
		let files: string[];
		try {
			files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
		} catch (err) {
			warnings.push(`cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				const content = readFileSync(path, "utf-8");
				const name = basename(file, ".md");
				byName.set(name, { name, description: parseFrontMatter(content).description, source, path, content });
			} catch (err) {
				warnings.push(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	const templates = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	return { templates, warnings };
}

export function renderPlanTemplate(
	content: string,
	variables: PlanTemplateVariables,
): { text: string; unknownPlaceholders: string[] } {
	const unknown = new Set<string>();
	const withoutDescription = content.replace(FRONT_MATTER, (block) =>
		block
			.split(/\r?\n/)
			.filter((line) => !/^description:/.test(line))
			.join("\n"),
	);
	const text = withoutDescription.replace(PLACEHOLDER, (whole, key: string) => {
		if (KNOWN_PLACEHOLDERS.has(key as keyof PlanTemplateVariables)) {
			return variables[key as keyof PlanTemplateVariables];
		}
		unknown.add(key);
		return whole;
	});
	return { text, unknownPlaceholders: [...unknown].sort() };
}

export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length <= MAX_SLUG_LENGTH) return slug;
	const cut = slug.slice(0, MAX_SLUG_LENGTH);
	const lastDash = cut.lastIndexOf("-");
	return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
}

export function parsePlannotatorArgs(args: string): { type?: string; intent: string } {
	const trimmed = args.trim();
	if (!trimmed) return { intent: "" };
	const [type, ...rest] = trimmed.split(/\s+/);
	return { type, intent: rest.join(" ") };
}

export function localDate(now: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function resolveOwner(cwd: string): string {
	try {
		const name = execFileSync("git", ["config", "--get", "user.name"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (name) return name;
	} catch {}
	return userInfo().username;
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

export function formatTemplateList(templates: PlanTemplate[]): string {
	if (templates.length === 0) return "No plan templates found.";
	const width = Math.max(...templates.map((template) => template.name.length));
	const sourceWidth = Math.max(...templates.map((template) => template.source.length)) + 2;
	const lines = templates.map(
		(template) =>
			`  ${template.name.padEnd(width)}  ${`[${template.source}]`.padEnd(sourceWidth)}${template.description ? `  ${template.description}` : ""}`.trimEnd(),
	);
	return ["Plan templates (/plannotator <type> [intent]):", ...lines].join("\n");
}

export function planTemplatePrompt(options: {
	template: PlanTemplate;
	planPath: string;
	intent: string;
}): string {
	const intent = options.intent || "not given yet; ask me for it before researching";
	return [
		`Start a plan from the ${options.template.name} template.`,
		`The scaffold from the ${options.template.source} template is at ${options.planPath}.`,
		`Intent: ${intent}`,
		"Research read-only, then fill every section of that file in place.",
		"Keep its front matter and headings, replace every placeholder, and submit that exact file with plannotator_submit_plan.",
	].join("\n");
}
