import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const BIFROST_LOCK_EVENT = "bifrost:lock";
export const BIFROST_RELEASE_EVENT = "bifrost:release";
export const LOCK_OWNER = "plannotator";

export type Vendor = "anthropic" | "openai" | "other";

export interface ModelRoutingSettings {
	enabled: boolean;
	planningTier: string;
	phaseTiers: string[];
	systemOneUrl: string;
	systemOneModel: string;
	minProbability: number;
	timeoutMs: number;
	reviewers: Record<"anthropic" | "openai", string>;
	criteria: Record<string, string>;
}

export const DEFAULT_PHASE_CRITERIA: Record<string, string> = {
	quick: "Mechanical work with no design decisions: run commands, rename, reformat, bump versions, copy known values.",
	general: "Ordinary scoped software work: implement or edit code and config, write tests, update docs, wire known pieces together.",
	frontier: "Open-ended work: diagnose unexplained failures, design architecture or protocols, security, concurrency, data migration, or high-consequence production changes.",
};

export const DEFAULT_MODEL_ROUTING: ModelRoutingSettings = {
	enabled: false,
	planningTier: "frontier",
	phaseTiers: ["quick", "general", "frontier"],
	systemOneUrl: "http://127.0.0.1:8008",
	systemOneModel: "von-latest",
	minProbability: 0.6,
	timeoutMs: 30_000,
	reviewers: {
		anthropic: "wovey/gpt-6.1-sol",
		openai: "wovey/global.anthropic.claude-opus-5-5",
	},
	criteria: DEFAULT_PHASE_CRITERIA,
};

export type LockResult =
	| { readonly ok: true; readonly tier: string; readonly model?: string }
	| { readonly ok: false; readonly reason: string };

export interface EventBus {
	emit(channel: string, data: unknown): void;
}

export const LOCK_UNAVAILABLE_REASON =
	"Bifrost did not answer bifrost:lock; load a Pi-Bifrost build with tier-lock support or disable modelRouting";

export interface LockRequestOptions {
	timeoutMs?: number;
	/** Called with a reply that arrives after the request already timed out. */
	onLateReply?: (result: LockResult) => void;
}

export function requestTierLock(events: EventBus, tier: string, options: LockRequestOptions = {}): Promise<LockResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: LockResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => finish({ ok: false, reason: LOCK_UNAVAILABLE_REASON }), options.timeoutMs ?? 5_000);
		try {
			events.emit(BIFROST_LOCK_EVENT, {
				tier,
				owner: LOCK_OWNER,
				reply: (result: unknown) => {
					const normalized = normalizeLockReply(result, tier);
					if (settled) options.onLateReply?.(normalized);
					else finish(normalized);
				},
			});
		} catch (error) {
			finish({ ok: false, reason: `bifrost:lock failed: ${error instanceof Error ? error.message : String(error)}` });
		}
	});
}

function normalizeLockReply(result: unknown, requested: string): LockResult {
	if (!result || typeof result !== "object") return { ok: false, reason: "Bifrost sent an invalid lock reply" };
	const record = result as Record<string, unknown>;
	if (record.ok === true) {
		if (record.tier !== requested) return { ok: false, reason: `Bifrost acknowledged tier ${String(record.tier)} instead of ${requested}` };
		return { ok: true, tier: requested, ...(typeof record.model === "string" ? { model: record.model } : {}) };
	}
	return { ok: false, reason: typeof record.reason === "string" ? record.reason : "Bifrost rejected the lock" };
}

export function releaseTierLock(events: EventBus): void {
	try {
		events.emit(BIFROST_RELEASE_EVENT, { owner: LOCK_OWNER });
	} catch {
		// Release is best effort; Bifrost drops the lock on its own restart.
	}
}

// ── Plan phases ────────────────────────────────────────────────────────

export interface PlanPhase {
	title: string;
	/** Line index of the heading. */
	headingLine: number;
	/** Exclusive end line index of the section. */
	endLine: number;
	body: string;
	/** Tier from an existing `- Model:` line, when it names one. */
	assignedTier?: string;
	/** True when the existing Model line defers the choice to the grill. */
	undecided: boolean;
}

