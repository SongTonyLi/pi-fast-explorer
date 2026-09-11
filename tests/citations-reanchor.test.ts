import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractQuotes, reanchorReport, verifyQuote } from "../src/citations.js";

const dir = mkdtempSync(join(tmpdir(), "fx-reanchor-"));
mkdirSync(join(dir, "src"));
// The quoted pair below really lives at lines 3-4, so a report anchoring it at
// line 1 is exactly the drift the benchmark saw 90 times.
writeFileSync(
	join(dir, "src", "session.ts"),
	'import { now } from "./clock.js";\n\nconst REFRESH = 900;\nif (now() - issued >= REFRESH) {}\nexport const done = true;\n',
);
writeFileSync(join(dir, "src", "dup.ts"), "aaa\nbbb\nccc\n");

/** Written out rather than inlined so the fences below stay readable. */
const F = "```";

describe("reanchorReport", () => {
	const report = [
		"## Files Retrieved",
		"1. `src/session.ts` (lines 1-4) - session refresh",
		"2. `src/ghost.ts` (lines 1-2) - never opened",
		"",
		"## Key Code",
		"",
		`${F}typescript`,
		"// src/session.ts:1",
		"const REFRESH = 900;",
		"if (now() - issued >= REFRESH) {}",
		F,
		"",
		`${F}typescript`,
		"// src/session.ts:20",
		"const INVENTED = neverWritten();",
		F,
		"",
		`${F}typescript`,
		"// src/ghost.ts:1",
		"export function ghost() {}",
		F,
		"",
		`${F}typescript`,
		"// src/session.ts:5",
		"export const done = true;",
		F,
		"",
	].join("\n");

	const result = reanchorReport(report, dir);

	it("rewrites a drifted fence header to the verified line", () => {
		expect(result.report).toContain("// src/session.ts:3");
		expect(result.report).not.toContain("// src/session.ts:1\n");
	});

	it("leaves an already-correct header untouched", () => {
		expect(result.report).toContain("// src/session.ts:5\nexport const done = true;");
	});

	it("marks a fabricated block without discarding its code", () => {
		expect(result.report).toContain("// src/session.ts:20 — UNVERIFIED: not found in file");
		// The caller may still recognise the snippet; what it must not do is
		// believe the file contains it.
		expect(result.report).toContain("const INVENTED = neverWritten();");
	});

	it("marks a quote whose file does not exist", () => {
		expect(result.report).toContain("// src/ghost.ts:1 — UNVERIFIED: file not found");
	});

	it("shifts the Files Retrieved entry its quote pinned down", () => {
		expect(result.report).toContain("1. `src/session.ts` (lines 3-6) - session refresh");
	});

	it("leaves a Files Retrieved entry alone when no quote pins it", () => {
		expect(result.report).toContain("2. `src/ghost.ts` (lines 1-2) - never opened");
	});

	it("counts one corrected header plus its citation entry, and two unverified", () => {
		expect(result.corrected).toBe(2);
		expect(result.fabricated).toBe(2);
	});

	it("produces identical text on a second pass", () => {
		const again = reanchorReport(result.report, dir);
		expect(again.report).toBe(result.report);
		expect(again.corrected).toBe(0);
		// Still two blocks we cannot verify: the counts report what the pass
		// found, not what it had to change.
		expect(again.fabricated).toBe(2);
	});

	it("keeps a marked block visible to the quote extractor", () => {
		// If our own marker stopped the block parsing as a quote, annotating a
		// fabrication would delete it from the verifier's denominator and raise
		// the fidelity score by hiding the failure.
		const quotes = extractQuotes(result.report);
		expect(quotes).toHaveLength(4);
		expect(quotes.map((q) => `${q.file}:${q.startLine}`)).toContain("src/session.ts:20");
		expect(verifyQuote(quotes[1]!, dir).valid).toBe(false);
	});

	it("leaves fenced blocks that carry no citation header alone", () => {
		const prose = `Some prose.\n\n${F}sh\nnpm run build\n${F}\n`;
		const out = reanchorReport(prose, dir);
		expect(out.report).toBe(prose);
		expect(out.corrected).toBe(0);
	});

	it("leaves an entry alone when two quotes disagree about the same anchor", () => {
		const ambiguous = [
			"## Files Retrieved",
			"1. `src/dup.ts` (lines 1-3) - two readings",
			"",
			`${F}text`,
			"// src/dup.ts:1",
			"bbb",
			F,
			"",
			`${F}text`,
			"// src/dup.ts:1",
			"ccc",
			F,
			"",
		].join("\n");
		const out = reanchorReport(ambiguous, dir);
		// Both headers are correctable on their own; the entry they both claim is
		// not, so it is left as written rather than resolved by precedence.
		expect(out.report).toContain("// src/dup.ts:2");
		expect(out.report).toContain("// src/dup.ts:3");
		expect(out.report).toContain("1. `src/dup.ts` (lines 1-3) - two readings");
		expect(out.corrected).toBe(2);
	});

	it("leaves a header with no code body exactly as written", () => {
		const empty = `${F}ts\n// src/session.ts:9\n${F}\n`;
		const out = reanchorReport(empty, dir);
		expect(out.report).toBe(empty);
		expect(out.fabricated).toBe(0);
	});
});

