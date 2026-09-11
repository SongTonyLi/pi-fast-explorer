import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type QuoteVerdict, verifyQuote } from "../src/citations.js";

/**
 * Every verdict weaker than `drifted` is a licence to call something real that
 * did not match. The tests here are therefore written in pairs: each rule gets
 * a case it must accept, drawn from what the reference corpus actually
 * contained, and the neighbouring case it must still refuse. The refusals are
 * the load-bearing half. A prefix rule with no floor under it would accept `//`
 * as a quote of every comment in the file, and the detector would report a
 * clean run on a report made entirely of punctuation.
 */
const dir = mkdtempSync(join(tmpdir(), "fx-verdict-"));

/**
 * A clipped comment. The last line of the quote below stops at `// cleanly.`,
 * 11 characters — the shortest real truncation on the reference corpus, and the
 * case the prefix floor of 8 is set to clear.
 */
writeFileSync(
	join(dir, "clip.ts"),
	[
		"// Enforce the per-message budget. Runs BEFORE",
		"// microcompact, so content replacement is invisible to it and",
		"// cleanly. No-ops when contentReplacementState is undefined.",
		"const budget = 100",
		"",
	].join("\n"),
);

writeFileSync(
	join(dir, "elide.ts"),
	[
		"export type Entry = {",
		"  kind: 'entry'",
		"  id: string",
		"  owner: string",
		"  tags: string[]",
		"}",
		"",
	].join("\n"),
);

/** Twelve distinct lines, for quoting three of them from opposite ends. */
writeFileSync(
	join(dir, "long.ts"),
	Array.from({ length: 12 }, (_, i) => `const distinctLine${i + 1} = ${i + 1}`).join("\n"),
);

writeFileSync(
	join(dir, "doc.ts"),
	[
		"const before = 1",
		"",
		"/**",
		" * Merges consecutive user messages into one before the request goes",
		" * out, so parallel tool results that arrived separately become ONE",
		" * message on the wire. The budget must group the same way or it would",
		" * see N under-budget messages instead of one over-budget message.",
		" */",
		"export const merge = true",
		"",
		"// alpha beta",
		"// gamma delta",
		"",
	].join("\n"),
);

/** The file the model meant. */
writeFileSync(
	join(dir, "right.ts"),
	["type QueuedEvent = {", "  eventName: string", "  async: boolean", "}", ""].join("\n"),
);

/**
 * The file the model named. It holds the same declaration with one line
 * carrying a trailing comment, so a quote of the clean version is a truncated
 * match HERE and a verbatim match in `right.ts` — which is exactly the
 * collision the search order has to resolve in favour of the cited file.
 */
writeFileSync(
	join(dir, "named.ts"),
	[
		"const unrelated = 1",
		"type QueuedEvent = {",
		"  eventName: string",
		"  async: boolean // plus a trailing note the quote dropped",
		"}",
		"",
	].join("\n"),
);

/** A file that shares nothing with `right.ts`. */
writeFileSync(join(dir, "elsewhere.ts"), ["export const nothingAlike = true", ""].join("\n"));

function verdictOf(file: string, startLine: number, code: string, searchFiles?: string[]): QuoteVerdict {
	return verifyQuote({ file, startLine, code }, dir, { searchFiles }).verdict;
}

const CLIPPED_HEAD = ["// Enforce the per-message budget. Runs BEFORE", "// microcompact, so content replacement is invisible to it and"];

describe("verdict: exact and drifted", () => {
	it("calls a quote at its stated line exact", () => {
		const r = verifyQuote({ file: "elide.ts", startLine: 1, code: "export type Entry = {" }, dir);
		expect(r.verdict).toBe("exact");
		expect(r.valid).toBe(true);
		expect(r.drift).toBe(0);
	});

	it("calls verbatim code at the wrong line drifted", () => {
		const r = verifyQuote({ file: "elide.ts", startLine: 1, code: "  id: string\n  owner: string" }, dir);
		expect(r.verdict).toBe("drifted");
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(3);
		expect(r.drift).toBe(2);
	});
});

