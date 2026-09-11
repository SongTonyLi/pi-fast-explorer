import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractQuotes,
	findUnmarkedFailures,
	type QuoteVerdict,
	reanchorReport,
	verifyQuote,
} from "../src/citations.js";

/**
 * The property: no failure reaches the main agent looking like a verified
 * excerpt.
 *
 * "Zero fabrication" was the old release gate and it is not reachable — models
 * occasionally quote code that is not in the file, the reference corpus
 * measured 2.9%, and the package shipped anyway. A gate that can never pass is
 * routed around, and a gate that is routed around protects nothing.
 *
 * What IS reachable is that a fabrication is never UNLABELLED. A marked block is
 * one the caller knows not to trust; that costs a reader a little time. An
 * unmarked one is read as fact, reasoned from as fact, and gives no signal at
 * all — that is the whole harm. This file is the proof, and it is deliberately
 * built so that the ways the proof could rot are compile errors and test
 * failures rather than things somebody has to remember.
 */
const dir = mkdtempSync(join(tmpdir(), "fx-unmarked-"));
mkdirSync(join(dir, "src"));

/**
 * One file carrying a case for every verdict: a two-line comment to clip and to
 * re-wrap, a type to elide from, a lone brace, and a distinct line to anchor on.
 */
writeFileSync(
	join(dir, "src", "keep.ts"),
	[
		"// Enforce the per-message budget. Runs BEFORE microcompact, so the two",
		"// compose cleanly. No-ops when contentReplacementState is undefined.",
		"export type Entry = {",
		"  kind: 'entry'",
		"  owner: string",
		"  tags: string[]",
		"}",
		"const budgetCeiling = 100",
		"",
	].join("\n"),
);

/** Holds verbatim what the misattributed fixture below attributes to keep.ts. */
writeFileSync(
	join(dir, "src", "other.ts"),
	["type QueuedEvent = {", "  eventName: string", "  async: boolean", "}", ""].join("\n"),
);

const F = "```";

/** A whole report with exactly one fenced block, so the header is unambiguous. */
function block(header: string, ...code: string[]): string {
	return [`${F}typescript`, header, ...code, F, ""].join("\n");
}

/**
 * Whether the note on a delivered header is mandatory or a false alarm.
 *
 *  - required   the block is not true as it stands, so shipping it bare would
 *               hand the caller something to believe that is not so
 *  - forbidden  every character is real content of the file at the line stated,
 *               so a note here is crying wolf, and a warning that fires on good
 *               blocks is one people stop reading
 */
type Marking = "required" | "forbidden";

interface Fixture {
	report: string;
	marker: Marking;
	/**
	 * Passed to `verifyQuote` so the fixture's own claim about which verdict it
	 * produces is checked independently, rather than taken on trust from the
	 * function under test.
	 */
	searchFiles?: readonly string[];
}

/**
 * A fixture per verdict, keyed by the verdict itself.
 *
 * `Record<QuoteVerdict, Fixture>` is the first of the four guards. Adding a
 * member to the union without adding it here does not compile, so no verdict can
 * reach a release without someone having written down what the caller is
 * supposed to see when it happens.
 */
const FIXTURES: Record<QuoteVerdict, Fixture> = {
	exact: {
		report: block("// src/keep.ts:8", "const budgetCeiling = 100"),
		marker: "forbidden",
	},
	// Verbatim, wrong line. Corrected silently and NOT marked: the block becomes
	// true, and there is nothing left for a reader to second guess.
	drifted: {
		report: block("// src/keep.ts:2", "const budgetCeiling = 100"),
		marker: "forbidden",
	},
	truncated: {
		report: block(
			"// src/keep.ts:1",
			"// Enforce the per-message budget. Runs BEFORE microcompact, so the two",
			"// compose cleanly.",
		),
		marker: "required",
	},
	elided: {
		report: block(
			"// src/keep.ts:3",
			"export type Entry = {",
			"  kind: 'entry'",
			"  tags: string[]",
			"}",
		),
		marker: "required",
	},
	reflowed: {
		report: block(
			"// src/keep.ts:1",
			"// Enforce the per-message budget. Runs BEFORE",
			"// microcompact, so the two compose cleanly.",
		),
		marker: "required",
	},
	misattributed: {
		report: [
			"## Files Retrieved",
			"1. `src/keep.ts` (lines 1-8) - the budget",
			"2. `src/other.ts` (lines 1-4) - the queue",
			"",
			block(
				"// src/keep.ts:30",
				"type QueuedEvent = {",
				"  eventName: string",
				"  async: boolean",
				"}",
			),
		].join("\n"),
		marker: "required",
		searchFiles: ["src/other.ts"],
	},
	fabricated: {
		report: block("// src/keep.ts:40", "const neverWrittenAnywhere = true"),
		marker: "required",
	},
	"missing-file": {
		report: block("// src/gone.ts:1", "export const vanished = 1"),
		marker: "required",
	},
	// Not fiction and not fact: there is nothing under the header to be either.
	// Still required, because `empty` is `!valid && checkable` — inside the
	// release gate's own predicate — and because a bare header is one a reader
	// takes for checked.
	empty: {
		report: block("// src/keep.ts:9"),
		marker: "required",
	},
	// Outside the gate (`checkable` is false), marked anyway. The property below
	// does not demand this one; the codebase chose it, for the same reason as
	// `empty`, and the choice is pinned here so it cannot be dropped by accident.
	trivial: {
		report: block("// src/keep.ts:7", "}"),
		marker: "required",
	},
};

