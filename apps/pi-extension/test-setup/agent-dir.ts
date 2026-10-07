import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point Pi's global config at an empty directory per test, so the developer's ~/.pi/agent settings never leak in. */
export function isolateAgentDir(): void {
	const original = process.env.PI_CODING_AGENT_DIR;
	let dir: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plannotator-agent-dir-"));
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});
}
