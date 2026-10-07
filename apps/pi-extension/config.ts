import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DEFAULT_MODEL_ROUTING, type ModelRoutingSettings, TIER_NAME } from "./model-routing.ts";

export type PhaseName = "planning" | "grilling" | "executing" | "reviewing";
export type RuntimePhase = PhaseName | "idle";
export type ExecutionMode = "automatic" | "external";

/**
 * Config values loaded from JSON can intentionally clear inherited values.
 *
 * - `null` clears a value from a parent config.
 * - `""` clears string values.
 */
export interface PhaseProfile {
  statusLabel?: string | null;
  /**
   * Phase framing template, delivered ONCE as a conversation message when the
   * phase is entered. Plannotator never modifies Pi's system prompt (#922);
   * the obsolete `systemPrompt` config key is ignored with a warning.
   */
  instructions?: string | null;
}

export interface ModelRoutingConfig {
  enabled?: boolean;
  planningTier?: string;
  phaseTiers?: string[];
  systemOneUrl?: string;
  systemOneModel?: string;
  minProbability?: number;
  timeoutMs?: number;
  reviewers?: { anthropic?: string; openai?: string };
  criteria?: Record<string, string>;
}

export interface PlannotatorConfig {
  executionMode?: ExecutionMode | null;
  defaults?: PhaseProfile | null;
  phases?: Partial<Record<PhaseName, PhaseProfile | null>>;
  modelRouting?: ModelRoutingConfig;
}

export interface LoadedPlannotatorConfig {
  config: PlannotatorConfig;
  warnings: string[];
}

export interface LoadPlannotatorConfigOptions {
  /** Whether Pi approved project-local inputs for this working directory. */
  projectTrusted: boolean;
}

export interface ResolvedPhaseProfile {
  statusLabel?: string;
  instructions?: string;
}

export interface PromptVariables {
  planFilePath: string;
  todoList: string;
  completedCount: number;
  totalCount: number;
  remainingCount: number;
  phase: RuntimePhase;
}

export interface PromptRenderResult {
  text: string;
  unknownVariables: string[];
}

const INTERNAL_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "plannotator.json");
const PHASES: PhaseName[] = ["planning", "grilling", "executing", "reviewing"];

function getAgentConfigDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  return join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): { data?: unknown; error?: string } {
  if (!existsSync(path)) return {};

  try {
    return { data: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (error) {
    return { error: `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function normalizeLabel(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePrompt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.length > 0 ? value : null;
}

function normalizeProfile(raw: unknown): PhaseProfile | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;

  const profile: PhaseProfile = {};

  if ("statusLabel" in raw) profile.statusLabel = normalizeLabel(raw.statusLabel);
  if ("instructions" in raw) profile.instructions = normalizePrompt(raw.instructions);

  return profile;
}

function cloneProfile(profile: PhaseProfile | null | undefined): PhaseProfile | null | undefined {
  if (profile === null || profile === undefined) return profile;
  return { ...profile };
}

function mergeProfile(base: PhaseProfile | null | undefined, override: PhaseProfile | null | undefined): PhaseProfile | null | undefined {
  if (override === null) return null;
  if (override === undefined) return cloneProfile(base);
  if (base === null || base === undefined) return cloneProfile(override);

  const merged: PhaseProfile = {
    statusLabel: override.statusLabel !== undefined ? override.statusLabel : base.statusLabel,
    instructions: override.instructions !== undefined ? override.instructions : base.instructions,
  };

  return merged;
}

function mergeConfig(base: PlannotatorConfig, override: PlannotatorConfig): PlannotatorConfig {
  const phases: Partial<Record<PhaseName, PhaseProfile | null>> = {};
  for (const phase of PHASES) {
    const merged = mergeProfile(base.phases?.[phase], override.phases?.[phase]);
    if (merged !== undefined) phases[phase] = merged;
  }

  return {
    executionMode: override.executionMode !== undefined ? override.executionMode : base.executionMode,
    defaults: mergeProfile(base.defaults, override.defaults),
    phases: Object.keys(phases).length > 0 ? phases : undefined,
    modelRouting: mergeModelRouting(base.modelRouting, override.modelRouting),
  };
}

function mergeModelRouting(base: ModelRoutingConfig | undefined, override: ModelRoutingConfig | undefined): ModelRoutingConfig | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
    reviewers: base.reviewers || override.reviewers ? { ...base.reviewers, ...override.reviewers } : undefined,
    criteria: base.criteria || override.criteria ? { ...base.criteria, ...override.criteria } : undefined,
  };
}

const MAX_TIMER_MS = 2_147_483_647;

function normalizeModelRouting(raw: unknown, path: string, warnings: string[]): ModelRoutingConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push(`Ignoring modelRouting in ${path}: expected an object.`);
    return undefined;
  }
  const config: ModelRoutingConfig = {};
  const reject = (key: string, expected: string) => warnings.push(`Ignoring modelRouting.${key} in ${path}: expected ${expected}.`);
  const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const tierName = (value: unknown): value is string => typeof value === "string" && TIER_NAME.test(value) && value !== "undecided";
  const tierExpectation = 'a tier name of letters, digits, "_" or "-" starting with a letter, other than "undecided"';

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
    else reject("enabled", "true or false");
  }
  if (raw.planningTier !== undefined) {
    if (tierName(raw.planningTier)) config.planningTier = raw.planningTier;
    else reject("planningTier", tierExpectation);
  }
  if (raw.phaseTiers !== undefined) {
    const tiers = raw.phaseTiers;
    if (Array.isArray(tiers) && tiers.length >= 2 && tiers.every(tierName) && new Set(tiers).size === tiers.length) config.phaseTiers = tiers;
    else reject("phaseTiers", `at least two unique tier names, each ${tierExpectation}`);
  }
  if (raw.systemOneUrl !== undefined) {
    if (isHttpUrl(raw.systemOneUrl)) config.systemOneUrl = raw.systemOneUrl;
    else reject("systemOneUrl", "an http:// or https:// URL");
  }
  if (raw.systemOneModel !== undefined) {
    if (nonEmpty(raw.systemOneModel)) config.systemOneModel = raw.systemOneModel.trim();
    else reject("systemOneModel", "a non-empty string");
  }
  if (raw.minProbability !== undefined) {
    if (typeof raw.minProbability === "number" && raw.minProbability >= 0 && raw.minProbability <= 1) config.minProbability = raw.minProbability;
    else reject("minProbability", "a number from 0 to 1");
  }
  if (raw.timeoutMs !== undefined) {
    if (Number.isInteger(raw.timeoutMs) && (raw.timeoutMs as number) > 0 && (raw.timeoutMs as number) <= MAX_TIMER_MS) config.timeoutMs = raw.timeoutMs as number;
    else reject("timeoutMs", `a whole number of milliseconds from 1 to ${MAX_TIMER_MS}`);
  }
  if (raw.reviewers !== undefined) {
    if (!isRecord(raw.reviewers)) reject("reviewers", "an object with anthropic and openai model keys");
    else {
      const reviewers: ModelRoutingConfig["reviewers"] = {};
      for (const [vendor, model] of Object.entries(raw.reviewers)) {
        if ((vendor === "anthropic" || vendor === "openai") && nonEmpty(model)) reviewers[vendor] = model.trim();
        else reject(`reviewers.${vendor}`, 'a non-empty model key under "anthropic" or "openai"');
      }
      if (Object.keys(reviewers).length > 0) config.reviewers = reviewers;
    }
  }
  if (raw.criteria !== undefined) {
    if (!isRecord(raw.criteria)) reject("criteria", "an object of tier descriptions");
    else {
      const criteria: Record<string, string> = {};
      for (const [tier, description] of Object.entries(raw.criteria)) {
        if (nonEmpty(description)) criteria[tier] = description;
        else reject(`criteria.${tier}`, "a non-empty description");
      }
      if (Object.keys(criteria).length > 0) config.criteria = criteria;
    }
  }
  const known = new Set(["enabled", "planningTier", "phaseTiers", "systemOneUrl", "systemOneModel", "minProbability", "timeoutMs", "reviewers", "criteria"]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) warnings.push(`Ignoring unknown modelRouting keys in ${path}: ${unknown.join(", ")}.`);
  return config;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function loadConfigSource(path: string): { config: PlannotatorConfig; warnings: string[] } {
  const parsed = readJsonFile(path);
  if (parsed.error) {
    return { config: {}, warnings: [parsed.error] };
  }

  const raw = parsed.data;
  if (!isRecord(raw)) return { config: {}, warnings: [] };

  const warnings: string[] = [];
  const config: PlannotatorConfig = {};
  if (raw.executionMode === null || raw.executionMode === "automatic" || raw.executionMode === "external") {
    config.executionMode = raw.executionMode;
  } else if (raw.executionMode !== undefined) {
    // Unrecognized values fall through to the inherited value (ultimately
    // "automatic"), so say so instead of silently ignoring the key.
    warnings.push(
      `Ignoring unknown executionMode ${JSON.stringify(raw.executionMode)} in ${path}: expected "automatic" or "external". Falling back to automatic.`,
    );
  }
  if ("defaults" in raw) config.defaults = normalizeProfile(raw.defaults);
  const modelRouting = normalizeModelRouting(raw.modelRouting, path, warnings);
  if (modelRouting) config.modelRouting = modelRouting;

  if ("phases" in raw && isRecord(raw.phases)) {
    const phases: Partial<Record<PhaseName, PhaseProfile | null>> = {};
    for (const phase of PHASES) {
      const normalized = normalizeProfile(raw.phases[phase]);
      if (normalized !== undefined) phases[phase] = normalized;
    }
    if (Object.keys(phases).length > 0) config.phases = phases;
  }

  // Plannotator no longer modifies Pi's system prompt (#922). The old
  // systemPrompt key is ignored; say so once instead of silently dropping it.
  const obsoleteScopes: string[] = [];
  if (isRecord(raw.defaults) && "systemPrompt" in raw.defaults) obsoleteScopes.push("defaults");
  if (isRecord(raw.phases)) {
    for (const phase of PHASES) {
      const phaseRaw = raw.phases[phase];
      if (isRecord(phaseRaw) && "systemPrompt" in phaseRaw) obsoleteScopes.push(`phases.${phase}`);
    }
  }
  if (obsoleteScopes.length > 0) {
    warnings.push(
      `Ignoring obsolete "systemPrompt" under ${obsoleteScopes.join(", ")} in ${path}: Plannotator no longer modifies the system prompt. Rename the key to "instructions" to deliver the text as a phase-entry message instead.`,
    );
  }

  const runtimeControlScopes: string[] = [];
  const runtimeKeys = ["model", "thinking", "thinkingLevel", "activeTools"];
  const rawDefaults = raw.defaults;
  if (isRecord(rawDefaults) && runtimeKeys.some((key) => key in rawDefaults)) {
    runtimeControlScopes.push("defaults");
  }
  if (isRecord(raw.phases)) {
    for (const phase of PHASES) {
      const phaseRaw = raw.phases[phase];
      if (isRecord(phaseRaw) && runtimeKeys.some((key) => key in phaseRaw)) {
        runtimeControlScopes.push(`phases.${phase}`);
      }
    }
  }
  if (runtimeControlScopes.length > 0) {
    warnings.push(
      `Ignoring model, thinking, and activeTools under ${runtimeControlScopes.join(", ")} in ${path}: the Pi-native fork preserves Pi runtime state.`,
    );
  }

  return { config, warnings };
}

export function loadPlannotatorConfig(
  cwd: string,
  options: LoadPlannotatorConfigOptions,
): LoadedPlannotatorConfig {
  const warnings: string[] = [];

  // The bundled config carries the planning rules and phase instructions. A
  // packaging regression that drops it would otherwise silently produce a
  // rule-less planning phase, so its absence is worth a warning (user global
  // and project configs stay optional and silent).
  if (!existsSync(INTERNAL_CONFIG_PATH)) {
    warnings.push(
      `Built-in config missing at ${INTERNAL_CONFIG_PATH}: phase instructions and planning tools will not apply. Reinstall the extension.`,
    );
  }

  const internal = loadConfigSource(INTERNAL_CONFIG_PATH);
  warnings.push(...internal.warnings);

  const globalPath = join(getAgentConfigDir(), "plannotator.json");
  const globalConfig = loadConfigSource(globalPath);
  warnings.push(...globalConfig.warnings);

  const projectPath = join(cwd, ".pi", "plannotator.json");
  const projectConfig = options.projectTrusted
    ? loadConfigSource(projectPath)
    : { config: {}, warnings: [] };
  warnings.push(...projectConfig.warnings);

  const merged = mergeConfig(mergeConfig(internal.config, globalConfig.config), projectConfig.config);
  const envUrl = process.env.SYSTEM_ONE_BASE_URL;
  if (envUrl !== undefined && !isHttpUrl(envUrl)) {
    warnings.push("Ignoring SYSTEM_ONE_BASE_URL: expected an http:// or https:// URL.");
  }
  const routing = resolveModelRouting(merged);
  if (routing.enabled && !routing.phaseTiers.includes(routing.planningTier)) {
    warnings.push(
      `Disabling modelRouting: planningTier "${routing.planningTier}" is not one of phaseTiers (${routing.phaseTiers.join(", ")}).`,
    );
    merged.modelRouting = { ...merged.modelRouting, enabled: false };
  }
  return { config: merged, warnings };
}

export function resolveExecutionMode(config: PlannotatorConfig): ExecutionMode {
  return config.executionMode ?? "automatic";
}

export function resolveModelRouting(config: PlannotatorConfig): ModelRoutingSettings {
  const raw = config.modelRouting ?? {};
  const defaults = DEFAULT_MODEL_ROUTING;
  return {
    enabled: raw.enabled ?? defaults.enabled,
    planningTier: raw.planningTier ?? defaults.planningTier,
    phaseTiers: raw.phaseTiers ?? defaults.phaseTiers,
    systemOneUrl: raw.systemOneUrl ?? (isHttpUrl(process.env.SYSTEM_ONE_BASE_URL) ? process.env.SYSTEM_ONE_BASE_URL : defaults.systemOneUrl),
    systemOneModel: raw.systemOneModel ?? defaults.systemOneModel,
    minProbability: raw.minProbability ?? defaults.minProbability,
    timeoutMs: raw.timeoutMs ?? defaults.timeoutMs,
    reviewers: {
      anthropic: raw.reviewers?.anthropic ?? defaults.reviewers.anthropic,
      openai: raw.reviewers?.openai ?? defaults.reviewers.openai,
    },
    criteria: { ...defaults.criteria, ...raw.criteria },
  };
}

export function resolvePhaseProfile(config: PlannotatorConfig, phase: PhaseName): ResolvedPhaseProfile {
  const defaults = config.defaults ?? {};
  const phaseConfig = config.phases?.[phase] ?? {};

  return {
    statusLabel: resolveString(defaults.statusLabel, phaseConfig.statusLabel),
    instructions: resolveString(defaults.instructions, phaseConfig.instructions),
  };
}

function resolveString(base: string | null | undefined, override: string | null | undefined): string | undefined {
  if (override !== undefined) {
    if (override === null || override === "") return undefined;
    return override;
  }
  return base ?? undefined;
}

export function buildPromptVariables(options: {
  planFilePath: string;
  phase: RuntimePhase;
  totalCount: number;
  completedCount: number;
  remainingCount?: number;
  todoList?: string;
}): PromptVariables {
  const totalCount = options.totalCount;
  const completedCount = options.completedCount;
  const remainingCount = options.remainingCount ?? Math.max(totalCount - completedCount, 0);

  return {
    planFilePath: options.planFilePath,
    todoList: options.todoList ?? "",
    completedCount,
    totalCount,
    remainingCount,
    phase: options.phase,
  };
}

export function renderTemplate(template: string, vars: PromptVariables): PromptRenderResult {
  const unknownVariables = new Set<string>();
  const text = template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    if (key in vars) {
      const value = vars[key as keyof PromptVariables];
      return value === undefined || value === null ? "" : String(value);
    }
    unknownVariables.add(key);
    return "";
  });

  return { text, unknownVariables: [...unknownVariables] };
}

export function formatTodoList(items: Array<{ step: number; text: string; completed: boolean }>): {
  todoList: string;
  completedCount: number;
  totalCount: number;
  remainingCount: number;
} {
  const totalCount = items.length;
  const completedCount = items.filter((item) => item.completed).length;
  const remainingItems = items.filter((item) => !item.completed);
  const todoList = remainingItems.length
    ? remainingItems.map((item) => `- [ ] ${item.step}. ${item.text}`).join("\n")
    : "";

  return {
    todoList,
    completedCount,
    totalCount,
    remainingCount: remainingItems.length,
  };
}