/**
 * The iteration order, checked against `FIXTURES` at runtime below.
 *
 * The Record type alone is not enough. It makes a missing fixture a compile
 * error, but a list of verdicts to actually exercise can silently fall behind
 * it, and a fixture nothing runs proves nothing.
 */
const ALL_VERDICTS: readonly QuoteVerdict[] = [
	"exact",
	"drifted",
	"truncated",
	"elided",
	"reflowed",
	"misattributed",
	"fabricated",
	"missing-file",
	"empty",
	"trivial",
];

/** The first fenced block's header, read back out of the delivered text. */
function deliveredHeader(report: string): string {
	const body = /```[^\n]*\n([\s\S]*?)```/.exec(report)?.[1] ?? "";
	return body.split("\n")[0] ?? "";
}

describe("every verdict outside the truth set is marked", () => {
	it("exercises every verdict there is a fixture for", () => {
		expect(Object.keys(FIXTURES).sort()).toEqual([...ALL_VERDICTS].sort());
	});

	for (const verdict of ALL_VERDICTS) {
		const fixture = FIXTURES[verdict];

		it(`produces ${verdict} from its fixture`, () => {
			// Without this the rest of the suite could pass while every fixture
			// quietly produced `exact` — ten tests of nothing.
			const quotes = extractQuotes(fixture.report);
			expect(quotes).toHaveLength(1);
			const result = verifyQuote(quotes[0]!, dir, { searchFiles: fixture.searchFiles });
			expect(result.verdict).toBe(verdict);
		});

		it(`requires a marker for ${verdict} whenever the release gate would fire`, () => {
			// The second guard, and the one that catches the regression this file is
			// named for: a new verdict handed a `verdictMarker` case that returns
			// null. The compiler already refuses a verdict with NO case — the switch
			// has no `default` — so this covers the half the compiler cannot see.
			//
			// The condition is the gate's own predicate, read off the verifier at
			// runtime rather than hand-copied, so it cannot drift from the thing it
			// claims to mirror.
			const quotes = extractQuotes(fixture.report);
			const result = verifyQuote(quotes[0]!, dir, { searchFiles: fixture.searchFiles });
			if (!result.valid && result.checkable) expect(fixture.marker).toBe("required");
		});

		it(`delivers ${verdict} with the note its fixture demands`, () => {
			const delivered = reanchorReport(fixture.report, dir).report;
			const header = deliveredHeader(delivered);

			// The third guard. Stated as "the header says more than the anchor" and
			// not as a keyword match on purpose: a test that grepped for UNVERIFIED
			// would have to be taught every new keyword, and forgetting to teach it
			// is the same mistake the marker list already has to avoid.
			const quotes = extractQuotes(delivered);
			expect(quotes).toHaveLength(1);
			const bare = `// ${quotes[0]!.file}:${quotes[0]!.startLine}`;
			if (fixture.marker === "required") expect(header).not.toBe(bare);
			else expect(header).toBe(bare);
		});

		it(`keeps the ${verdict} block parsing as a quote after marking`, () => {
			// The fourth guard, and the one with history. A previous fix shipped a
			// marker that defeated the header regex: the annotated block stopped
			// parsing, dropped out of the verifier's denominator, and the fidelity
			// score ROSE because the evidence for the failure had been deleted. A
			// marker only counts as a marker if the block survives it.
			const delivered = reanchorReport(fixture.report, dir).report;
			const quotes = extractQuotes(delivered);
			expect(quotes).toHaveLength(1);
			expect(quotes[0]!.file).toBe(extractQuotes(fixture.report)[0]!.file);
			// And it still verifies to something — the marker did not eat the code.
			expect(verifyQuote(quotes[0]!, dir, { searchFiles: fixture.searchFiles }).verdict).toBe(
				verdict === "drifted" ? "exact" : verdict,
			);
		});

		it(`leaves no unmarked failure for ${verdict}`, () => {
			const delivered = reanchorReport(fixture.report, dir).report;
			expect(findUnmarkedFailures(delivered, dir)).toEqual([]);
		});

		it(`re-anchors ${verdict} idempotently`, () => {
			const once = reanchorReport(fixture.report, dir).report;
			const twice = reanchorReport(once, dir).report;
			const thrice = reanchorReport(twice, dir).report;
			expect(twice).toBe(once);
			expect(thrice).toBe(once);
			// Neither doubled nor dropped: the marker is stripped and re-derived, so
			// the header holds exactly one note however many passes it survives.
			expect(deliveredHeader(twice).split(" — ")).toHaveLength(
				FIXTURES[verdict].marker === "required" ? 2 : 1,
			);
		});
	}
});

