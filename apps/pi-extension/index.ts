/**
 * Plannotator Pi Extension — File-based plan mode with visual browser review.
 *
 * During planning the agent writes any markdown file anywhere inside cwd and
 * calls plannotator_submit_plan with the path. The user reviews in the
 * browser UI and can approve, deny with annotations, or request changes.
 *
 * Features:
 * - /plannotator-plan-mode command or Ctrl+Alt+P to toggle
 * - --plan flag to start in planning mode
 * - Bash unrestricted during planning (prompt-guided)
 * - Writes restricted to markdown files inside cwd during planning
 * - plannotator_submit_plan tool with browser-based visual approval
 * - [DONE:n] markers for execution progress tracking
 * - /plannotator-review command for code review
 * - /plannotator-annotate command for markdown annotation
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { buildPromptVariables, formatTodoList, loadPlannotatorConfig, renderTemplate, resolveExecutionMode, resolvePhaseProfile } from "./config.ts";
import {
	type ChecklistItem,
	markCompletedSteps,
	parseChecklist,
} from "./generated/checklist.ts";
import { loadConfig, resolveUseJina } from "./generated/config.ts";
import { readImprovementHook } from "./generated/improvement-hooks.ts";
import { composeImproveContext } from "./generated/pfm-reminder.ts";
import {
	hasPlanBrowserHtml,
	hasReviewBrowserHtml,
	getStartupErrorMessage,
	startCodeReviewBrowserSession,
	startLastMessageAnnotationSession,
	startMarkdownAnnotationSession,
	openPlanReviewBrowser,
	PLANNOTATOR_PLAN_APPROVED_CHANNEL,
	type PlannotatorPlanApprovedEvent,
	registerPlannotatorEventListeners,
} from "./plannotator-events.ts";
import { resolveTodoProvider, type TodoProvider } from "./todo-providers/index.ts";
import {
	findAssistantMessageByEntryId,
	getAssistantMessageText,
	getLastAssistantMessageSnapshot,
	getRecentAssistantMessages,
	hasSessionMovedPastEntry,
} from "./assistant-message.ts";
import {
	getPiSessionIdentity,
	isCtxAlive,
	isCurrentPiSessionDifferentFrom,
	notifyCurrentPiSession,
	type PiSessionIdentity,
	registerCurrentPiSession,
	sendUserMessageToCurrentPiSession,
	withCurrentPiSessionFallbackHeader,
} from "./current-pi-session.ts";
import {
	getFileMutationPath,
	GRILL_FINISH_TOOL,
	isPlanWritePathAllowed,
	isPreImplementationPhase,
	PLAN_SUBMIT_TOOL,
	type Phase,
} from "./tool-scope.ts";
import { hashPlanContent, validateGrillCompletion } from "./grill.ts";
import { isRemoteSession, isUrlHostOverridden } from "./server/network.ts";
import { isBrowserSessionStoppedError } from "./browser-session-error.ts";
import { classifyAnnotateOutcome } from "./annotate-outcome.ts";

// ── Types ──────────────────────────────────────────────────────────────

type PlannotatorPromptsModule = typeof import("./generated/prompts.ts");

let promptsModulePromise: Promise<PlannotatorPromptsModule> | undefined;

function loadPlannotatorPrompts(): Promise<PlannotatorPromptsModule> {
	if (!promptsModulePromise) {
		promptsModulePromise = import("./generated/prompts.ts").catch((error: unknown) => {
			promptsModulePromise = undefined;
			throw error;
		});
	}
	return promptsModulePromise;
}

async function loadAnnotateCommandModules() {
	const [annotateArgs, annotateTarget, atReference, resolveFile, referenceCommon] = await Promise.all([
		import("./generated/annotate-args.ts"),
		import("./generated/annotate-target.ts"),
		import("./generated/at-reference.ts"),
		import("./generated/resolve-file.ts"),
		import("./generated/reference-common.ts"),
	]);
	return {
		parseAnnotateArgs: annotateArgs.parseAnnotateArgs,
		annotateInputNamesExistingTarget: annotateTarget.annotateInputNamesExistingTarget,
		buildAmbiguousAnnotateArgsMessage: annotateTarget.buildAmbiguousAnnotateArgsMessage,
		buildUnresolvedAnnotateArgsMessage: annotateTarget.buildUnresolvedAnnotateArgsMessage,
		probeAnnotateToken: annotateTarget.probeAnnotateToken,
		selectAnnotateTokenTarget: annotateTarget.selectAnnotateTokenTarget,
		resolveAtReference: atReference.resolveAtReference,
		hasMarkdownFiles: resolveFile.hasMarkdownFiles,
		resolveUserPath: resolveFile.resolveUserPath,
		isAnnotatableTextPath: resolveFile.isAnnotatableTextPath,
		getAnnotatableDocRegex: resolveFile.getAnnotatableDocRegex,
		getAnnotatableExtensionsHint: resolveFile.getAnnotatableExtensionsHint,
		MAX_ANNOTATABLE_FILE_BYTES: resolveFile.MAX_ANNOTATABLE_FILE_BYTES,
		FILE_BROWSER_EXCLUDED: referenceCommon.FILE_BROWSER_EXCLUDED,
	};
}


type PersistedPlannotatorState = {
	phase: Phase;
	lastSubmittedPath?: string;
	approvedPlanHash?: string;
	approvalFeedback?: string;
	grillSummary?: string;
	/** Whether the current phase's entry framing message was already delivered. */
	framingDelivered?: boolean;
};

function getPlanReviewAvailabilityWarning(options: { hasUI: boolean; hasPlanHtml: boolean }): string | null {
	const { hasUI, hasPlanHtml } = options;
	if (hasUI && hasPlanHtml) return null;
	if (!hasUI && !hasPlanHtml) {
		return "Plannotator: interactive plan review is unavailable in this session (no UI support and missing built assets). Review fails closed; implementation remains locked.";
	}
	if (!hasUI) {
		return "Plannotator: interactive plan review is unavailable in this session (no UI support). Review fails closed; retry in interactive Pi.";
	}
	return "Plannotator: interactive plan review assets are missing. Rebuild the extension; implementation remains locked.";
}

