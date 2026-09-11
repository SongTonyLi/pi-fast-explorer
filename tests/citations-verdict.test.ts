import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_VERIFY_BYTES, type QuoteVerdict, verifyQuote } from "../src/citations.js";

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

/**
 * A file just over the verification cap, written on first use.
 *
 * Lazy because it is four megabytes and only two tests need it. The content is
 * real source, and the quote below is genuinely IN it — the point of `unread` is
 * that a quote which would have verified comes back unchecked rather than
 * verified, so the fixture has to be one that would otherwise pass.
 */
let hugePath: string | null = null;
function hugeFile(): string {
	if (hugePath === null) {
		hugePath = join(dir, "huge.ts");
		const filler = `const padding = "${"x".repeat(200)}"\n`;
		writeFileSync(
			hugePath,
			`export const findMeInTheHugeFile = 1\n${filler.repeat(Math.ceil(MAX_VERIFY_BYTES / filler.length))}`,
		);
	}
	return "huge.ts";
}

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

/**
 * Short lines, built to sit either side of both triviality floors.
 *
 * Lengths are exact and load-bearing, so they are spelled out here rather than
 * left to be counted off the page:
 *
 *   const x = 1;               12 chars, occurs once  — genuine evidence
 *   let ab;                     7 chars, occurs once  — under the floor
 *   let abc;                    8 chars, occurs once  — on the floor
 *   retry(attempts, optsX);    23 chars, occurs twice — under MIN_DISTINCT_CHARS
 *   retry(attempts, optsXY);   24 chars, occurs twice — on MIN_DISTINCT_CHARS
 *   if (ready) {               12 chars, occurs twice — the `.optional()` shape
 *   }                           1 char,  occurs four times
 *
 * The nested function at the end exists only so that two `}` lines sit next to
 * each other, which is what a multi-line trivial quote needs to match against.
 */
writeFileSync(
	join(dir, "short.ts"),
	[
		"const x = 1;",
		"let ab;",
		"let abc;",
		"retry(attempts, optsX);",
		"retry(attempts, optsXY);",
		"if (ready) {",
		"  work();",
		"}",
		"retry(attempts, optsX);",
		"retry(attempts, optsXY);",
		"if (ready) {",
		"  work();",
		"}",
		"function nest() {",
		"  if (done) {",
		"    settle();",
		"  }",
		"}",
		"",
	].join("\n"),
);

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

/**
 * The hole this verdict closes: the exact-match path had no floor under it, so
 * a quote of `}` verified as `exact` on the strength of the file containing a
 * brace. Nothing was invented and nothing was demonstrated, and scoring it as a
 * pass inflated fidelity with matches that carry no information.
 *
 * The pairs below are the whole rule. Each floor gets the case just under it
 * and the case just over it, because a threshold nobody can see moving is a
 * threshold that moves.
 */