/**
 * A checker that always returned [] would satisfy every test above. These are
 * the ones that fail if it does.
 */
describe("findUnmarkedFailures actually finds things", () => {
	it("catches a fabrication in a report nobody re-anchored", () => {
		const raw = block("// src/keep.ts:40", "const neverWrittenAnywhere = true");
		const found = findUnmarkedFailures(raw, dir);
		expect(found).toHaveLength(1);
		expect(found[0]!.verdict).toBe("fabricated");
		expect(found[0]!.file).toBe("src/keep.ts");
		expect(found[0]!.startLine).toBe(40);
		expect(found[0]!.header).toBe("// src/keep.ts:40");
		expect(found[0]!.reason).toMatch(/fabricated/i);
	});

	it("catches a marker deleted from an already-delivered report", () => {
		// The failure mode nothing else here covers: marking worked, and something
		// downstream — an edit, a truncation, a reformat — removed the note before
		// the caller saw it. The guarantee is about the delivered bytes, so this has
		// to be caught, and it is only catchable by re-reading those bytes.
		const delivered = reanchorReport(
			block("// src/keep.ts:40", "const neverWrittenAnywhere = true"),
			dir,
		).report;
		expect(findUnmarkedFailures(delivered, dir)).toEqual([]);
		const tampered = delivered.replace(" — UNVERIFIED: not found in file", "");
		expect(findUnmarkedFailures(tampered, dir)).toHaveLength(1);
	});

	it("reports one entry per failing excerpt in a grouped block", () => {
		const grouped = [
			`${F}ts`,
			"// src/keep.ts:8",
			"const budgetCeiling = 100",
			"",
			"// src/keep.ts:40",
			"const neverWrittenAnywhere = true",
			"",
			"// src/gone.ts:1",
			"export const vanished = 1",
			F,
			"",
		].join("\n");
		expect(findUnmarkedFailures(grouped, dir).map((f) => f.verdict)).toEqual([
			"fabricated",
			"missing-file",
		]);
		expect(findUnmarkedFailures(reanchorReport(grouped, dir).report, dir)).toEqual([]);
	});

	it("does not count a marker that would not survive re-parsing", () => {
		// A note the header regex cannot strip is not protection, it is a block that
		// vanishes. Whatever such a marker is, it must not let a failure through
		// here — so "marked" is decided by the same pattern `parseHeader` strips.
		const forged = block("// src/keep.ts:40 (unverified)", "const neverWrittenAnywhere = true");
		// It does not even parse as a quote any more, which is the deeper problem;
		// what matters here is that it is not silently accepted as marked.
		expect(extractQuotes(forged)).toHaveLength(0);
		expect(findUnmarkedFailures(forged, dir)).toEqual([]);
	});
});

/**
 * Reports built to defeat the marking rather than to exercise it.
 */