const PHASE_HEADING = /^(#{2,4})\s+(Phase\b.*)$/;
export const TIER_NAME = /^[a-z][\w-]*$/i;
const MODEL_LINE = /^- Model:\s*(.*)$/;

export function parsePlanPhases(markdown: string, tiers: readonly string[]): PlanPhase[] {
	const lines = markdown.split("\n");
	const phases: PlanPhase[] = [];
	let level = 0;
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (inFence) continue;
		const heading = /^(#{1,6})\s/.exec(line);
		if (!heading) continue;
		const depth = heading[1].length;
		const open = phases[phases.length - 1];
		const match = PHASE_HEADING.exec(line);
		// Phases never overlap: a nested Phase heading ends its parent, so every step belongs to exactly one phase.
		if (open && open.endLine === -1 && (match || depth <= level)) open.endLine = i;
		if (match) {
			level = match[1].length;
			phases.push({ title: match[2].trim(), headingLine: i, endLine: -1, body: "", undecided: false });
		}
	}
	const last = phases[phases.length - 1];
	if (last && last.endLine === -1) last.endLine = lines.length;
	for (const phase of phases) {
		const sectionLines = lines.slice(phase.headingLine + 1, phase.endLine);
		phase.body = sectionLines.join("\n").trim();
		let fence = false;
		for (const line of sectionLines) {
			if (/^\s*(```|~~~)/.test(line)) fence = !fence;
			if (fence) continue;
			const model = MODEL_LINE.exec(line);
			if (model && phase.assignedTier === undefined && !phase.undecided) {
				const value = model[1].trim();
				const tier = /^([a-z][\w-]*)/i.exec(value)?.[1];
				if (tier && tiers.includes(tier)) phase.assignedTier = tier;
				else phase.undecided = true;
			}
		}
	}
	return phases;
}

/** Index of the phase holding the first incomplete checklist step; numbering matches parseChecklist, fences included. */
export function currentPhaseIndex(markdown: string, phases: readonly PlanPhase[], completedSteps: ReadonlySet<number>): number {
	const lines = markdown.split("\n");
	let step = 0;
	for (let i = 0; i < lines.length; i++) {
		const match = /^[-*]\s*\[([ xX])\]\s+(.+)$/.exec(lines[i]);
		if (!match || match[2].trim().length === 0) continue;
		step += 1;
		if (completedSteps.has(step) || match[1] !== " ") continue;
		return phases.findIndex((phase) => i > phase.headingLine && i < phase.endLine);
	}
	return -1;
}

// ── System One ─────────────────────────────────────────────────────────

export type PhaseJudgment =
	| { readonly kind: "assigned"; readonly tier: string; readonly probability: number }
	| { readonly kind: "uncertain"; readonly tier: string; readonly probability: number }
	| { readonly kind: "unavailable"; readonly reason: string };

export interface ClassifyPhasesInput {
	phases: readonly PlanPhase[];
	settings: ModelRoutingSettings;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

// Measured on Von 1.2: about 1 s per phase at this size, versus 10 s for whole sections, with the same answers.
const PHASE_BODY_LIMIT = 1_500;

/** Tier difficulty is an ordered scale, so each phase gets one `score` question over its own text only. */
export function buildSystemOneRequest(phase: PlanPhase, settings: ModelRoutingSettings): Record<string, unknown> {
	return {
		model: settings.systemOneModel,
		state: `${phase.title}\n${phase.body.slice(0, PHASE_BODY_LIMIT)}`,
		questions: {
			tier: {
				type: "score",
				instructions: "How much reasoning capability does implementing this plan phase need?",
				criteria: settings.phaseTiers.map((tier) => settings.criteria[tier] ?? tier),
			},
		},
	};
}

const PROBABILITY_SUM_TOLERANCE = 0.02;
const MALFORMED_ANSWER = "System One returned no usable probabilities for this phase";

// Gate on the top tier's probability, not Von's `confidence`, which stays near 0.25-0.46 even when the top tier is right.
function judgmentFrom(payload: unknown, settings: ModelRoutingSettings): PhaseJudgment {
	const probabilities = (payload as { answers?: { tier?: { probabilities?: unknown } } } | undefined)?.answers?.tier?.probabilities;
	if (!probabilities || typeof probabilities !== "object") return { kind: "unavailable", reason: MALFORMED_ANSWER };
	const values = settings.phaseTiers.map((_tier, level) => (probabilities as Record<string, unknown>)[String(level)]);
	if (!values.every((p): p is number => typeof p === "number" && p >= 0 && p <= 1)) return { kind: "unavailable", reason: MALFORMED_ANSWER };
	if (Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) > PROBABILITY_SUM_TOLERANCE) return { kind: "unavailable", reason: MALFORMED_ANSWER };
	const best = values.indexOf(Math.max(...values));
	const tier = settings.phaseTiers[best];
	const probability = values[best];
	return probability >= settings.minProbability
		? { kind: "assigned", tier, probability }
		: { kind: "uncertain", tier, probability };
}

/** One request per phase, sent sequentially so a local judge is never hit concurrently. Caller cancellation rejects. */
export async function classifyPhases(input: ClassifyPhasesInput): Promise<PhaseJudgment[]> {
	const url = `${input.settings.systemOneUrl.replace(/\/+$/, "")}/v1/systemone`;
	const judgments: PhaseJudgment[] = [];
	for (const phase of input.phases) {
		input.signal?.throwIfAborted();
		try {
			const timeout = AbortSignal.timeout(input.settings.timeoutMs);
			const response = await (input.fetchImpl ?? fetch)(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(buildSystemOneRequest(phase, input.settings)),
				signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
			});
			judgments.push(response.ok
				? judgmentFrom(await response.json(), input.settings)
				: { kind: "unavailable", reason: `System One returned HTTP ${response.status}` });
		} catch (error) {
			if (input.signal?.aborted) throw input.signal.reason;
			const reason = `System One is unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`;
			while (judgments.length < input.phases.length) judgments.push({ kind: "unavailable", reason });
			break;
		}
	}
	return judgments;
}

export function formatModelLine(judgment: PhaseJudgment, fallbackTier: string): string {
	const p = (value: number) => value.toFixed(2);
	switch (judgment.kind) {
		case "assigned":
			return `- Model: ${judgment.tier} (System One p=${p(judgment.probability)})`;
		case "uncertain":
			return `- Model: undecided (System One suggests ${judgment.tier} at p=${p(judgment.probability)}; decide in the grill)`;
		case "unavailable":
			return `- Model: ${fallbackTier} (System One unavailable; defaulted to ${fallbackTier})`;
	}
}

/** Write a Model line into each phase that has no decided tier. Phases with a decided Model line are left alone. */
export function applyModelLines(markdown: string, phases: readonly PlanPhase[], lines: ReadonlyMap<number, string>): string {
	const out = markdown.split("\n");
	for (let index = phases.length - 1; index >= 0; index--) {
		const line = lines.get(index);
		if (!line) continue;
		const phase = phases[index];
		let existing = -1;
		let fence = false;
		for (let i = phase.headingLine + 1; i < phase.endLine; i++) {
			if (/^\s*(```|~~~)/.test(out[i])) fence = !fence;
			if (!fence && MODEL_LINE.test(out[i])) {
				existing = i;
				break;
			}
		}
		if (existing >= 0) out[existing] = line;
		else out.splice(phase.headingLine + 1, 0, "", line);
	}
	return out.join("\n");
}

/**
 * Resolve a plan's real path and require it inside cwd or a real store root, so writes never follow a symlink out
 * of the project or the plan store.
 */
export function resolvePlanTarget(cwd: string, path: string, storeRoots: readonly string[] = []): { target: string } | { error: string } {
	try {
		const target = realpathSync(path);
		const roots = [realpathSync(cwd)];
		for (const root of storeRoots) {
			try {
				roots.push(realpathSync(root));
			} catch {}
		}
		const inside = roots.some((root) => {
			const rel = relative(root, target);
			return !(rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
		});
		if (!inside) {
			return { error: `${path} resolves outside the working directory${storeRoots.length > 0 ? " and the plan store" : ""}` };
		}
		return { target };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Replace the plan only if it still holds `expected`, through a same-directory temp file and rename.
 * Rename replaces a swapped-in final-component symlink instead of following it. Returns an error message.
 */
export function writePlanIfUnchanged(
	cwd: string,
	path: string,
	expected: string,
	updated: string,
	storeRoots: readonly string[] = [],
): string | undefined {
	const resolved = resolvePlanTarget(cwd, path, storeRoots);
	if ("error" in resolved) return resolved.error;
	const { target } = resolved;
	const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
	try {
		if (readFileSync(target, "utf-8") !== expected) return "the plan changed while System One was judging it; resubmit it";
		writeFileSync(temp, updated, { encoding: "utf-8", flag: "wx", mode: statSync(target).mode & 0o777 });
		renameSync(temp, target);
		return undefined;
	} catch (error) {
		rmSync(temp, { force: true });
		return error instanceof Error ? error.message : String(error);
	}
}

// ── Cross-vendor review ────────────────────────────────────────────────

export function vendorOf(modelKey: string): Vendor {
	const id = modelKey.toLowerCase();
	if (/anthropic|claude/.test(id)) return "anthropic";
	if (/(^|[/.])(gpt|o\d|codex)|openai/.test(id)) return "openai";
	return "other";
}

export interface ModelUsage {
	/** Planning and grilling turns per model key. */
	planners: Record<string, number>;
	/** Changed lines written through file tools per model key during execution. */
	builders: Record<string, number>;
}

export function emptyModelUsage(): ModelUsage {
	return { planners: {}, builders: {} };
}

export function copyModelUsage(usage: ModelUsage | undefined): ModelUsage {
	return { planners: { ...usage?.planners }, builders: { ...usage?.builders } };
}

export interface ReviewerChoice {
	model: string;
	reason: string;
	/** Set when both vendors wrote the work, so the human should confirm the reviewer. */
	flag?: string;
}

function vendorTotals(counts: Record<string, number>): Record<Vendor, number> {
	const totals: Record<Vendor, number> = { anthropic: 0, openai: 0, other: 0 };
	for (const [model, count] of Object.entries(counts)) totals[vendorOf(model)] += count;
	return totals;
}

export function chooseReviewer(usage: ModelUsage, reviewers: ModelRoutingSettings["reviewers"]): ReviewerChoice | undefined {
	const built = vendorTotals(usage.builders);
	const planned = vendorTotals(usage.planners);
	const used = (vendor: "anthropic" | "openai") => built[vendor] > 0 || planned[vendor] > 0;
	const reviewerFor = (writer: "anthropic" | "openai") => (writer === "anthropic" ? reviewers.anthropic : reviewers.openai);
	if (used("anthropic") && used("openai")) {
		const weights = built.anthropic + built.openai > 0 ? built : planned;
		const majority = weights.anthropic >= weights.openai ? "anthropic" : "openai";
		return {
			model: reviewerFor(majority),
			reason: `both vendors worked on this plan; ${majority} wrote most of it`,
			flag: `Both Anthropic and OpenAI models built this plan (changed lines: anthropic ${built.anthropic}, openai ${built.openai}); confirm the reviewer.`,
		};
	}
	if (used("anthropic")) return { model: reviewerFor("anthropic"), reason: "Anthropic models planned or built this plan" };
	if (used("openai")) return { model: reviewerFor("openai"), reason: "OpenAI models planned or built this plan" };
	return undefined;
}

const LINE_FIELDS = new Set(["content", "new_str", "newText", "new_string", "newString"]);

/** Count lines a file tool call writes, from the string fields write/edit/patch tools use. */
export function countWrittenLines(input: unknown): number {
	if (Array.isArray(input)) return input.reduce((sum: number, item) => sum + countWrittenLines(item), 0);
	if (!input || typeof input !== "object") return 0;
	let total = 0;
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (typeof value === "string" && LINE_FIELDS.has(key)) total += value.length === 0 ? 0 : value.split("\n").length;
		else if (typeof value === "object") total += countWrittenLines(value);
	}
	return total;
}

export function reviewerInstruction(choice: ReviewerChoice | undefined): string | undefined {
	if (!choice) return undefined;
	const flag = choice.flag ? ` ${choice.flag}` : "";
	return `Cross-vendor review: when you delegate review of this plan's diff, call acp_delegate with agent "reviewer" and model "${choice.model}" (${choice.reason}).${flag}`;
}