function safeNotify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
	origin?: PiSessionIdentity,
): void {
	try {
		ctx.ui.notify(message, type);
	} catch (err) {
		if (notifyCurrentPiSession(message, type, origin)) return;
		console.error(`Plannotator notification failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Foreground "session opened" notice. For a remote session the auto-opened
 * browser is unreachable, so the URL must ride in THIS in-turn message — the
 * after-turn notify inside openBrowserForServer fires too late to render.
 */
function sessionOpenedMessage(label: string, url: string): string {
	if (!isRemoteSession()) return `${label}. You can keep chatting while it runs.`;
	// With an advertised-URL host override the link is directly reachable
	// (e.g. over a tailnet), so the port-forwarding advice would be wrong.
	return isUrlHostOverridden()
		? `${label} — open ${url} on your device. You can keep chatting while it runs.`
		: `${label} — open ${url} on your local machine (forward the port if needed). You can keep chatting while it runs.`;
}

function reportBackgroundError(ctx: ExtensionContext, message: string, err: unknown, origin?: PiSessionIdentity): void {
	const detail = getStartupErrorMessage(err);
	console.error(`${message}: ${detail}`);
	// A stopped session is not a failure: it is how supersession ends a stale
	// undecided session (port self-preemption, #1159) and how cancel paths
	// settle a pending waitForDecision.
	if (isBrowserSessionStoppedError(err)) {
		safeNotify(ctx, "A Plannotator browser session was closed.", "info", origin);
		return;
	}
	safeNotify(ctx, `${message}: ${detail}`, "error", origin);
}

function excerptText(text: string, maxChars = 1000): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function anchorMessageFeedback(feedback: string, originalMessage: string): string {
	return `This feedback applies to the earlier assistant response excerpted below:

${blockquote(excerptText(originalMessage))}

User feedback:
${feedback}`;
}

function shouldAnchorLastMessageFeedback(ctx: ExtensionContext, entryId: string, origin: PiSessionIdentity): boolean {
	if (isCurrentPiSessionDifferentFrom(origin)) return true;
	try {
		return hasSessionMovedPastEntry(ctx, entryId);
	} catch {
		return true;
	}
}

function reportCurrentSessionSendFailure(errorMessage: string, err: unknown, origin: PiSessionIdentity): void {
	const detail = getStartupErrorMessage(err);
	console.error(`${errorMessage}: ${detail}`);
	notifyCurrentPiSession(`${errorMessage}: ${detail}`, "error", origin);
}

function trySendUserMessageToDifferentCurrentSession(
	content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
	options: Parameters<ExtensionAPI["sendUserMessage"]>[1],
	errorMessage: string,
	origin: PiSessionIdentity,
): boolean {
	const result = sendUserMessageToCurrentPiSession(
		withCurrentPiSessionFallbackHeader(content),
		options,
		origin,
	);
	if (result.ok) return true;
	if (result.reason === "send-failed") {
		reportCurrentSessionSendFailure(errorMessage, result.error, origin);
		return true;
	}
	return false;
}

function sendUserMessageWithCurrentSessionFallback(
	pi: ExtensionAPI,
	content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
	options: Parameters<ExtensionAPI["sendUserMessage"]>[1],
	errorMessage: string,
	origin: PiSessionIdentity,
): void {
	if (trySendUserMessageToDifferentCurrentSession(content, options, errorMessage, origin)) return;

	try {
		pi.sendUserMessage(content, options);
		return;
	} catch (err) {
		if (trySendUserMessageToDifferentCurrentSession(content, options, errorMessage, origin)) return;
		throw err;
	}
}

export default function plannotator(pi: ExtensionAPI): void {
	const currentPiSession = registerCurrentPiSession(pi);
	let phase: Phase = "idle";
	void registerPlannotatorEventListeners(pi, {
		handlePlanMode: async (mode, ctx) => {
			if (mode === "status") return { phase };
			if (mode === "enter") {
				if (phase === "idle") await enterPlanning(ctx);
				return { phase };
			}
			if (mode === "exit") {
				if (phase !== "idle") await exitToIdle(ctx);
				return { phase };
			}
			await togglePlanMode(ctx);
			return { phase };
		},
	});
	let lastSubmittedPath: string | null = null;
	let approvedPlanHash: string | undefined;
	let approvalFeedback: string | undefined;
	let grillSummary: string | undefined;
	let checklistItems: ChecklistItem[] = [];
	let plannotatorConfig = {};
	let justEnteredGrill = false;
	// One-shot latch per phase entry: the phase framing message is delivered on
	// the first prompt of a phase and then lives in conversation history, so it
	// must never be re-sent on later prompts of the same phase. Reset at every
	// phase transition; persisted so session resume does not re-deliver.
	let framingDelivered = false;
	/**
	 * Cleared when this extension instance's session is torn down or replaced.
	 * Pi builds a fresh instance for the replacement session, so this latch only
	 * ever describes the session this closure was created for. It is the cheap
	 * front half of the staleness check; `isCtxAlive` covers teardown paths that
	 * never reach our `session_shutdown` handler.
	 */
	let sessionAlive = true;
	/** Resolved once per execution phase; undefined means widget-only. */
	let todoProvider: TodoProvider | undefined;
	/** Latch: no provider found, or one sync failed. Cleared on return to idle. */
	let todoProviderDisabled = false;

	pi.on("session_start", (_event, ctx) => {
		sessionAlive = true;
		currentPiSession.update(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionAlive = false;
		currentPiSession.clear();
		// Browser sessions deliberately outlive in-process session replacement so
		// a tab opened before /new can still deliver feedback to the replacement
		// session (withCurrentPiSessionFallbackHeader). On real process teardown
		// the OS frees the ports, and port self-preemption reclaims any stale
		// fixed-port session on the next command.
	});

	// ── Flags ────────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode (restricted exploration and planning)",
		type: "boolean",
		default: false,
	});

	// ── Helpers ──────────────────────────────────────────────────────────

	function getPhaseProfile(): ReturnType<typeof resolvePhaseProfile> | undefined {
		if (phase === "planning" || phase === "grilling" || phase === "executing") {
			return resolvePhaseProfile(plannotatorConfig, phase);
		}
		return undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const profile = getPhaseProfile();
		if (phase === "executing" && checklistItems.length > 0) {
			const completed = checklistItems.filter((t) => t.completed).length;
			ctx.ui.setStatus(
				"plannotator",
				ctx.ui.theme.fg("accent", `📋 ${completed}/${checklistItems.length}`),
			);
		} else if ((phase === "planning" || phase === "grilling") && profile?.statusLabel) {
			ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("warning", profile.statusLabel));
		} else if (phase === "executing" && profile?.statusLabel) {
			ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("accent", profile.statusLabel));
		} else {
			ctx.ui.setStatus("plannotator", undefined);
		}
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (phase === "executing" && checklistItems.length > 0) {
			const lines = checklistItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plannotator-progress", lines);
		} else {
			ctx.ui.setWidget("plannotator-progress", undefined);
		}
	}

	/**
	 * Mirror the checklist into an editable todo provider, when one is present.
	 *
	 * Additive by design: the progress widget above stays exactly as it was.
	 * pi-todos renders its list on demand in `/todos` and has no live surface,
	 * so replacing the widget with it would trade a visible tracker for files
	 * behind a keystroke. Failures are swallowed after one notification —
	 * a todo mirror must never break plan execution. Runs even when the
	 * checklist is empty so a resubmitted-empty plan still reconciles
	 * (closing todos it used to own) instead of leaving them orphaned.
	 */
	async function syncTodoProvider(ctx: ExtensionContext): Promise<void> {
		if (todoProviderDisabled) return;
		if (phase !== "executing" || !lastSubmittedPath) return;
		if (!todoProvider) {
			todoProvider = resolveTodoProvider(loadConfig(), {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
			});
			if (!todoProvider) {
				todoProviderDisabled = true;
				return;
			}
		}
		// Tag on the cwd-relative path: it is stable across machines and reads
		// cleanly in the /todos detail view, which renders raw tags.
		const planId = relative(ctx.cwd, resolve(ctx.cwd, lastSubmittedPath)) || lastSubmittedPath;
		try {
			await todoProvider.sync(checklistItems, planId);
		} catch (error) {
			todoProviderDisabled = true;
			ctx.ui.notify(
				`Plannotator: ${todoProvider.name} sync failed, continuing with the progress widget only. ${
					error instanceof Error ? error.message : String(error)
				}`,
				"warning",
			);
		}
	}

	function persistState(): void {
		pi.appendEntry("plannotator", {
			phase,
			lastSubmittedPath,
			approvedPlanHash,
			approvalFeedback,
			grillSummary,
			framingDelivered,
		});
	}

	async function refreshPhaseUi(ctx: ExtensionContext): Promise<void> {
		updateStatus(ctx);
		updateWidget(ctx);
		await syncTodoProvider(ctx);
	}

	async function enterPlanning(ctx: ExtensionContext): Promise<void> {
		phase = "planning";
		framingDelivered = false;
		lastSubmittedPath = null;
		approvedPlanHash = undefined;
		approvalFeedback = undefined;
		grillSummary = undefined;
		checklistItems = [];
		await refreshPhaseUi(ctx);
		persistState();
		ctx.ui.notify("Plannotator: planning mode enabled.");
		const warning = getPlanReviewAvailabilityWarning({ hasUI: ctx.hasUI, hasPlanHtml: hasPlanBrowserHtml() });
		if (warning) ctx.ui.notify(warning, "warning");
	}

	async function returnToIdle(ctx: ExtensionContext): Promise<void> {
		phase = "idle";
		framingDelivered = false;
		checklistItems = [];
		lastSubmittedPath = null;
		approvedPlanHash = undefined;
		approvalFeedback = undefined;
		grillSummary = undefined;
		todoProvider = undefined;
		todoProviderDisabled = false;
		await refreshPhaseUi(ctx);
		persistState();
	}

	async function exitToIdle(ctx: ExtensionContext): Promise<void> {
		await returnToIdle(ctx);
		ctx.ui.notify("Plannotator: disabled. Full access restored.");
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		if (phase === "idle") {
			await enterPlanning(ctx);
		} else {
			await exitToIdle(ctx);
		}
	}

	async function handoffApprovedPlan(
		ctx: ExtensionContext,
		planFilePath: string,
		planContent: string,
		feedback?: string,
	): Promise<void> {
		pi.appendEntry("plannotator-handoff", { planFilePath });
		await returnToIdle(ctx);
		pi.events.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd: ctx.cwd,
			planFilePath,
			planContent,
			...(feedback ? { feedback } : {}),
		} satisfies PlannotatorPlanApprovedEvent);
		ctx.ui.notify("Plannotator: grilled plan handed off for external execution.");
	}

	async function enterGrilling(
		ctx: ExtensionContext,
		planFilePath: string,
		planContent: string,
		feedback?: string,
	): Promise<void> {
		phase = "grilling";
		framingDelivered = false;
		lastSubmittedPath = planFilePath;
		approvedPlanHash = hashPlanContent(planContent);
		approvalFeedback = feedback;
		grillSummary = undefined;
		checklistItems = parseChecklist(planContent);
		pi.appendEntry("plannotator-grill", {
			planFilePath,
			approvedPlanHash,
			...(feedback ? { feedback } : {}),
		});
		await refreshPhaseUi(ctx);
		persistState();
		justEnteredGrill = true;
	}

	async function enterExecution(ctx: ExtensionContext, summary: string): Promise<void> {
		phase = "executing";
		framingDelivered = false;
		grillSummary = summary;
		pi.appendEntry("plannotator-execute", {
			lastSubmittedPath,
			approvedPlanHash,
			grillSummary,
		});
		await refreshPhaseUi(ctx);
		persistState();
	}
	// ── Commands & Shortcuts ─────────────────────────────────────────────

	pi.registerCommand("plannotator-plan-mode", {
		description: "Toggle plannotator planning mode",
		handler: async (_args, ctx) => {
			await togglePlanMode(ctx);
		},
	});

	pi.registerCommand("plannotator-review", {
		description: "Open interactive code review for current changes or a PR URL; pass --git or --gitbutler to force that provider",
		handler: async (args, ctx) => {
			if (!hasReviewBrowserHtml()) {
				ctx.ui.notify(
					"Code review UI not available. Run 'bun run build' in the pi-extension directory.",
					"error",
				);
				return;
			}

			currentPiSession.update(ctx);
			const origin = getPiSessionIdentity(ctx);

			try {
				const { parseReviewArgs } = await import("./generated/review-args.ts");
				const reviewArgs = parseReviewArgs(args ?? "");
				const session = await startCodeReviewBrowserSession(ctx, {
					prUrl: reviewArgs.prUrl,
					vcsType: reviewArgs.vcsType,
					useLocal: reviewArgs.useLocal,
				});
				ctx.ui.notify(sessionOpenedMessage("Code review opened", session.url), "info");
				void session
					.waitForDecision()
					.then(async (result) => {
						try {
							if (result.exit) {
								safeNotify(ctx, "Code review session closed.", "info", origin);
								return;
							}
							if (result.approved) {
								const { getReviewApprovedPrompt } = await loadPlannotatorPrompts();
								sendUserMessageWithCurrentSessionFallback(
									pi,
									getReviewApprovedPrompt("pi", loadConfig()),
									{ deliverAs: "followUp" },
									"Plannotator code review feedback could not be sent",
									origin,
								);
								return;
							}
							if (!result.feedback) {
								safeNotify(ctx, "Code review closed (no feedback).", "info", origin);
								return;
							}
							// Append the verification-only suffix when the reviewer sent
							// annotations to act on (PR mode included). Platform PR actions
							// (approve/comment posted to the host) come back with an empty
							// annotation set and a status message — don't tell the agent to
							// "address" a platform action.
							let reviewFeedback = result.feedback;
							if ((result.annotations?.length ?? 0) > 0) {
								const { getReviewDeniedSuffix } = await loadPlannotatorPrompts();
								reviewFeedback += getReviewDeniedSuffix("pi", loadConfig());
							}
							sendUserMessageWithCurrentSessionFallback(
								pi,
								reviewFeedback,
								{ deliverAs: "followUp" },
								"Plannotator code review feedback could not be sent",
								origin,
							);
						} catch (err) {
							reportBackgroundError(ctx, "Plannotator code review feedback could not be sent", err, origin);
						}
					})
					.catch((err) => {
						reportBackgroundError(ctx, "Plannotator code review session failed", err, origin);
					});
			} catch (err) {
				ctx.ui.notify(
					`Failed to start code review UI: ${getStartupErrorMessage(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("plannotator-annotate", {
		description: "Open markdown file or folder in annotation UI",
		handler: async (args, ctx) => {
			const {
				FILE_BROWSER_EXCLUDED,
				hasMarkdownFiles,
				parseAnnotateArgs,
				annotateInputNamesExistingTarget,
				buildAmbiguousAnnotateArgsMessage,
				buildUnresolvedAnnotateArgsMessage,
				probeAnnotateToken,
				selectAnnotateTokenTarget,
				resolveAtReference,
				resolveUserPath,
				isAnnotatableTextPath,
				getAnnotatableDocRegex,
				getAnnotatableExtensionsHint,
				MAX_ANNOTATABLE_FILE_BYTES,
			} = await loadAnnotateCommandModules();
			// Split known annotate flags from the path. --json is silently
			// accepted (Pi writes back via sendUserMessage, not stdout).
			// `rawFilePath` keeps any leading `@` for the literal-@ fallback
			// (scoped-package-style names).
			let { filePath, rawFilePath, gate, renderHtml: renderHtmlFlag, renderMarkdown: renderMarkdownFlag, noJina } = parseAnnotateArgs(args ?? "");
			if (!filePath) {
				ctx.ui.notify("Usage: /plannotator-annotate <file.md | file.txt | file.html | https://... | folder/> [--markdown] [--no-jina] [--gate] [--json]", "error");
				return;
			}

			// Tolerant fallback (#1182): when the whole argument string names
			// nothing, probe each token; exactly one existing target proceeds,
			// several is an error, several unresolvable words get an actionable
			// message instead of "File not found: the". Bare directory names
			// only count in the sole-arg pre-pass, and unrecognized
			// dash-prefixed tokens disable tolerance so a typo'd flag errors
			// the way it always did.
			if (!annotateInputNamesExistingTarget(rawFilePath, ctx.cwd)) {
				const selection = selectAnnotateTokenTarget(rawFilePath, (token: string) =>
					probeAnnotateToken(token, ctx.cwd, { bareDirectories: false }),
				);
				if (selection.kind === "single") {
					filePath = selection.candidate.value;
					rawFilePath = selection.candidate.value;
				} else if (selection.kind === "multiple") {
					ctx.ui.notify(buildAmbiguousAnnotateArgsMessage(selection.candidates), "error");
					return;
				} else if (selection.kind === "none" && selection.words.length > 1) {
					// Content flags only; --gate is transport for this
					// invocation, not a property of the target.
					const tolerantFlags = [
						...(renderMarkdownFlag ? ["--markdown"] : []),
						...(noJina ? ["--no-jina"] : []),
						...(renderHtmlFlag ? ["--render-html"] : []),
					];
					ctx.ui.notify(buildUnresolvedAnnotateArgsMessage({ words: selection.words, flags: tolerantFlags }), "error");
					return;
				}
				// "flagged" (unrecognized dash tokens) or a single unresolvable
				// word falls through to the existing pipeline so its specific
				// errors stay verbatim.
			}
			if (!hasPlanBrowserHtml()) {
				ctx.ui.notify(
					"Annotation UI not available. Run 'bun run build' in the pi-extension directory.",
					"error",
				);
				return;
			}

			let markdown: string;
			let rawHtml: string | undefined;
			let absolutePath: string;
			let folderPath: string | undefined;
			let mode: "annotate" | "annotate-folder" | undefined;
			let sourceInfo: string | undefined;
			let sourceConverted = false;
			let isFolder = false;

			// --- URL annotation ---
			const isUrl = /^https?:\/\//i.test(filePath);

			if (isUrl) {
				const useJina = resolveUseJina(noJina, loadConfig());
				ctx.ui.notify(`Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}...`, "info");
				try {
					const { isConvertedSource, urlToMarkdown } = await import("./generated/url-to-markdown.ts");
					const result = await urlToMarkdown(filePath, { useJina });
					markdown = result.markdown;
					sourceConverted = isConvertedSource(result.source);
				} catch (err) {
					ctx.ui.notify(`Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				absolutePath = filePath;
				sourceInfo = filePath;
			} else {
				// Pick the interpretation of the user input that actually exists:
				// stripped form first (reference-mode primary), literal as fallback
				// for scoped-package-style names. Falls back to the stripped form
				// for the error message if neither exists.
				const resolvedCandidate = resolveAtReference(rawFilePath, (c) => {
					const abs = resolveUserPath(c, ctx.cwd);
					return existsSync(abs);
				});
				if (resolvedCandidate === null) {
					absolutePath = resolveUserPath(filePath, ctx.cwd);
					ctx.ui.notify(`File not found: ${absolutePath}`, "error");
					return;
				}
				absolutePath = resolveUserPath(resolvedCandidate, ctx.cwd);

				try {
					isFolder = statSync(absolutePath).isDirectory();
				} catch {
					ctx.ui.notify(`Cannot access: ${absolutePath}`, "error");
					return;
				}

				if (isFolder) {
					if (!hasMarkdownFiles(absolutePath, FILE_BROWSER_EXCLUDED, getAnnotatableDocRegex())) {
						ctx.ui.notify(`No annotatable files (markdown, plain-text, config, or HTML) found in ${absolutePath}`, "error");
						return;
					}
					markdown = "";
					folderPath = absolutePath;
					mode = "annotate-folder";
					ctx.ui.notify(`Opening annotation UI for folder ${filePath}...`, "info");
				} else if (/\.html?$/i.test(absolutePath)) {
					const html = readFileSync(absolutePath, "utf-8");
					const renderHtmlForFile = !renderMarkdownFlag;
					if (renderHtmlForFile) {
						rawHtml = html;
						markdown = "";
					} else {
						const { htmlToMarkdown } = await import("./generated/html-to-markdown.ts");
						markdown = htmlToMarkdown(html);
						sourceConverted = true;
					}
					sourceInfo = basename(absolutePath);
					ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");
				} else {
					if (!isAnnotatableTextPath(absolutePath)) {
						ctx.ui.notify(`File type not supported. Supported types: ${getAnnotatableExtensionsHint()}`, "error");
						return;
					}
					if (statSync(absolutePath).size > MAX_ANNOTATABLE_FILE_BYTES) {
						ctx.ui.notify(`File too large to annotate (max 2MB): ${absolutePath}`, "error");
						return;
					}
					markdown = readFileSync(absolutePath, "utf-8");
					ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");
				}
			}

			currentPiSession.update(ctx);
			const origin = getPiSessionIdentity(ctx);

			try {
				const session = await startMarkdownAnnotationSession(
					ctx,
					absolutePath,
					markdown,
					mode ?? "annotate",
					folderPath,
					sourceInfo,
					sourceConverted,
					gate,
					rawHtml,
					!!rawHtml,
					renderMarkdownFlag,
				);
				ctx.ui.notify(sessionOpenedMessage("Annotation opened", session.url), "info");
				void session
					.waitForDecision()
					.then(async (result) => {
						try {
							const outcome = classifyAnnotateOutcome(result);
							if (outcome.notification === "closed") {
								safeNotify(ctx, "Annotation session closed.", "info", origin);
								return;
							}
							if (!outcome.feedback) {
								if (outcome.notification === "approved") {
									safeNotify(ctx, "Annotation approved.", "info", origin);
									return;
								}
								safeNotify(ctx, "Annotation closed (no feedback).", "info", origin);
								return;
							}
							const {
								getAnnotateApprovedWithNotesPrompt,
								getAnnotateFileFeedbackPrompt,
							} = await loadPlannotatorPrompts();
							const context = `${isFolder ? "Folder" : "File"}: ${absolutePath}`;
							const prompt = outcome.promptKind === "approved-with-notes"
								? getAnnotateApprovedWithNotesPrompt("pi", loadConfig(), {
										context,
										feedback: outcome.feedback,
									})
								: getAnnotateFileFeedbackPrompt("pi", loadConfig(), {
										fileHeader: isFolder ? "Folder" : "File",
										filePath: absolutePath,
										feedback: outcome.feedback,
									});
							sendUserMessageWithCurrentSessionFallback(
								pi,
								prompt,
								{ deliverAs: "followUp" },
								"Plannotator annotation feedback could not be sent",
								origin,
							);
							if (outcome.notification === "approved") {
								safeNotify(ctx, "Annotation approved.", "info", origin);
							}
						} catch (err) {
							reportBackgroundError(ctx, "Plannotator annotation feedback could not be sent", err, origin);
						}
					})
					.catch((err) => {
						reportBackgroundError(ctx, "Plannotator annotation session failed", err, origin);
					});
			} catch (err) {
				ctx.ui.notify(
					`Failed to start annotation UI: ${getStartupErrorMessage(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("plannotator-last", {
		description: "Annotate the last assistant message",
		handler: async (args, ctx) => {
			// Support --gate on /plannotator-last for the Stop-hook review gate.
			const { parseAnnotateArgs } = await import("./generated/annotate-args.ts");
			const { gate } = parseAnnotateArgs(args ?? "");

			if (!hasPlanBrowserHtml()) {
				ctx.ui.notify(
					"Annotation UI not available. Run 'bun run build' in the pi-extension directory.",
					"error",
				);
				return;
			}

			currentPiSession.update(ctx);
			const origin = getPiSessionIdentity(ctx);

			const snapshot = getLastAssistantMessageSnapshot(ctx);
			if (!snapshot) {
				ctx.ui.notify("No assistant message found in session.", "error");
				return;
			}

			const recent = getRecentAssistantMessages(ctx, 25);
			const pickerMessages = recent.length > 1 ? recent : undefined;

			ctx.ui.notify("Opening annotation UI for last message...", "info");

			try {
				const session = await startLastMessageAnnotationSession(ctx, snapshot.text, gate, pickerMessages);
				ctx.ui.notify(sessionOpenedMessage("Last-message annotation opened", session.url), "info");
				void session
					.waitForDecision()
					.then(async (result) => {
						try {
							const outcome = classifyAnnotateOutcome(result);
							if (outcome.notification === "closed") {
								safeNotify(ctx, "Annotation session closed.", "info", origin);
								return;
							}
							if (!outcome.feedback) {
								if (outcome.notification === "approved") {
									safeNotify(ctx, "Message approved.", "info", origin);
									return;
								}
								safeNotify(ctx, "Annotation closed (no feedback).", "info", origin);
								return;
							}
							// Picker may have changed which message the feedback targets; if so,
							// look that one up in the current branch so the anchor quote matches.
							const target = result.selectedMessageId && result.selectedMessageId !== snapshot.entryId
								? findAssistantMessageByEntryId(ctx, result.selectedMessageId) ?? snapshot
								: snapshot;
							const feedback = result.feedbackScope !== "messages" && shouldAnchorLastMessageFeedback(ctx, target.entryId, origin)
									? anchorMessageFeedback(outcome.feedback, target.text)
									: outcome.feedback;
							const {
								getAnnotateApprovedWithNotesPrompt,
								getAnnotateMessageFeedbackPrompt,
							} = await loadPlannotatorPrompts();
							const prompt = outcome.promptKind === "approved-with-notes"
								? getAnnotateApprovedWithNotesPrompt("pi", loadConfig(), {
										feedback,
									})
								: getAnnotateMessageFeedbackPrompt("pi", loadConfig(), {
										feedback,
									});
							sendUserMessageWithCurrentSessionFallback(
								pi,
								prompt,
								{ deliverAs: "followUp" },
								"Plannotator message annotation feedback could not be sent",
								origin,
							);
							if (outcome.notification === "approved") {
								safeNotify(ctx, "Message approved.", "info", origin);
							}
						} catch (err) {
							reportBackgroundError(ctx, "Plannotator message annotation feedback could not be sent", err, origin);
						}
					})
					.catch((err) => {
						reportBackgroundError(ctx, "Plannotator message annotation session failed", err, origin);
					});
			} catch (err) {
				ctx.ui.notify(
					`Failed to start annotation UI: ${getStartupErrorMessage(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plannotator",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
		},
	});

	// Shift+Tab cycles plan mode (normal <-> planning), Claude Code style.
	// Pi's default shift+tab (app.thinking.cycle) is remapped to alt+t in
	// ~/.pi/agent/keybindings.json so this shortcut can own the key.
	pi.registerShortcut(Key.shift("tab"), {
		description: "Cycle plan mode (normal <-> planning)",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
		},
	});

	// ── plannotator_submit_plan Tool ────────────────────────────────────

	pi.registerTool({
		name: PLAN_SUBMIT_TOOL,
		label: "Submit Plan",
		description:
			"Submit a markdown plan for mandatory browser review. " +
			"Use tmp/plans/<descriptive-kebab-case-slug>.md by default unless applicable AGENTS or the user specifies another markdown path inside cwd. " +
			"Approval begins a human docs/code grill; it never starts implementation directly. " +
			"If denied or changed during grilling, edit the same file and submit it again.",
		parameters: Type.Object({
			filePath: Type.String({
				description:
					"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
			}),
		}) as any,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Revised plans may be resubmitted directly from the grilling phase.
			if (phase !== "planning" && phase !== "grilling") {
				return {
					content: [
						{
							type: "text",
							text: "Error: Not in plan mode. Use /plannotator-plan-mode to enter planning mode first.",
						},
					],
					details: { approved: false },
				};
			}

			const inputPath = (params as { filePath?: string })?.filePath?.trim();
			if (!inputPath) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${PLAN_SUBMIT_TOOL} requires a filePath argument (default: "tmp/plans/<slug>.md").`,
						},
					],
					details: { approved: false },
				};
			}

			if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: plan file must be a markdown file (.md or .mdx) inside the working directory. Rejected: ${inputPath}`,
						},
					],
					details: { approved: false },
				};
			}

			const fullPath = resolve(ctx.cwd, inputPath);

			try {
				if (!statSync(fullPath).isFile()) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${inputPath} is not a regular file. Write your plan to a markdown file first, then call ${PLAN_SUBMIT_TOOL} with its path.`,
							},
						],
						details: { approved: false },
					};
				}
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} does not exist. Write your plan using the write tool first, then call ${PLAN_SUBMIT_TOOL} again.`,
						},
					],
					details: { approved: false },
				};
			}

			let planContent: string;
			try {
				planContent = readFileSync(fullPath, "utf-8");
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { approved: false },
				};
			}

			if (planContent.trim().length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} is empty. Write your plan first, then call ${PLAN_SUBMIT_TOOL} again.`,
						},
					],
					details: { approved: false },
				};
			}

			lastSubmittedPath = inputPath;
			checklistItems = parseChecklist(planContent);

			if (!ctx.hasUI || !hasPlanBrowserHtml()) {
				const reason = getPlanReviewAvailabilityWarning({
					hasUI: ctx.hasUI,
					hasPlanHtml: hasPlanBrowserHtml(),
				});
				return {
					content: [{ type: "text", text: reason ?? "Interactive plan review is unavailable." }],
					details: { approved: false, reviewUnavailable: true },
				};
			}

			let result: Awaited<ReturnType<typeof openPlanReviewBrowser>>;
			try {
				result = await openPlanReviewBrowser(ctx, planContent, signal);
			} catch (err) {
				// A stopped session is an outcome, not a startup failure: the review
				// was closed (cancellation or port self-preemption) before a decision.
				if (isBrowserSessionStoppedError(err)) {
					ctx.ui.notify("Plan review session was closed before a decision.", "info");
					return {
						content: [
							{
								type: "text",
								text: "The plan review browser session was closed before a decision was made. The plan was neither approved nor rejected; resubmit to reopen review.",
							},
						],
						details: { approved: false },
					};
				}
				const message = `Failed to start plan review UI: ${getStartupErrorMessage(err)}`;
				ctx.ui.notify(message, "error");
				return {
					content: [{ type: "text", text: message }],
					details: { approved: false },
				};
			}

			if (result.approved) {
				await enterGrilling(ctx, inputPath, planContent, result.feedback);
				return {
					content: [
						{
							type: "text",
							text:
								"Plan approved. Implementation remains locked until the mandatory docs/code grill completes. " +
								"If grilling changes the plan, revise and submit it for browser review again.",
						},
					],
					details: {
						approved: true,
						grilling: true,
						approvedPlanHash,
						...(result.feedback ? { feedback: result.feedback } : {}),
					},
					terminate: true,
				};
			}

			// Denied plans return to planning and must earn a fresh approved hash.
			phase = "planning";
			framingDelivered = false;
			approvedPlanHash = undefined;
			approvalFeedback = undefined;
			grillSummary = undefined;
			await refreshPhaseUi(ctx);
			persistState();
			const feedbackText = result.feedback || "Plan rejected. Please revise.";
			const { buildPlanFileRule, getPlanDeniedPrompt, getPlanToolName } = await loadPlannotatorPrompts();
			return {
				content: [
					{
						type: "text",
						text: getPlanDeniedPrompt("pi", loadConfig(), {
							toolName: getPlanToolName("pi"),
							planFileRule: buildPlanFileRule(getPlanToolName("pi"), inputPath),
							feedback: feedbackText,
						}),
					},
				],
				details: { approved: false, feedback: feedbackText },
			};
		},
	});

	pi.registerTool({
		name: GRILL_FINISH_TOOL,
		label: "Finish Grill",
		description:
			"Complete the mandatory human docs/code grill after explicit user confirmation. " +
			"The approved plan must be unchanged; changed plans must be resubmitted for browser review.",
		parameters: Type.Object({
			confirmed: Type.Boolean({
				description: "True only after the user explicitly confirms shared understanding.",
			}),
			summary: Type.String({
				description: "Concise summary of the resolved grill decisions.",
			}),
		}) as any,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as { confirmed?: boolean; summary?: string };
			if (!lastSubmittedPath) {
				return {
					content: [{ type: "text", text: "No approved plan is available for grilling." }],
					details: { completed: false },
				};
			}

			let planContent: string;
			try {
				planContent = readFileSync(resolve(ctx.cwd, lastSubmittedPath), "utf-8");
			} catch (error) {
				return {
					content: [{
						type: "text",
						text: `Cannot finish grilling because the approved plan is unreadable: ${error instanceof Error ? error.message : String(error)}`,
					}],
					details: { completed: false },
				};
			}

			const validation = validateGrillCompletion({
				phase,
				confirmed: input.confirmed === true,
				approvedPlanHash,
				planContent,
			});
			if (!validation.ok) {
				const messages = {
					"not-grilling": "The grill can only finish during the grilling phase.",
					"not-confirmed": "Explicit user confirmation is required before implementation.",
					"missing-approval": "No browser-approved plan hash is recorded; submit the plan for review.",
					"plan-changed": `The plan changed after approval. Call ${PLAN_SUBMIT_TOOL} with ${lastSubmittedPath} and complete browser re-review.`,
				} as const;
				return {
					content: [{ type: "text", text: messages[validation.reason] }],
					details: { completed: false, reason: validation.reason },
				};
			}

			const summary = input.summary?.trim();
			if (!summary) {
				return {
					content: [{ type: "text", text: "A concise grill decision summary is required." }],
					details: { completed: false },
				};
			}

			grillSummary = summary;
			checklistItems = parseChecklist(planContent);
			pi.appendEntry("plannotator-grill-complete", {
				planFilePath: lastSubmittedPath,
				approvedPlanHash,
				grillSummary,
			});

			if (resolveExecutionMode(plannotatorConfig) === "external") {
				await handoffApprovedPlan(ctx, lastSubmittedPath, planContent, approvalFeedback);
				return {
					content: [{ type: "text", text: "Grill complete. The approved plan was handed off for external execution." }],
					details: { completed: true, handedOff: true, summary },
					terminate: true,
				};
			}

			await enterExecution(ctx, summary);
			return {
				content: [{
					type: "text",
					text: `Grill complete. Implementation is unlocked for ${lastSubmittedPath}. Follow the approved plan and applicable AGENTS instructions.`,
				}],
				details: { completed: true, summary, planFilePath: lastSubmittedPath },
			};
		},
	});

	// ── Event Handlers ───────────────────────────────────────────────────

	// Keep implementation locked during planning and grilling without disabling Pi tools.
	pi.on("tool_call", async (event, ctx) => {
		if (!isPreImplementationPhase(phase)) return;
		const inputPath = getFileMutationPath(event.toolName, event.input);
		if (!inputPath || isPlanWritePathAllowed(inputPath, ctx.cwd)) return;

		return {
			block: true,
			reason: `Plannotator: during ${phase}, ${event.toolName} is limited to markdown files inside cwd. Blocked: ${inputPath}`,
		};
	});

	// Deliver phase framing once per phase entry, plus per-turn todo status.
	// Plannotator never returns or modifies systemPrompt: Pi's base prompt
	// (AGENTS.md context, skills catalog, tools guidance, user append text) is
	// left untouched, and cache-busting reduces to conversation-suffix appends
	// (#922, approach suggested by Karrq).
	pi.on("before_agent_start", async (_event, ctx) => {
		if (phase !== "planning" && phase !== "grilling" && phase !== "executing") return;

		const profile = getPhaseProfile();
		const planRef = lastSubmittedPath ?? "your plan file";

		if (phase === "executing" && lastSubmittedPath) {
			// Re-read from disk each turn to stay current
			const fullPath = resolve(ctx.cwd, lastSubmittedPath);
			try {
				const planContent = readFileSync(fullPath, "utf-8");
				checklistItems = parseChecklist(planContent);
			} catch {
				// File deleted during execution — degrade gracefully
			}
		}

		const todoStats = phase === "executing" ? formatTodoList(checklistItems) : formatTodoList([]);
		// The closing line restates the completion-marker convention so the
		// protocol survives even when compaction has swallowed the framing and
		// re-delivery has not happened yet.
		const todoStatus =
			phase === "executing" && todoStats.remainingCount > 0
				? `[PLANNOTATOR - EXECUTING PLAN]
Todo status for ${planRef}: ${todoStats.completedCount}/${todoStats.totalCount} steps complete.

Remaining steps:
${todoStats.todoList}

Mark completed steps with [DONE:n] in your response.`
				: null;

		if (framingDelivered) {
			// Same phase, later prompt: the framing already sits in conversation
			// history, so inject nothing beyond the small todo snapshot during
			// execution.
			if (!todoStatus) return;
			return {
				message: {
					customType: "plannotator-context",
					content: todoStatus,
					display: false,
				},
			};
		}

		framingDelivered = true;
		persistState();

		if (!profile?.instructions) {
			// Framing explicitly disabled (instructions null/empty): deliver only
			// the todo snapshot during execution, nothing during planning.
			if (!todoStatus) return;
			return {
				message: {
					customType: "plannotator-context",
					content: todoStatus,
					display: false,
				},
			};
		}

		const rendered = renderTemplate(
			profile.instructions,
			buildPromptVariables({
				planFilePath: planRef,
				phase,
				todoList: todoStats.todoList,
				completedCount: todoStats.completedCount,
				totalCount: todoStats.totalCount,
				remainingCount: todoStats.remainingCount,
			}),
		);
		if (rendered.unknownVariables.length > 0) {
			ctx.ui.notify(
				"Plannotator: unknown template variables in " + phase + " instructions: " + rendered.unknownVariables.join(", "),
				"warning",
			);
		}

		let content = rendered.text;
		if (phase === "grilling" && approvalFeedback) {
			content += `\n\nBrowser approval notes:\n${approvalFeedback}`;
		}
		if (phase === "planning") {
			const hook = readImprovementHook("enterplanmode-improve");
			const pfmEnabled = loadConfig().pfmReminder === true;
			const improveContext = composeImproveContext({
				pfmEnabled,
				improvementHookContent: hook?.content ?? null,
			});
			if (improveContext) content += "\n\n---\n\n" + improveContext;
		}
		// Instructions render an entry-time todo snapshot when they reference
		// ${todoList}; otherwise append the snapshot so the first executing
		// prompt still carries the checklist.
		if (todoStatus && !profile.instructions.includes("${todoList}")) {
			content += "\n\n" + todoStatus;
		}

		return {
			message: {
				customType: "plannotator-framing",
				content,
				display: false,
				details: { phase },
			},
		};
	});

	// Keep plannotator conversation messages coherent with the current phase.
	// While idle, everything plannotator injected is filtered out (as before).
	// During a phase, only the newest framing for the CURRENT phase survives:
	// framing from other phases or earlier cycles is dropped (stale planning
	// rules cannot leak into execution), along with todo-status messages that
	// predate the current cycle's framing. The filter is deterministic within a
	// phase, so it never perturbs the provider's cached prefix mid-phase; the
	// only mid-history changes happen at phase transitions.
	pi.on("context", async (event) => {
		if (phase === "idle") {
			return {
				messages: event.messages.filter((m) => {
					const msg = m as { customType?: string; role?: string; content?: unknown };
					if (msg.customType === "plannotator-framing") return false;
					if (msg.customType === "plannotator-context") return false;
					if (msg.role !== "user") return true;

					const content = msg.content;
					if (typeof content === "string") {
						return !content.includes("[PLANNOTATOR -");
					}
					if (Array.isArray(content)) {
						return !content.some(
							(c) =>
								c.type === "text" &&
								(c as { text?: string }).text?.includes("[PLANNOTATOR -"),
						);
					}
					return true;
				}),
			};
		}

		let anchor = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i] as { customType?: string; details?: unknown };
			if (
				msg.customType === "plannotator-framing" &&
				(msg.details as { phase?: string } | undefined)?.phase === phase
			) {
				anchor = i;
				break;
			}
		}

		return {
			messages: event.messages.filter((m, index) => {
				const msg = m as { customType?: string };
				if (msg.customType === "plannotator-framing") return index === anchor;
				if (msg.customType === "plannotator-context") return anchor === -1 || index > anchor;
				return true;
			}),
		};
	});

	// Track execution progress
	pi.on("turn_end", async (event, ctx) => {
		if (phase !== "executing" || checklistItems.length === 0) return;

		const text = getAssistantMessageText(event.message);
		if (!text) return;
		if (markCompletedSteps(text, checklistItems) > 0) {
			updateStatus(ctx);
			updateWidget(ctx);
			await syncTodoProvider(ctx);
		}
		persistState();
	});

	// Detect execution completion
	pi.on("agent_end", async (_event, ctx) => {
		if (phase === "grilling" && justEnteredGrill) {
			justEnteredGrill = false;
			let attempts = 0;
			const continueWhenIdle = (): void => {
				// This poll outlives the turn that scheduled it, so the session can be
				// replaced or disposed underneath it — print-mode teardown, /new,
				// /reload. Both `ctx` and `pi` are invalidated at that moment and every
				// call on them throws; an uncaught throw inside a timer callback takes
				// the entire pi process down (issue #1140).
				//
				// Cancel rather than retarget: the continuation belongs to the session
				// that approved this plan. A replacement session is a different
				// conversation with no approved plan in it, so nudging it to "continue"
				// would be wrong even though `pi` there is perfectly live.
				if (!sessionAlive || !isCtxAlive(ctx)) return;
				try {
					if (!ctx.isIdle()) {
						attempts += 1;
						if (attempts <= 200) setTimeout(continueWhenIdle, 50);
						return;
					}
					pi.sendUserMessage(
						"Begin the mandatory docs/code grill for the approved plan. Resolve facts through investigation, ask one recommended decision question at a time, and do not implement.",
					);
				} catch (err) {
					// Lost the race between the liveness probe and the call, or the host
					// failed the send for some other reason. Report, never rethrow.
					if (isCtxAlive(ctx)) {
						console.error(
							`Plannotator: could not start the mandatory grill: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			};
			setTimeout(continueWhenIdle, 0);
			return;
		}

		if (phase !== "executing" || checklistItems.length === 0) return;

		if (checklistItems.every((t) => t.completed)) {
			const completedList = checklistItems
				.map((t) => `- [x] ~~${t.text}~~`)
				.join("\n");
			pi.sendMessage(
				{
					customType: "plannotator-complete",
					content: `**Plan Complete!** ✓\n\n${completedList}`,
					display: true,
				},
				{ triggerTurn: false },
			);
			await returnToIdle(ctx);
		}
	});

	// Restore state on session start/resume
	/**
	 * Re-derive phase, framing latch, and checklist state from the ACTIVE
	 * session path (root to current leaf). Shared by session_start (resume) and
	 * session_tree (branch navigation): a branch switch can land on a path
	 * whose plannotator state differs from memory, or where the delivered
	 * framing message is absent because it lives on another branch.
	 */
	async function resyncPhaseFromSession(
		ctx: ExtensionContext,
		options: { phaseWhenUnrecorded: Phase; warnOnPlanning: boolean },
	): Promise<void> {
		const entries = ctx.sessionManager.getBranch();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plannotator",
			)
			.pop() as { data?: PersistedPlannotatorState } | undefined;

		if (stateEntry?.data) {
			phase = stateEntry.data.phase ?? options.phaseWhenUnrecorded;
			lastSubmittedPath = stateEntry.data.lastSubmittedPath ?? lastSubmittedPath;
			approvedPlanHash = stateEntry.data.approvedPlanHash;
			approvalFeedback = stateEntry.data.approvalFeedback;
			grillSummary = stateEntry.data.grillSummary;
			framingDelivered = stateEntry.data.framingDelivered ?? false;
			if (phase === "grilling" && !framingDelivered) justEnteredGrill = true;
		} else {
			phase = options.phaseWhenUnrecorded;
			lastSubmittedPath = null;
			approvedPlanHash = undefined;
			approvalFeedback = undefined;
			grillSummary = undefined;
			framingDelivered = false;
		}

		// Rebuild active plan state from disk and execution messages.
		if (phase === "grilling" || phase === "executing") {
			if (lastSubmittedPath) {
				const fullPath = resolve(ctx.cwd, lastSubmittedPath);
				if (existsSync(fullPath)) {
					const content = readFileSync(fullPath, "utf-8");
					checklistItems = phase === "executing" ? parseChecklist(content) : [];

					if (phase === "executing") {
						let executeIndex = -1;
						for (let i = entries.length - 1; i >= 0; i--) {
							const entry = entries[i] as { type: string; customType?: string };
							if (entry.customType === "plannotator-execute") {
								executeIndex = i;
								break;
							}
						}

						for (let i = executeIndex + 1; i < entries.length; i++) {
							const entry = entries[i];
							if (entry.type === "message" && "message" in entry) {
								const text = getAssistantMessageText(entry.message);
								if (text) markCompletedSteps(text, checklistItems);
							}
						}
					}
				} else {
					phase = "planning";
					lastSubmittedPath = null;
					approvedPlanHash = undefined;
					approvalFeedback = undefined;
					grillSummary = undefined;
				}
			} else {
				phase = "planning";
				approvedPlanHash = undefined;
				approvalFeedback = undefined;
				grillSummary = undefined;
			}
		}

		if (phase === "planning" || phase === "grilling") {
			checklistItems = [];
			if (options.warnOnPlanning) {
				const warning = getPlanReviewAvailabilityWarning({ hasUI: ctx.hasUI, hasPlanHtml: hasPlanBrowserHtml() });
				if (warning) {
					ctx.ui.notify(warning, "warning");
				}
			}
		}

		await refreshPhaseUi(ctx);
		persistState();
	}

	pi.on("session_start", async (_event, ctx) => {
		const trustFn = ctx.isProjectTrusted as (() => boolean) | undefined;
		const projectTrusted = typeof trustFn === "function" ? trustFn.call(ctx) : false;
		if (typeof trustFn !== "function") {
			ctx.ui.notify(
				"Plannotator requires Pi 0.79.1 or newer. Update Pi; project-local config is disabled on this host.",
				"warning",
			);
		}
		const loadedConfig = loadPlannotatorConfig(ctx.cwd, {
			projectTrusted,
		});
		plannotatorConfig = loadedConfig.config;
		for (const warning of loadedConfig.warnings) {
			ctx.ui.notify(`Plannotator config: ${warning}`, "warning");
		}

		// Check --plan flag
		if (pi.getFlag("plan") === true) {
			phase = "planning";
		}

		await resyncPhaseFromSession(ctx, { phaseWhenUnrecorded: phase, warnOnPlanning: true });
	});

	// Compaction summarizes conversation history and can swallow the delivered
	// framing message (custom messages are ordinary compactable messages), so
	// reopen the latch: the next prompt re-delivers the phase framing. If the
	// framing survived in the kept tail, the context filter keeps only the
	// newest copy, so re-delivery never duplicates.
	pi.on("session_compact", async () => {
		if (phase !== "planning" && phase !== "grilling" && phase !== "executing") return;
		framingDelivered = false;
		persistState();
	});

	// A /tree branch switch changes the active path out from under the latch:
	// the new path can carry different phase state, or lack the framing message
	// that was delivered on the abandoned branch. Re-derive everything from the
	// new path; a path with no plannotator state at all means idle.
	pi.on("session_tree", async (_event, ctx) => {
		await resyncPhaseFromSession(ctx, { phaseWhenUnrecorded: "idle", warnOnPlanning: false });
	});
}