describe("verdict: trivial", () => {
	it("REFUSES to call a lone `}` exact, though the file does contain one", () => {
		// The hole, stated directly. `elide.ts` has exactly ONE `}`, so this quote
		// even pins down a unique location — and it is still not evidence. That is
		// why the shortest floor is unconditional and not a distinctiveness test:
		// 7.7% of the reference corpus's files contain exactly one `}`.
		const r = verifyQuote({ file: "elide.ts", startLine: 6, code: "}" }, dir);
		expect(r.verdict).toBe("trivial");
		expect(r.valid).toBe(false);
		expect(r.checkable).toBe(false);
		expect(r.reason).toMatch(/trivial/i);
	});

	it("REFUSES a lone comment marker", () => {
		expect(verdictOf("doc.ts", 3, "/**")).toBe("trivial");
		expect(verdictOf("doc.ts", 7, "*/")).toBe("trivial");
	});

	it("does NOT call a genuine short quote trivial", () => {
		// Twelve characters, one place in the file. Shorter than several of the
		// fragments refused above and evidence where they are not, which is the
		// whole reason the rule is not a plain character floor.
		const r = verifyQuote({ file: "short.ts", startLine: 1, code: "const x = 1;" }, dir);
		expect(r.verdict).toBe("exact");
		expect(r.valid).toBe(true);
		expect(r.checkable).toBe(true);
	});

	it("holds the floor at 8 characters: 7 is trivial, 8 is not", () => {
		// Both occur exactly once. The only difference between them is one
		// character, and that is deliberate — pinning the pair keeps the floor from
		// being moved without a test going red.
		expect(verdictOf("short.ts", 2, "let ab;")).toBe("trivial");
		expect(verdictOf("short.ts", 3, "let abc;")).toBe("exact");
	});

	it("counts characters over the whole quote, not per line", () => {
		// The two adjacent braces closing `nest()`. Two lines, two characters, and
		// the floor is a property of the quote rather than of any line in it — a
		// report cannot get past it by spreading punctuation over more lines.
		expect(verdictOf("short.ts", 17, "}\n}")).toBe("trivial");
	});

	it("calls a short fragment the file repeats trivial, though it matched", () => {
		// 12 characters, twice in the file — the `.optional()` / `} else {` shape.
		// Identical in length to `const x = 1;` above and opposite in verdict,
		// which is distinctiveness doing the work length cannot.
		const r = verifyQuote({ file: "short.ts", startLine: 6, code: "if (ready) {" }, dir);
		expect(r.verdict).toBe("trivial");
		expect(r.reason).toMatch(/occurs 2 times/);
	});

	it("holds the second floor at 24 characters: 23 repeated is trivial, 24 is not", () => {
		// Both occur twice. Past MIN_DISTINCT_CHARS, content is evidence whatever
		// else is true of it — real code that happens to repeat is still real code.
		expect(verdictOf("short.ts", 4, "retry(attempts, optsX);")).toBe("trivial");
		expect(verdictOf("short.ts", 5, "retry(attempts, optsXY);")).toBe("exact");
	});

	it("lets a brace count once it is quoted with enough real code", () => {
		// The brace is not the problem; a quote made only of braces is. Twenty-four
		// characters across the two lines, so the length test settles it without
		// ever asking how many places it matched.
		expect(verdictOf("short.ts", 8, "}\nretry(attempts, optsX);")).toBe("exact");
	});

	it("NEVER launders a short invention into trivial", () => {
		// The guard that matters most. Triviality is reachable only from a match
		// that succeeded, so content absent from the file falls through to
		// `fabricated` no matter how slight it is. Relabelling an invention
		// "unverifiable" would be strictly worse than crediting a brace: it would
		// move a real failure out of the gate.
		expect(verdictOf("short.ts", 1, "%%")).toBe("fabricated");
		expect(verdictOf("short.ts", 1, "nope;")).toBe("fabricated");
		expect(verdictOf("short.ts", 1, "retry(attempts, zz);")).toBe("fabricated");
		expect(verdictOf("elide.ts", 1, "]")).toBe("fabricated");
	});

	it("NEVER launders a misattribution into trivial", () => {
		// `elsewhere.ts` has no brace and `right.ts` does. The quote is still an
		// accusation about the wrong file, and triviality does not get to excuse it.
		expect(verdictOf("elsewhere.ts", 4, "}", ["elsewhere.ts", "right.ts"])).toBe("misattributed");
	});

	it("never applies to the verdicts that already carry their own floors", () => {
		// Truncation needs 24 matched characters and reflow needs 40, both at or
		// above MIN_DISTINCT_CHARS, so nothing reaching them can be trivial. Pinned
		// so that lowering one of those floors cannot silently open a path here.
		expect(verdictOf("clip.ts", 1, [...CLIPPED_HEAD, "// cleanly."].join("\n"))).toBe("truncated");
		expect(verdictOf("clip.ts", 1, [...CLIPPED_HEAD, "// cle"].join("\n"))).toBe("reflowed");
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
		// Not valid — nothing was verified. Also not a failure: see `checkable`
		// below, which is what keeps it out of the gate.
		["trivial", false],
		// Same shape, different reason: the file was never opened, so there is
		// nothing the caller can be told is real.
		["unread", false],
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
		trivial: () => verifyQuote({ file: "elide.ts", startLine: 6, code: "}" }, dir).valid,
		unread: () =>
			verifyQuote({ file: hugeFile(), startLine: 1, code: "export const findMeInTheHugeFile = 1" }, dir)
				.valid,
	};

	for (const [verdict, valid] of cases) {
		it(`treats ${verdict} as ${valid ? "valid" : "invalid"}`, () => {
			expect(produce[verdict]()).toBe(valid);
		});
	}
});

/**
 * `valid` answers two of the three things a quote can be. `checkable` is the
 * third: whether there was anything here to answer about.
 *
 * Fidelity is `valid / checkable` and the gate is `!valid && checkable`, so a
 * verdict that got `checkable` wrong in either direction corrupts the number
 * silently — as a pass it inflates fidelity with vacuous matches, as a failure
 * it blocks a release over a model quoting a brace. Every verdict is listed,
 * not just the interesting one, so adding a verdict without deciding this is a
 * compile error rather than a wrong number.
 */
describe("what `checkable` means", () => {
	const checkable: Record<QuoteVerdict, boolean> = {
		exact: true,
		drifted: true,
		truncated: true,
		elided: true,
		reflowed: true,
		misattributed: true,
		fabricated: true,
		"missing-file": true,
		empty: true,
		trivial: false,
		unread: false,
	};

	it("counts everything but trivial and unread", () => {
		expect(verifyQuote({ file: "elide.ts", startLine: 1, code: "export type Entry = {" }, dir).checkable).toBe(
			checkable.exact,
		);
		expect(verifyQuote({ file: "elide.ts", startLine: 1, code: "export const neverWritten = 1" }, dir).checkable).toBe(
			checkable.fabricated,
		);
		expect(verifyQuote({ file: "nope.ts", startLine: 1, code: "anything" }, dir).checkable).toBe(
			checkable["missing-file"],
		);
		expect(verifyQuote({ file: "elide.ts", startLine: 1, code: " " }, dir).checkable).toBe(checkable.empty);
		expect(verifyQuote({ file: "elide.ts", startLine: 6, code: "}" }, dir).checkable).toBe(checkable.trivial);
		expect(
			verifyQuote({ file: hugeFile(), startLine: 1, code: "export const findMeInTheHugeFile = 1" }, dir)
				.checkable,
		).toBe(checkable.unread);
	});

	it("keeps a trivial quote out of both sides of the ratio", () => {
		const r = verifyQuote({ file: "elide.ts", startLine: 6, code: "}" }, dir);
		// Not counted as verified...
		expect(r.valid).toBe(false);
		// ...and not counted at all, so `!valid && checkable` — the gate — is false.
		expect(!r.valid && r.checkable).toBe(false);
	});
});
