import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptVariables, loadPlannotatorConfig, formatTodoList, renderTemplate, resolveExecutionMode, resolveModelRouting, resolvePhaseProfile } from "./config.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plannotator config", () => {
  test("loads the shipped internal base config", () => {
    const cwdDir = makeTempDir("plannotator-config-base-");
    process.env.HOME = makeTempDir("plannotator-config-home-base-");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    const planning = resolvePhaseProfile(loaded.config, "planning");
    const grilling = resolvePhaseProfile(loaded.config, "grilling");

    expect(loaded.warnings).toEqual([]);
    expect(resolveExecutionMode(loaded.config)).toBe("automatic");
    expect(planning.statusLabel).toBe("⏸ plan");
    expect(planning.instructions).not.toContain("Available tools:");
    expect(grilling.statusLabel).toBe("🔥 grill");
  });

  test("defaults to automatic execution", () => {
    expect(resolveExecutionMode({})).toBe("automatic");
  });

  test("model routing is off by default and merges global and project fields", () => {
    expect(resolveModelRouting({}).enabled).toBe(false);

    const homeDir = makeTempDir("plannotator-config-home-routing-");
    const cwdDir = makeTempDir("plannotator-config-cwd-routing-");
    process.env.HOME = homeDir;
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    mkdirSync(join(cwdDir, ".pi"), { recursive: true });
    writeFileSync(join(homeDir, ".pi", "agent", "plannotator.json"), JSON.stringify({
      modelRouting: { enabled: true, minProbability: 0.7, reviewers: { openai: "x/opus" }, criteria: { quick: "tiny" }, bogus: 1 },
    }), "utf-8");
    writeFileSync(join(cwdDir, ".pi", "plannotator.json"), JSON.stringify({
      modelRouting: { planningTier: "general", reviewers: { anthropic: "x/sol" } },
    }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    const routing = resolveModelRouting(loaded.config);

    expect(loaded.warnings.some((warning) => warning.includes("bogus"))).toBe(true);
    expect(routing.enabled).toBe(true);
    expect(routing.minProbability).toBe(0.7);
    expect(routing.planningTier).toBe("general");
    expect(routing.reviewers).toEqual({ anthropic: "x/sol", openai: "x/opus" });
    expect(routing.criteria.quick).toBe("tiny");
    expect(routing.criteria.frontier).toContain("architecture");
  });

  test("model routing rejects invalid known fields with field-specific warnings", () => {
    const cwdDir = makeTempDir("plannotator-config-cwd-routing-invalid-");
    process.env.HOME = makeTempDir("plannotator-config-home-routing-invalid-");
    mkdirSync(join(cwdDir, ".pi"), { recursive: true });
    writeFileSync(join(cwdDir, ".pi", "plannotator.json"), JSON.stringify({
      modelRouting: {
        enabled: "yes",
        planningTier: "undecided",
        phaseTiers: ["quick", "quick", "two words"],
        systemOneUrl: "ftp://judge",
        minProbability: "0.7",
        timeoutMs: 2_147_483_648,
        reviewers: { google: "x/gemini" },
        criteria: { quick: "" },
      },
    }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    for (const key of ["enabled", "planningTier", "phaseTiers", "systemOneUrl", "minProbability", "timeoutMs", "reviewers.google", "criteria.quick"]) {
      expect(loaded.warnings.some((warning) => warning.startsWith(`Ignoring modelRouting.${key} in `))).toBe(true);
    }
    expect(loaded.config.modelRouting).toEqual({});
    expect(resolveModelRouting(loaded.config)).toMatchObject({ enabled: false, planningTier: "frontier", minProbability: 0.6, timeoutMs: 30_000 });

    writeFileSync(join(cwdDir, ".pi", "plannotator.json"), JSON.stringify({ modelRouting: { timeoutMs: 1.5 } }), "utf-8");
    expect(loadPlannotatorConfig(cwdDir, { projectTrusted: true }).warnings).toEqual([
      expect.stringContaining("modelRouting.timeoutMs"),
    ]);
  });

  test("model routing is disabled when planningTier is not one of phaseTiers", () => {
    const cwdDir = makeTempDir("plannotator-config-cwd-routing-tiers-");
    process.env.HOME = makeTempDir("plannotator-config-home-routing-tiers-");
    mkdirSync(join(cwdDir, ".pi"), { recursive: true });
    writeFileSync(join(cwdDir, ".pi", "plannotator.json"), JSON.stringify({ modelRouting: { enabled: true, phaseTiers: ["small", "large"] } }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    expect(loaded.warnings).toEqual([expect.stringContaining('planningTier "frontier" is not one of phaseTiers (small, large)')]);
    expect(resolveModelRouting(loaded.config).enabled).toBe(false);
  });

  test("plan store is off by default and merges global and project roots", () => {
    const homeDir = makeTempDir("plannotator-config-home-store-");
    const cwdDir = makeTempDir("plannotator-config-cwd-store-");
    process.env.HOME = homeDir;
    expect(loadPlannotatorConfig(cwdDir, { projectTrusted: true }).config.planStore).toBeUndefined();

    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    mkdirSync(join(cwdDir, ".pi"), { recursive: true });
    writeFileSync(join(homeDir, ".pi", "agent", "plannotator.json"), JSON.stringify({ planStore: { root: "~/.local/xpi" } }), "utf-8");
    let loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.planStore).toEqual({ root: "~/.local/xpi" });

    writeFileSync(join(cwdDir, ".pi", "plannotator.json"), JSON.stringify({ planStore: { root: "/srv/plans" } }), "utf-8");
    expect(loadPlannotatorConfig(cwdDir, { projectTrusted: true }).config.planStore).toEqual({ root: "/srv/plans" });
    expect(loadPlannotatorConfig(cwdDir, { projectTrusted: false }).config.planStore).toEqual({ root: "~/.local/xpi" });

    writeFileSync(join(cwdDir, ".pi", "plannotator.json"), JSON.stringify({ planStore: null }), "utf-8");
    loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.planStore).toBeNull();
  });

  test("plan store rejects invalid shapes with field-specific warnings", () => {
    const cwdDir = makeTempDir("plannotator-config-cwd-store-invalid-");
    process.env.HOME = makeTempDir("plannotator-config-home-store-invalid-");
    mkdirSync(join(cwdDir, ".pi"), { recursive: true });
    const load = (planStore: unknown) => {
      writeFileSync(join(cwdDir, ".pi", "plannotator.json"), JSON.stringify({ planStore }), "utf-8");
      return loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    };

    for (const value of ["~/.local/xpi", 3, ["/srv"]]) {
      const loaded = load(value);
      expect(loaded.warnings).toEqual([expect.stringMatching(/^Ignoring planStore in .*: expected an object\.$/)]);
      expect(loaded.config.planStore).toBeUndefined();
    }
    for (const root of ["", "   ", 7, "relative/plans"]) {
      const loaded = load({ root });
      expect(loaded.warnings).toEqual([expect.stringMatching(/^Ignoring planStore\.root in .*: expected a non-empty absolute or ~\/ path\.$/)]);
      expect(loaded.config.planStore).toEqual({});
    }
    const unknown = load({ root: "/srv/plans", dir: "x", mode: 1 });
    expect(unknown.warnings).toEqual([expect.stringMatching(/^Ignoring unknown planStore keys in .*: dir, mode\.$/)]);
    expect(unknown.config.planStore).toEqual({ root: "/srv/plans" });
  });

  test("ignores an invalid SYSTEM_ONE_BASE_URL with a warning", () => {
    const cwdDir = makeTempDir("plannotator-config-cwd-routing-env-");
    process.env.HOME = makeTempDir("plannotator-config-home-routing-env-");
    const previous = process.env.SYSTEM_ONE_BASE_URL;
    process.env.SYSTEM_ONE_BASE_URL = "localhost:8008";
    try {
      const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
      expect(loaded.warnings).toEqual([expect.stringContaining("Ignoring SYSTEM_ONE_BASE_URL")]);
      expect(resolveModelRouting(loaded.config).systemOneUrl).toBe("http://127.0.0.1:8008");
      process.env.SYSTEM_ONE_BASE_URL = "http://judge.local:9000";
      expect(resolveModelRouting(loaded.config).systemOneUrl).toBe("http://judge.local:9000");
    } finally {
      if (previous === undefined) delete process.env.SYSTEM_ONE_BASE_URL;
      else process.env.SYSTEM_ONE_BASE_URL = previous;
    }
  });

  test("loads external execution mode with project precedence", () => {
    const homeDir = makeTempDir("plannotator-config-home-execution-");
    const cwdDir = makeTempDir("plannotator-config-cwd-execution-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "external" }), "utf-8");
    writeFileSync(join(projectConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "automatic" }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });

    expect(loaded.warnings).toEqual([]);
    expect(resolveExecutionMode(loaded.config)).toBe("automatic");
  });

  test("ignores project config when Pi denies project trust", () => {
    const homeDir = makeTempDir("plannotator-config-home-untrusted-");
    const cwdDir = makeTempDir("plannotator-config-cwd-untrusted-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "external" }), "utf-8");
    writeFileSync(join(projectConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "automatic" }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: false });

    expect(loaded.warnings).toEqual([]);
    expect(resolveExecutionMode(loaded.config)).toBe("external");
  });

  test("allows a project config to clear inherited external execution with null", () => {
    const homeDir = makeTempDir("plannotator-config-home-execution-null-");
    const cwdDir = makeTempDir("plannotator-config-cwd-execution-null-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "external" }), "utf-8");
    writeFileSync(join(projectConfigDir, "plannotator.json"), JSON.stringify({ executionMode: null }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });

    expect(loaded.warnings).toEqual([]);
    expect(resolveExecutionMode(loaded.config)).toBe("automatic");
  });

  test("warns and falls back to automatic for an unrecognized executionMode", () => {
    const homeDir = makeTempDir("plannotator-config-home-execution-bad-");
    const cwdDir = makeTempDir("plannotator-config-cwd-execution-bad-");
    process.env.HOME = homeDir;

    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, "plannotator.json"), JSON.stringify({ executionMode: "handoff" }), "utf-8");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });

    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain('Ignoring unknown executionMode "handoff"');
    expect(loaded.warnings[0]).toContain("Falling back to automatic");
    expect(resolveExecutionMode(loaded.config)).toBe("automatic");
  });

  test("allows a project config to clear an inherited phase with null", () => {
    const homeDir = makeTempDir("plannotator-config-home-null-");
    const cwdDir = makeTempDir("plannotator-config-cwd-null-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(globalConfigDir, "plannotator.json"),
      JSON.stringify({
        phases: { planning: { statusLabel: "global" } },
      }),
      "utf-8",
    );
    writeFileSync(
      join(projectConfigDir, "plannotator.json"),
      JSON.stringify({
        phases: { planning: null },
      }),
      "utf-8",
    );

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    const planning = resolvePhaseProfile(loaded.config, "planning");

    expect(loaded.warnings).toEqual([]);
    expect(planning.statusLabel).toBeUndefined();
  });

  test("loads global and project configs with project precedence", () => {
    const homeDir = makeTempDir("plannotator-config-home-");
    const cwdDir = makeTempDir("plannotator-config-cwd-");
    process.env.HOME = homeDir;

    const globalConfigDir = join(homeDir, ".pi", "agent");
    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(globalConfigDir, "plannotator.json"),
      JSON.stringify({
        phases: { planning: { statusLabel: "global", instructions: "global instructions" } },
      }),
      "utf-8",
    );
    writeFileSync(
      join(projectConfigDir, "plannotator.json"),
      JSON.stringify({
        phases: { planning: { statusLabel: "project" } },
      }),
      "utf-8",
    );

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    const planning = resolvePhaseProfile(loaded.config, "planning");

    expect(loaded.warnings).toEqual([]);
    expect(planning.statusLabel).toBe("project");
    expect(planning.instructions).toBe("global instructions");
  });

  test("treats empty strings as clearing values", () => {
    const profile = resolvePhaseProfile(
      {
        defaults: { statusLabel: "base", instructions: "base instructions" },
        phases: { planning: { statusLabel: "", instructions: "" } },
      },
      "planning",
    );

    expect(profile.statusLabel).toBeUndefined();
    expect(profile.instructions).toBeUndefined();
  });

  test("allows clearing an entire phase with null", () => {
    const profile = resolvePhaseProfile(
      {
        defaults: { statusLabel: "base", instructions: "base instructions" },
        phases: { planning: null },
      },
      "planning",
    );

    expect(profile.statusLabel).toBe("base");
    expect(profile.instructions).toBe("base instructions");
  });

  test("renders prompt templates and reports unknown variables", () => {
    const rendered = renderTemplate("Hello ${name} ${missing}", {
      planFilePath: "PLAN.md",
      todoList: "- [ ] A",
      completedCount: 1,
      totalCount: 2,
      remainingCount: 1,
      phase: "planning",
    });

    expect(rendered.text).toBe("Hello  ");
    expect(rendered.unknownVariables).toEqual(["name", "missing"]);
  });

  test("renders buildPromptVariables output into instruction templates", () => {
    const vars = buildPromptVariables({
      planFilePath: "PLAN.md",
      phase: "executing",
      totalCount: 2,
      completedCount: 1,
      todoList: "- [ ] 2. Second",
    });

    const rendered = renderTemplate("Plan ${planFilePath}: ${completedCount}/${totalCount}\n${todoList}", vars);

    expect(rendered.text).toBe("Plan PLAN.md: 1/2\n- [ ] 2. Second");
    expect(rendered.unknownVariables).toEqual([]);
  });

  test("shipped phase instructions carry the framing contract", () => {
    const cwdDir = makeTempDir("plannotator-config-shipped-instructions-");
    process.env.HOME = makeTempDir("plannotator-config-home-shipped-instructions-");

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    const planning = resolvePhaseProfile(loaded.config, "planning");
    const grilling = resolvePhaseProfile(loaded.config, "grilling");
    const executing = resolvePhaseProfile(loaded.config, "executing");

    expect(loaded.warnings).toEqual([]);
    expect(planning.instructions).toContain("[PLANNOTATOR - PLANNING PHASE]");
    // The framing is a conversation message, never a system prompt, so the
    // retired composition variable must not appear anywhere.
    expect(planning.instructions).not.toContain("${baseSystemPrompt}");
    expect(grilling.instructions).toContain("[PLANNOTATOR - GRILLING PHASE]");
    expect(grilling.instructions).toContain("ask_user_question");
    expect(executing.instructions).not.toContain("${baseSystemPrompt}");
    // Executing framing supersedes the stale planning rules in history and
    // carries an entry-time todo snapshot.
    expect(executing.instructions).toContain("mandatory grill are complete");
    expect(executing.instructions).toContain("${planFilePath}");
    expect(executing.instructions).toContain("${todoList}");
  });

  test("warns about and ignores the obsolete systemPrompt config key", () => {
    const homeDir = makeTempDir("plannotator-config-home-obsolete-");
    const cwdDir = makeTempDir("plannotator-config-cwd-obsolete-");
    process.env.HOME = homeDir;

    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "plannotator.json"),
      JSON.stringify({
        defaults: { systemPrompt: "OLD DEFAULT" },
        phases: { executing: { systemPrompt: "OLD EXECUTING" } },
      }),
      "utf-8",
    );

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    const executing = resolvePhaseProfile(loaded.config, "executing");

    // The obsolete key is ignored: the shipped instructions still apply.
    expect(executing.instructions).toContain("[PLANNOTATOR - EXECUTING PLAN]");
    expect(executing.instructions).not.toContain("OLD EXECUTING");
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain('obsolete "systemPrompt"');
    expect(loaded.warnings[0]).toContain("defaults, phases.executing");
    expect(loaded.warnings[0]).toContain("instructions");
  });

  test("warns about and ignores obsolete Pi runtime controls", () => {
    const homeDir = makeTempDir("plannotator-config-home-runtime-controls-");
    const cwdDir = makeTempDir("plannotator-config-cwd-runtime-controls-");
    process.env.HOME = homeDir;

    const projectConfigDir = join(cwdDir, ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "plannotator.json"),
      JSON.stringify({
        defaults: { model: { provider: "anthropic", id: "opus" }, thinking: "high" },
        phases: { planning: { activeTools: ["read"] } },
      }),
      "utf-8",
    );

    const loaded = loadPlannotatorConfig(cwdDir, { projectTrusted: true });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("Pi-native fork preserves Pi runtime state");
    expect(resolvePhaseProfile(loaded.config, "planning")).toEqual({
      statusLabel: "⏸ plan",
      instructions: expect.any(String),
    });
  });

  test("formats todo lists from checklist items", () => {
    const stats = formatTodoList([
      { step: 1, text: "First", completed: true },
      { step: 2, text: "Second", completed: false },
      { step: 3, text: "Third", completed: false },
    ]);

    expect(stats.completedCount).toBe(1);
    expect(stats.totalCount).toBe(3);
    expect(stats.remainingCount).toBe(2);
    expect(stats.todoList).toBe("- [ ] 2. Second\n- [ ] 3. Third");
  });
});
