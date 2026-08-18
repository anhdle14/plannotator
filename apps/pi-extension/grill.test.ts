import { describe, expect, test } from "bun:test";
import { hashPlanContent, validateGrillCompletion } from "./grill.ts";

describe("grill completion", () => {
	const content = "# Plan\n\n- [ ] Implement";
	const approvedPlanHash = hashPlanContent(content);

	test("accepts an unchanged approved plan after explicit confirmation", () => {
		expect(
			validateGrillCompletion({
				phase: "grilling",
				confirmed: true,
				approvedPlanHash,
				planContent: content,
			}),
		).toEqual({ ok: true, currentHash: approvedPlanHash });
	});

	test("rejects completion outside grilling", () => {
		expect(
			validateGrillCompletion({
				phase: "planning",
				confirmed: true,
				approvedPlanHash,
				planContent: content,
			}),
		).toEqual({ ok: false, reason: "not-grilling" });
	});

	test("requires explicit confirmation", () => {
		expect(
			validateGrillCompletion({
				phase: "grilling",
				confirmed: false,
				approvedPlanHash,
				planContent: content,
			}),
		).toEqual({ ok: false, reason: "not-confirmed" });
	});

	test("requires a recorded browser approval", () => {
		expect(
			validateGrillCompletion({
				phase: "grilling",
				confirmed: true,
				planContent: content,
			}),
		).toEqual({ ok: false, reason: "missing-approval" });
	});

	test("requires re-review when the plan changes", () => {
		const changedContent = `${content}\n- [ ] Test`;
		expect(
			validateGrillCompletion({
				phase: "grilling",
				confirmed: true,
				approvedPlanHash,
				planContent: changedContent,
			}),
		).toEqual({
			ok: false,
			reason: "plan-changed",
			currentHash: hashPlanContent(changedContent),
		});
	});
});