/**
 * `reanchorReport` is what the caller actually reads, so it has to split grouped
 * blocks the same way `extractQuotes` does. If only the extractor were fixed the
 * benchmark would score a grouped block clean while the shipped report still
 * stamped it UNVERIFIED — the gate and the artifact disagreeing about the same
 * text, which is worse than either being wrong on its own.
 */
describe("reanchorReport on blocks holding several excerpts", () => {
	const grouped = [
		`${F}typescript`,
		"// src/session.ts:1",
		"const REFRESH = 900;",
		"if (now() - issued >= REFRESH) {}",
		"",
		"// src/session.ts:5",
		"export const done = true;",
		"",
		"// src/session.ts:40",
		"const INVENTED = neverWritten();",
		F,
		"",
	].join("\n");
	const result = reanchorReport(grouped, dir);

	it("corrects the drifted excerpt without touching the correct one", () => {
		expect(result.report).toContain("// src/session.ts:3\nconst REFRESH = 900;");
		expect(result.report).toContain("// src/session.ts:5\nexport const done = true;");
	});

	it("marks only the unverifiable excerpt, not the block around it", () => {
		expect(result.report).toContain("// src/session.ts:40 — UNVERIFIED: not found in file");
		expect(result.report).not.toContain("// src/session.ts:3 — UNVERIFIED");
		expect(result.report).not.toContain("// src/session.ts:5 — UNVERIFIED");
		expect(result.corrected).toBe(1);
		expect(result.fabricated).toBe(1);
	});

	it("keeps the block's fence, language tag and code bytes intact", () => {
		expect(result.report).toContain(`${F}typescript\n// src/session.ts:3`);
		expect(result.report).toContain("const INVENTED = neverWritten();");
		expect(result.report.split(F)).toHaveLength(grouped.split(F).length);
	});

	it("produces identical text on a second pass", () => {
		const again = reanchorReport(result.report, dir);
		expect(again.report).toBe(result.report);
		expect(again.corrected).toBe(0);
		expect(again.fabricated).toBe(1);
	});

	it("leaves a grouped block alone when every excerpt is already correct", () => {
		const clean = [
			`${F}ts`,
			"// src/session.ts:3",
			"const REFRESH = 900;",
			"",
			"// src/session.ts:5",
			"export const done = true;",
			F,
			"",
		].join("\n");
		const out = reanchorReport(clean, dir);
		expect(out.report).toBe(clean);
		expect(out.corrected).toBe(0);
		expect(out.fabricated).toBe(0);
	});
});

/**
 * One marker per verdict, because the caller's correct response differs.
 * PARTIAL means read the block and then go read the rest of the line;
 * UNVERIFIED means do not believe the block; MISATTRIBUTED means believe the
 * code and disbelieve the path. Stamping all of them UNVERIFIED told a caller to
 * discard twelve good excerpts to catch two bad ones — on the reference corpus,
 * literally twelve and two — which is how a warning teaches people to ignore it.
 */