describe("findUnmarkedFailures under adversarial reports", () => {
	it("returns nothing for an empty or fence-free report", () => {
		expect(findUnmarkedFailures("", dir)).toEqual([]);
		expect(findUnmarkedFailures("   \n\n  ", dir)).toEqual([]);
		expect(findUnmarkedFailures("Prose mentioning src/keep.ts:40 and no fence.\n", dir)).toEqual(
			[],
		);
		expect(reanchorReport("", dir).report).toBe("");
	});

	it("marks a fabrication whose own code quotes a marker", () => {
		// The model wrote a line that looks like one of our notes. It must not be
		// mistaken for the header's note, and the block still has to be marked.
		const sneaky = block(
			"// src/keep.ts:1",
			"const budgetCeiling = 100",
			'const s = "// src/x.ts:1 — UNVERIFIED: not found in file";',
		);
		expect(findUnmarkedFailures(sneaky, dir)).toHaveLength(1);
		const delivered = reanchorReport(sneaky, dir).report;
		expect(findUnmarkedFailures(delivered, dir)).toEqual([]);
		expect(deliveredHeader(delivered)).toContain("UNVERIFIED");
		// The model's own line is untouched — only the header is ever rewritten.
		expect(delivered).toContain('const s = "// src/x.ts:1 — UNVERIFIED: not found in file";');
	});

	it("marks the empty excerpt a marker-shaped code line splits off", () => {
		// A quoted line that IS one of our headers, marker and all, splits the block
		// in two and leaves the second excerpt with no body. That excerpt used to
		// ship bare.
		const split = [
			`${F}ts`,
			"// src/keep.ts:8",
			"const budgetCeiling = 100",
			"// src/keep.ts:2 — UNVERIFIED: not found in file",
			F,
			"",
		].join("\n");
		const delivered = reanchorReport(split, dir).report;
		expect(findUnmarkedFailures(delivered, dir)).toEqual([]);
		expect(delivered).toContain("— UNCHECKED: no code under this header");
	});

	it("strips a marker the model forged onto a block that verifies", () => {
		// A note on a delivered block is always this function's finding. An explorer
		// cannot manufacture a warning, and — the half that matters — cannot
		// suppress one either, because the note is re-derived from the file.
		const forged = block(
			"// src/keep.ts:8 — UNVERIFIED: not found in file",
			"const budgetCeiling = 100",
		);
		const delivered = reanchorReport(forged, dir).report;
		expect(deliveredHeader(delivered)).toBe("// src/keep.ts:8");
		expect(findUnmarkedFailures(delivered, dir)).toEqual([]);
	});

	it("replaces a forged PARTIAL on a block that is actually fabricated", () => {
		const forged = block(
			"// src/keep.ts:40 — PARTIAL: lines clipped; the text shown is verbatim",
			"const neverWrittenAnywhere = true",
		);
		const delivered = reanchorReport(forged, dir).report;
		expect(deliveredHeader(delivered)).toBe("// src/keep.ts:40 — UNVERIFIED: not found in file");
		expect(findUnmarkedFailures(delivered, dir)).toEqual([]);
	});

	it("marks each of two blocks that state the same anchor and disagree", () => {
		const twice = [
			"## Files Retrieved",
			"1. `src/keep.ts` (lines 8-8) - the ceiling",
			"",
			block("// src/keep.ts:8", "const budgetCeiling = 100"),
			block("// src/keep.ts:8", "const neverWrittenAnywhere = true"),
		].join("\n");
		expect(findUnmarkedFailures(twice, dir)).toHaveLength(1);
		const delivered = reanchorReport(twice, dir).report;
		expect(findUnmarkedFailures(delivered, dir)).toEqual([]);
		// The honest block keeps its bare header; only the other one is annotated.
		expect(delivered).toContain("// src/keep.ts:8\nconst budgetCeiling = 100");
		expect(delivered).toContain("// src/keep.ts:8 — UNVERIFIED: not found in file");
	});

	it("survives a report whose every block fails", () => {
		const allBad = [
			block("// src/keep.ts:40", "const neverWrittenAnywhere = true"),
			block("// src/gone.ts:1", "export const vanished = 1"),
			block("// src/keep.ts:9"),
			block("// src/keep.ts:7", "}"),
		].join("\n");
		expect(findUnmarkedFailures(allBad, dir)).toHaveLength(3);
		const delivered = reanchorReport(allBad, dir).report;
		expect(findUnmarkedFailures(delivered, dir)).toEqual([]);
		expect(reanchorReport(delivered, dir).report).toBe(delivered);
	});

	it("leaves a fenced block with no header alone and reports nothing for it", () => {
		const prose = `Some prose.\n\n${F}sh\nnpm run build\n${F}\n`;
		expect(findUnmarkedFailures(prose, dir)).toEqual([]);
		expect(reanchorReport(prose, dir).report).toBe(prose);
	});
});