describe("verdict: truncated", () => {
	it("accepts an 11-character tail under lines that matched in full", () => {
		const r = verifyQuote(
			{ file: "clip.ts", startLine: 1, code: [...CLIPPED_HEAD, "// cleanly."].join("\n") },
			dir,
		);
		expect(r.verdict).toBe("truncated");
		// The substance is the file's, so the caller may reason from it.
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(1);
		expect(r.drift).toBe(0);
	});

	it("accepts a single long line cut short", () => {
		const r = verifyQuote(
			{ file: "clip.ts", startLine: 3, code: "// cleanly. No-ops when contentReplacement" },
			dir,
		);
		expect(r.verdict).toBe("truncated");
		expect(r.actualLine).toBe(3);
	});

	it("re-anchors a truncated quote whose line number is also wrong", () => {
		const r = verifyQuote(
			{ file: "clip.ts", startLine: 9, code: [...CLIPPED_HEAD, "// cleanly."].join("\n") },
			dir,
		);
		expect(r.verdict).toBe("truncated");
		expect(r.actualLine).toBe(1);
		expect(r.drift).toBe(-8);
	});

	it("REFUSES a prefix shorter than the floor, even under lines that matched in full", () => {
		// `id` is 2 characters. Everything above it matched exactly and the quote
		// carries 37 characters in total, and it still is not enough: a two-
		// character prefix is a claim about nothing, and admitting it would let
		// `}` or `*` stand in for any line of the file.
		const code = ["export type Entry = {", "  kind: 'entry'", "  id"].join("\n");
		expect(verdictOf("elide.ts", 1, code)).toBe("fabricated");
	});

	it("accepts the same quote once the last line reaches the floor", () => {
		// Identical but for six more characters on the last line, which is the
		// only thing separating the two results. Pinning the pair keeps the floor
		// from being quietly moved.
		const code = ["export type Entry = {", "  kind: 'entry'", "  id: stri"].join("\n");
		expect(verdictOf("elide.ts", 1, code)).toBe("truncated");
	});

	it("lets a clipped all-comment quote through as reflowed, not truncated", () => {
		// The last line is `// cle`, under the per-line floor, so the truncation
		// rule refuses it — and the reflow rule below then accepts the quote on
		// its own terms, because 100 characters of the comment's wording matched
		// verbatim first. That is the right answer and worth pinning: the floors
		// exist to stop quotes made OF punctuation, not to reject a quote that
		// has already proved itself and then stopped mid-word.
		expect(verdictOf("clip.ts", 1, [...CLIPPED_HEAD, "// cle"].join("\n"))).toBe("reflowed");
	});

	it("REFUSES a lone prefix that clears the per-line floor but not the total", () => {
		// 10 characters — over the per-line floor of 8, under the 24 the whole
		// quote must carry. Otherwise `// Enforce` alone would "verify".
		expect(verdictOf("clip.ts", 1, "// Enforce")).toBe("fabricated");
	});

	it("REFUSES a lone `//`, which is a prefix of every comment in the file", () => {
		expect(verdictOf("clip.ts", 1, "//\n//\n//")).toBe("fabricated");
	});

	it("REFUSES a quote that is LONGER than the file line it starts", () => {
		// Truncation only ever drops characters. Added text is invention, and the
		// prefix runs the other way, so it cannot be mistaken for clipping.
		expect(verdictOf("clip.ts", 4, "const budget = 100 + inventedExtra")).toBe("fabricated");
	});

	it("REFUSES a renamed identifier in an otherwise prefix-clean quote", () => {
		expect(verdictOf("clip.ts", 4, "const renamedThing = 100")).toBe("fabricated");
	});
});

describe("verdict: elided", () => {
	it("accepts a quote that dropped one line from the middle", () => {
		const r = verifyQuote(
			{
				file: "elide.ts",
				startLine: 1,
				code: ["export type Entry = {", "  kind: 'entry'", "  id: string", "  tags: string[]", "}"].join("\n"),
			},
			dir,
		);
		expect(r.verdict).toBe("elided");
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(1);
	});

	it("REFUSES a two-line quote, which cannot have a middle to drop", () => {
		expect(verdictOf("elide.ts", 1, "export type Entry = {\n  id: string")).toBe("fabricated");
	});

	it("REFUSES lines cherry-picked from opposite ends of the file", () => {
		// Three lines quoted, so the search window is six. Line 12 is outside it:
		// a quote that skipped more than it kept is an assembled excerpt, not an
		// omission, and it misleads a reader more than it informs one.
		const code = ["const distinctLine1 = 1", "const distinctLine6 = 6", "const distinctLine12 = 12"].join("\n");
		expect(verdictOf("long.ts", 1, code)).toBe("fabricated");
	});

	it("REFUSES a quote with an invented line spliced into real ones", () => {
		const code = ["export type Entry = {", "  kind: 'entry'", "  invented: never", "  tags: string[]", "}"].join("\n");
		expect(verdictOf("elide.ts", 1, code)).toBe("fabricated");
	});

	it("REFUSES real lines put back in the wrong order", () => {
		const code = ["export type Entry = {", "  owner: string", "  id: string", "  tags: string[]"].join("\n");
		expect(verdictOf("elide.ts", 1, code)).toBe("fabricated");
	});
});

