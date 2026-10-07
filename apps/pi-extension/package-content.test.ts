import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const home = process.env.HOME ?? tmpdir();

test("the npm package includes the plan store module", () => {
	const cache = mkdtempSync(join(tmpdir(), "plannotator-package-cache-"));
	try {
		const output = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
			cwd: fileURLToPath(new URL(".", import.meta.url)),
			encoding: "utf8",
			env: { ...process.env, HOME: home, npm_config_cache: cache, npm_config_update_notifier: "false" },
			timeout: 20_000,
		});
		const [packageInfo] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;

		expect(packageInfo?.files.map((file) => file.path)).toContain("plan-store.ts");
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
}, 30_000);
