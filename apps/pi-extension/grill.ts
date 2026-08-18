import { createHash } from "node:crypto";
import type { Phase } from "./tool-scope.ts";

export type GrillCompletionResult =
	| { ok: true; currentHash: string }
	| {
			ok: false;
			reason: "not-grilling" | "not-confirmed" | "missing-approval" | "plan-changed";
			currentHash?: string;
	  };

export function hashPlanContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function validateGrillCompletion(options: {
	phase: Phase;
	confirmed: boolean;
	approvedPlanHash?: string;
	planContent: string;
}): GrillCompletionResult {
	if (options.phase !== "grilling") {
		return { ok: false, reason: "not-grilling" };
	}
	if (!options.confirmed) {
		return { ok: false, reason: "not-confirmed" };
	}
	if (!options.approvedPlanHash) {
		return { ok: false, reason: "missing-approval" };
	}

	const currentHash = hashPlanContent(options.planContent);
	if (currentHash !== options.approvedPlanHash) {
		return { ok: false, reason: "plan-changed", currentHash };
	}
	return { ok: true, currentHash };
}
