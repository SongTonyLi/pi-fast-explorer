import { describe, expect, it } from "vitest";
import { EXPLORE_DESCRIPTION, EXPLORE_PROMPT_GUIDELINES } from "../src/index.js";

/**
 * This text is the only thing standing between a question one explorer answers
 * and four subprocesses answering it four times. Measured against a real
 * repository: four explorers cost 3.6x one ($0.0629 vs $0.0176) for identical
 * recall (1.00 both), with *worse* precision (0.12-0.50 vs 0.25-0.67), because
 * four explorers cite more files and dilute what matters. The guidance used to
 * tell the model to decompose whenever it could, which bought that trade on
 * every call.
 *
 * These tests pin the two properties that make the new wording work, and they
 * pull in opposite directions on purpose:
 *   - it must discourage reflexive fan-out, with a number attached; and
 *   - it must still leave a case the model can recognise as worth fanning out,
 *     or the fan-out path is dead code and the concurrency pool is decoration.
 */
const WHY =
	"the explore guidance is the whole control over fan-out cost. Changing it " +
	"changes what the model spends on every call, so change it against measurement, " +
	"and update this test in the same commit.";

describe("explore tool guidance", () => {
	// pi appends promptGuidelines flat, with no tool-name grouping, so a bullet
	// that does not say "explore" reads as advice about the agent in general.
	it("names explore in every guideline", () => {
		for (const line of EXPLORE_PROMPT_GUIDELINES) {
			expect(line, WHY).toContain("explore");
		}
	});

	it("makes one explorer the default rather than the fallback", () => {
		const guidance = EXPLORE_PROMPT_GUIDELINES.join("\n");
		expect(guidance, WHY).toMatch(/`question` alone by default/);
		expect(EXPLORE_DESCRIPTION, WHY).toMatch(/One explorer is the default/);
	});

	// A model choosing between one subprocess and four needs to know the ratio.
	// "Consider whether decomposition is warranted" is not a decision procedure.
	it("quantifies what fanning out costs", () => {
		expect(EXPLORE_DESCRIPTION, WHY).toContain("3.6x");
		expect(EXPLORE_PROMPT_GUIDELINES.join("\n"), WHY).toContain("3.6x");
	});

	it("conditions decomposition on separable areas, not on phrasing", () => {
		const guidance = EXPLORE_PROMPT_GUIDELINES.join("\n");
		expect(guidance, WHY).toContain("separable areas of the codebase");
		// The old wording. "if you can decompose the task" is satisfied by any
		// question at all, which is why it cost 3.6x on questions that did not
		// need it.
		expect(guidance, WHY).not.toMatch(/if you can decompose/);
	});

	/**
	 * The opposite failure mode, and the more expensive one to diagnose: guidance
	 * so hedged that the model never decomposes, leaving fan-out unreachable and
	 * the measured 3.0-3.3x pool speedup unused. A concrete question that SHOULD
	 * be split has to survive in the text, not just a warning against splitting.
	 */
	it("keeps a worked example of a question that does deserve fan-out", () => {
		const guidance = EXPLORE_PROMPT_GUIDELINES.join("\n");
		expect(guidance, WHY).toMatch(/splits into/);
		expect(guidance, WHY).toMatch(/2-4 `questions`/);
	});
});