describe("verdict: reflowed", () => {
	it("accepts a comment re-wrapped across different line breaks", () => {
		const r = verifyQuote(
			{
				file: "doc.ts",
				startLine: 3,
				code: [
					"/**",
					" * Merges consecutive user messages into one",
					" * before the request goes out, so parallel tool results that",
					" * arrived separately become ONE message on the wire.",
					" */",
				].join("\n"),
			},
			dir,
		);
		expect(r.verdict).toBe("reflowed");
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(4);
	});

	it("accepts a fragment re-capitalised into a sentence when clipped", () => {
		// The file reads `The budget must group`; the model kept the fragment and
		// lower-cased it. Prose that differs from the file only in a capital is
		// not something a caller can be misled by.
		const r = verifyQuote(
			{
				file: "doc.ts",
				startLine: 6,
				code: [
					" * the budget must group the same way or it would see N",
					" * under-budget messages instead of one over-budget message.",
				].join("\n"),
			},
			dir,
		);
		expect(r.verdict).toBe("reflowed");
		expect(r.actualLine).toBe(6);
	});

	it("REFUSES the same wording once a line of code is mixed in", () => {
		// The rule compares prose. One non-comment line and it has no business
		// running at all, or it would be comparing code as though it were prose.
		const code = [
			" * Merges consecutive user messages into one",
			"export const merge = true",
			" * before the request goes out, so parallel tool results that",
		].join("\n");
		expect(verdictOf("doc.ts", 3, code)).toBe("fabricated");
	});

	it("REFUSES prose too short to identify one comment block", () => {
		// "alpha beta gamma" spans two real comment lines but is 16 characters —
		// under the 40 that makes a phrase specific to the block it came from.
		expect(verdictOf("doc.ts", 11, "// alpha beta gamma")).toBe("fabricated");
	});

	it("REFUSES the file's own words put back in a different order", () => {
		const code = [
			" * see N under-budget messages instead of one over-budget message.",
			" * message on the wire. The budget must group the same way or it would",
		].join("\n");
		expect(verdictOf("doc.ts", 6, code)).toBe("fabricated");
	});

	it("REFUSES a comment that starts real and then invents", () => {
		const code = " * Merges consecutive user messages into one before the request was never written";
		expect(verdictOf("doc.ts", 4, code)).toBe("fabricated");
	});
});

const QUEUED_EVENT = ["type QueuedEvent = {", "  eventName: string", "  async: boolean", "}"].join("\n");

describe("verdict: misattributed", () => {
	it("names the file the code is really in", () => {
		const r = verifyQuote({ file: "elsewhere.ts", startLine: 1, code: QUEUED_EVENT }, dir, {
			searchFiles: ["elsewhere.ts", "right.ts"],
		});
		expect(r.verdict).toBe("misattributed");
		expect(r.actualFile).toBe("right.ts");
		expect(r.actualLine).toBe(1);
		// Real code in the wrong place is still the wrong place. The cited file
		// does not contain this, so it cannot pass.
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/misattributed/i);
	});

	it("NEVER reports misattribution when the cited file matches, even weakly", () => {
		// `named.ts` holds this with a trailing comment on one line, so it only
		// matches there as a truncation, while `right.ts` holds it verbatim. The
		// cited file still wins: the whole point of the verdict is to say the
		// model looked in the wrong file, and it did not.
		const r = verifyQuote({ file: "named.ts", startLine: 2, code: QUEUED_EVENT }, dir, {
			searchFiles: ["named.ts", "right.ts"],
		});
		expect(r.verdict).toBe("truncated");
		expect(r.actualFile).toBeUndefined();
	});

	it("NEVER reports misattribution for a quote that is exact in the cited file", () => {
		const r = verifyQuote({ file: "right.ts", startLine: 1, code: QUEUED_EVENT }, dir, {
			searchFiles: ["right.ts", "named.ts"],
		});
		expect(r.verdict).toBe("exact");
	});

	it("does not search at all without candidates", () => {
		// The runtime cost of this search is bounded by the caller's list, so an
		// absent list has to mean an absent search rather than a repo sweep.
		expect(verdictOf("elsewhere.ts", 1, QUEUED_EVENT)).toBe("fabricated");
	});

	it("ignores the cited file when it appears in its own candidate list", () => {
		expect(verdictOf("elsewhere.ts", 1, QUEUED_EVENT, ["elsewhere.ts"])).toBe("fabricated");
	});

	it("tolerates an unreadable candidate", () => {
		expect(verdictOf("elsewhere.ts", 1, QUEUED_EVENT, ["ghost.ts", "right.ts"])).toBe("misattributed");
	});
});

