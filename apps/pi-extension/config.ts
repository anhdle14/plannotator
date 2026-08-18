import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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

export interface PlannotatorConfig {
  executionMode?: ExecutionMode | null;
  defaults?: PhaseProfile | null;
  phases?: Partial<Record<PhaseName, PhaseProfile | null>>;
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
  };
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
  return { config: merged, warnings };
}

export function resolveExecutionMode(config: PlannotatorConfig): ExecutionMode {
  return config.executionMode ?? "automatic";
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
