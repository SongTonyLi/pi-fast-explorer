import { describe, expect, it } from "vitest";
import { EXPLORE_DESCRIPTION, EXPLORE_PROMPT_GUIDELINES } from "../src/index.js";

/**
 * This text is the only thing standing between a question one explorer answers
 * and four subprocesses answering it four times. Measured against a real
 * repository: four explorers cost 3.6x one for identical recall (1.00 both),
 * with *worse* precision, because four explorers cite more files and dilute what
 * matters. The guidance used to tell the model to decompose whenever it could,
 * which bought that trade on every call.
 *
 * The second sweep (run `2026-09-11T05-44-05`; artifact not published) added a question
 * whose answer genuinely spans four subsystems — fan-out's best case, and the
 * case the guidance then steered toward. Fan-out lost it too: 2.3x the cost for
 * recall 0.80 against the single explorer's 1.00, missing the same ground-truth
 * file in 4 of 5 runs though a sub-question pointed straight at it.
 *
 * So these tests pin a different pair of properties than they used to, still
 * pulling in opposite directions:
 *   - the guidance must discourage fan-out, with the numbers attached; and
 *   - it must still NAME `questions`, because the schema advertises the
 *     parameter. Guidance that never mentions a parameter the model can see is
 *     worse than guidance that argues against it.
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

	it("reports the separable case as measured and lost, not as the trigger", () => {
		const guidance = EXPLORE_PROMPT_GUIDELINES.join("\n");
		// The phrase survives, but it now labels the case fan-out was tested on
		// and lost — it is no longer the condition under which to fan out.
		expect(guidance, WHY).toContain("separable areas of the codebase");
		expect(guidance, WHY).toMatch(/2\.3x/);
		expect(guidance, WHY).toMatch(/4 of 5 runs/);
		// The old wording. "if you can decompose the task" is satisfied by any
		// question at all, which is why it cost 3.6x on questions that did not
		// need it.
		expect(guidance, WHY).not.toMatch(/if you can decompose/);
	});

	/**
	 * The failure mode this replaced: guidance carrying a worked example of a
	 * question that "deserves" fan-out, kept so the path would not be dead text.
	 * That example is gone because measurement took its side of the argument away
	 * — the one genuinely separable question tested is where fan-out lost worst.
	 *
	 * What remains worth pinning is that `questions` is still named. The
	 * parameter is in the tool schema whether or not the guidance mentions it, so
	 * silence would leave the model to reach for it with nothing to weigh.
	 */
	it("names `questions` rather than pretending the parameter is absent", () => {
		const guidance = EXPLORE_PROMPT_GUIDELINES.join("\n");
		expect(guidance, WHY).toContain("`questions`");
		expect(EXPLORE_DESCRIPTION, WHY).toContain("`questions`");
		expect(EXPLORE_DESCRIPTION, WHY).toMatch(/no measured benefit/);
	});
});

describe("checklist guidance", () => {
	// The checklist is the path with the coverage signal behind it: the extension
	// can say which items were resolved. It has to be named where the model
	// decides how to call the tool.
	it("names `checklist` in the description and the guidelines", () => {
		expect(EXPLORE_DESCRIPTION).toContain("`checklist`");
		expect(EXPLORE_PROMPT_GUIDELINES.join("\n")).toContain("`checklist`");
	});
});