describe("verdict: fabricated, missing-file and empty", () => {
	it("reports invention as fabricated", () => {
		const r = verifyQuote({ file: "elide.ts", startLine: 1, code: "export const neverWritten = 1" }, dir);
		expect(r.verdict).toBe("fabricated");
		expect(r.valid).toBe(false);
		expect(r.actualLine).toBeUndefined();
		expect(r.reason).toMatch(/fabricated/i);
	});

	it("reports a cited path that does not exist", () => {
		const r = verifyQuote({ file: "nope.ts", startLine: 1, code: "anything" }, dir);
		expect(r.verdict).toBe("missing-file");
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/file not found/i);
	});

	it("reports a header with no code under it", () => {
		const r = verifyQuote({ file: "elide.ts", startLine: 1, code: "  \n\n " }, dir);
		expect(r.verdict).toBe("empty");
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/empty/i);
	});
});

describe("what `valid` means", () => {
	/**
	 * `valid` answers "is every character the caller can read really in this
	 * file?". Drawing it here — and not at "was the quote complete" — is what
	 * makes `!valid` usable as the release gate with nothing left to subtract:
	 * the two false verdicts are the two where the cited file does not contain
	 * what the report says it does.
	 */
	const cases: [QuoteVerdict, boolean][] = [
		["exact", true],
		["drifted", true],
		["truncated", true],
		["elided", true],
		["reflowed", true],
		["misattributed", false],
		["fabricated", false],
		["missing-file", false],
		["empty", false],
	];

	const produce: Record<QuoteVerdict, () => boolean> = {
		exact: () => verifyQuote({ file: "elide.ts", startLine: 1, code: "export type Entry = {" }, dir).valid,
		drifted: () => verifyQuote({ file: "elide.ts", startLine: 9, code: "  id: string\n  owner: string" }, dir).valid,
		truncated: () =>
			verifyQuote({ file: "clip.ts", startLine: 1, code: [...CLIPPED_HEAD, "// cleanly."].join("\n") }, dir).valid,
		elided: () =>
			verifyQuote(
				{ file: "elide.ts", startLine: 1, code: "export type Entry = {\n  kind: 'entry'\n  id: string\n}" },
				dir,
			).valid,
		reflowed: () =>
			verifyQuote(
				{
					file: "doc.ts",
					startLine: 6,
					code: " * the budget must group the same way or it would see N\n * under-budget messages instead of one over-budget message.",
				},
				dir,
			).valid,
		misattributed: () =>
			verifyQuote({ file: "elsewhere.ts", startLine: 1, code: QUEUED_EVENT }, dir, {
				searchFiles: ["right.ts"],
			}).valid,
		fabricated: () => verifyQuote({ file: "elide.ts", startLine: 1, code: "export const neverWritten = 1" }, dir).valid,
		"missing-file": () => verifyQuote({ file: "nope.ts", startLine: 1, code: "anything" }, dir).valid,
		empty: () => verifyQuote({ file: "elide.ts", startLine: 1, code: " " }, dir).valid,
	};

	for (const [verdict, valid] of cases) {
		it(`treats ${verdict} as ${valid ? "valid" : "invalid"}`, () => {
			expect(produce[verdict]()).toBe(valid);
		});
	}
});