describe("reanchorReport marks blocks by verdict", () => {
	const dir2 = mkdtempSync(join(tmpdir(), "fx-verdict-mark-"));
	mkdirSync(join(dir2, "src"));
	writeFileSync(
		join(dir2, "src", "budget.ts"),
		[
			"// Enforce the per-message budget. Runs BEFORE microcompact, so the",
			"// two compose cleanly. No-ops when the feature is switched off.",
			"export type Entry = {",
			"  kind: 'entry'",
			"  owner: string",
			"  tags: string[]",
			"}",
			"",
		].join("\n"),
	);
	// Holds verbatim what the report is about to attribute to `budget.ts`.
	writeFileSync(
		join(dir2, "src", "events.ts"),
		["type QueuedEvent = {", "  eventName: string", "  async: boolean", "}", ""].join("\n"),
	);

	const report = [
		"## Files Retrieved",
		"1. `src/budget.ts` (lines 1-7) - the budget",
		"2. `src/events.ts` (lines 1-4) - the queue",
		"",
		`${F}typescript`,
		"// src/budget.ts:1",
		"// Enforce the per-message budget. Runs BEFORE microcompact, so the",
		"// two compose cleanly.",
		F,
		"",
		`${F}typescript`,
		"// src/budget.ts:3",
		"export type Entry = {",
		"  kind: 'entry'",
		"  tags: string[]",
		"}",
		F,
		"",
		`${F}typescript`,
		"// src/budget.ts:1",
		"// Enforce the per-message budget. Runs",
		"// BEFORE microcompact, so the two compose cleanly.",
		F,
		"",
		`${F}typescript`,
		"// src/budget.ts:30",
		"type QueuedEvent = {",
		"  eventName: string",
		"  async: boolean",
		"}",
		F,
		"",
		`${F}typescript`,
		"// src/budget.ts:40",
		"export const neverWritten = true;",
		F,
		"",
	].join("\n");
	const result = reanchorReport(report, dir2);

	it("marks a clipped quote as partial, not unverified", () => {
		expect(result.report).toContain(
			"// src/budget.ts:1 — PARTIAL: lines clipped; the text shown is verbatim",
		);
	});

	it("marks an elided quote as partial and says lines were omitted", () => {
		expect(result.report).toContain(
			"// src/budget.ts:3 — PARTIAL: lines omitted; the text shown is verbatim",
		);
	});

	it("marks a re-wrapped comment as partial and says the wording is verbatim", () => {
		expect(result.report).toContain(
			"// src/budget.ts:1 — PARTIAL: comment re-wrapped; the wording is verbatim",
		);
	});

	it("names the real file on a misattributed block", () => {
		// The one verdict where the caller cannot recover the useful fact from the
		// block itself: the code is real, so nothing about it looks wrong.
		expect(result.report).toContain(
			"// src/budget.ts:30 — MISATTRIBUTED: this code is in src/events.ts:1, not here",
		);
	});

	it("leaves the header's own path alone even when it knows the right one", () => {
		// Rewriting a path would be inventing a finding on the model's behalf. The
		// note carries the correction; the claim stays the model's.
		expect(result.report).not.toContain("// src/events.ts:1\ntype QueuedEvent");
	});

	it("still says UNVERIFIED for code that is nowhere", () => {
		expect(result.report).toContain("// src/budget.ts:40 — UNVERIFIED: not found in file");
		expect(result.report).toContain("export const neverWritten = true;");
	});

	it("keeps every block's code bytes and fences intact", () => {
		expect(result.report).toContain("  tags: string[]");
		expect(result.report).toContain("  eventName: string");
		expect(result.report.split(F)).toHaveLength(report.split(F).length);
	});

	it("counts partial, misattributed and fabricated apart from each other", () => {
		// The old single number was 5 here, and a gate on it would fire almost
		// entirely on the three blocks whose content is real.
		expect(result.partial).toBe(3);
		expect(result.misattributed).toBe(1);
		expect(result.fabricated).toBe(1);
	});

	it("keeps every marked block visible to the quote extractor", () => {
		// The regression this pins: a marker that defeats the header regex deletes
		// the block from the verifier's denominator, so annotating a failure RAISES
		// the fidelity score. Every new marker has to be stripped before the header
		// is parsed, exactly as UNVERIFIED is.
		const quotes = extractQuotes(result.report);
		expect(quotes).toHaveLength(5);
		expect(quotes.map((q) => `${q.file}:${q.startLine}`)).toEqual([
			"src/budget.ts:1",
			"src/budget.ts:3",
			"src/budget.ts:1",
			"src/budget.ts:30",
			"src/budget.ts:40",
		]);
	});

	it("produces identical text on a second pass", () => {
		const again = reanchorReport(result.report, dir2);
		expect(again.report).toBe(result.report);
		expect(again.corrected).toBe(0);
		expect(again.partial).toBe(3);
		expect(again.misattributed).toBe(1);
		expect(again.fabricated).toBe(1);
	});

	it("re-anchors a partial quote whose line number is also wrong", () => {
		const drifted = [
			`${F}ts`,
			"// src/budget.ts:9",
			"export type Entry = {",
			"  kind: 'entry'",
			"  tags: string[]",
			"}",
			F,
			"",
		].join("\n");
		const out = reanchorReport(drifted, dir2);
		// Corrected AND marked. The content is real, so the anchor is worth fixing;
		// it is incomplete, so the caller is told.
		expect(out.report).toContain("// src/budget.ts:3 — PARTIAL: lines omitted");
		expect(out.corrected).toBe(1);
		expect(out.partial).toBe(1);
	});

	it("does not hunt for misattribution outside the files the report cites", () => {
		// `events.ts` exists and holds this verbatim, but a report that never
		// mentions it gets no search of it. That bound is what keeps the cost
		// inside a user's agent turn proportional to the report, not the repo.
		const lonely = [
			`${F}ts`,
			"// src/budget.ts:30",
			"type QueuedEvent = {",
			"  eventName: string",
			"  async: boolean",
			"}",
			F,
			"",
		].join("\n");
		const out = reanchorReport(lonely, dir2);
		expect(out.misattributed).toBe(0);
		expect(out.fabricated).toBe(1);
	});
});
