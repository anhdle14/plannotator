import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getImprovementHookExpectedPath } from "./improvement-hooks";
import { getHistoryDir, getPlanDir } from "./storage";

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const tempDirs: string[] = [];

function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-data-dir-resolution-"));
  tempDirs.push(dir);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  return dir;
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("data dir resolution after import", () => {
  test("storage follows PLANNOTATOR_DATA_DIR changes made after the module loaded", () => {
    const first = useDataDir();
    expect(getPlanDir()).toBe(join(first, "plans"));
    expect(getHistoryDir("project", "slug")).toBe(join(first, "history", "project", "slug"));

    const second = useDataDir();
    expect(getPlanDir()).toBe(join(second, "plans"));
    expect(getHistoryDir("project", "slug")).toBe(join(second, "history", "project", "slug"));
  });

  test("improvement hooks follow PLANNOTATOR_DATA_DIR changes made after the module loaded", () => {
    const first = useDataDir();
    expect(getImprovementHookExpectedPath("enterplanmode-improve")).toBe(
      join(first, "hooks", "compound", "enterplanmode-improve-hook.txt"),
    );

    const second = useDataDir();
    expect(getImprovementHookExpectedPath("enterplanmode-improve")).toBe(
      join(second, "hooks", "compound", "enterplanmode-improve-hook.txt"),
    );
  });
});
