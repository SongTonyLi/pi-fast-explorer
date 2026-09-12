import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractQuotes, findUnmarkedFailures } from "../src/citations.js";
import type { ExplorerResult } from "../src/explorer.js";
import { hasFindings, synthesize } from "../src/synthesis.js";

const dir = mkdtempSync(join(tmpdir(), "fx-synth-"));
writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function ok(brief: string, report: string): ExplorerResult {
	return { brief, report, ok: true, usage: zeroUsage };
}

const FENCE = "```";

describe("synthesize", () => {
	it("includes every successful report", () => {
		const out = synthesize([ok("auth", "auth findings"), ok("db", "db findings")], dir);
		expect(out).toContain("auth findings");
		expect(out).toContain("db findings");
	});

	it("names failed explorers under Not Covered", () => {
		const out = synthesize(
			[
				ok("auth", "auth findings"),
				{ brief: "db layer", report: "", ok: false, error: "timed out", usage: zeroUsage },
			],
			dir,
		);
		expect(out).toContain("## Not Covered");
		expect(out).toContain("db layer");
		expect(out).toContain("timed out");
	});

	it("omits the Not Covered section when everything succeeded", () => {
		expect(synthesize([ok("a", "x")], dir)).not.toContain("## Not Covered");
	});

	it("states plainly when every explorer failed", () => {
		const out = synthesize([{ brief: "a", report: "", ok: false, error: "boom", usage: zeroUsage }], dir);
		expect(out).toMatch(/no findings/i);
		expect(out).toContain("boom");
	});

	it("returns a clear message for no results at all", () => {
		expect(synthesize([], dir)).toMatch(/no explorers/i);
	});

	it("re-anchors citations on the way out", () => {
		// The wiring test: an explorer that quotes real code under a wrong anchor
		// must not reach the main agent with that anchor intact, because the main
		// agent will go and read the line it names.
		const report = `## Key Code\n\n${FENCE}ts\n// a.ts:1\nthree\nfour\n${FENCE}\n`;
		const out = synthesize([ok("a", report)], dir);
		expect(out).toContain("// a.ts:3");
		expect(out).not.toContain("// a.ts:1");
	});

	it("marks fabricated quotes on the way out", () => {
		const report = `## Key Code\n\n${FENCE}ts\n// a.ts:1\nnot in this file\n${FENCE}\n`;
		expect(synthesize([ok("a", report)], dir)).toContain("UNVERIFIED");
	});

	it("delivers no unmarked failure, whatever the explorers sent", () => {
		// The property stated where it actually has to hold. Everything else about
		// re-anchoring is checked one report at a time; this is the text the main
		// agent receives, after several reports have been joined, and it is the only
		// place the guarantee is worth anything. A fabrication that reaches here
		// unlabelled is read as verified and reasoned from as fact.
		//
		// Checked on the joined text on purpose. Joining widens the scope the
		// misattribution search runs over, so a quote one explorer fabricated may be
		// found in a file another explorer cited and come back misattributed
		// instead. Both are failures and both are marked, which is why the check
		// asks whether a note is present rather than whether it is the same note a
		// single-report pass would have written.
		const out = synthesize(
			[
				ok("real", `${FENCE}ts\n// a.ts:1\none\ntwo\n${FENCE}\n`),
				ok("drifted", `${FENCE}ts\n// a.ts:1\nthree\nfour\n${FENCE}\n`),
				ok("invented", `${FENCE}ts\n// a.ts:1\nnothing like this is in the file\n${FENCE}\n`),
				ok("absent", `${FENCE}ts\n// gone.ts:1\nexport const vanished = 1\n${FENCE}\n`),
				ok("hollow", `${FENCE}ts\n// a.ts:2\n${FENCE}\n`),
				{ brief: "failed", report: "", ok: false, error: "timed out", usage: zeroUsage },
				{
					brief: "cut off",
					report: `## Key Code\n${FENCE}ts\n// a.ts:1\ninvented while being cut off\n${FENCE}\n`,
					ok: false,
					partial: true,
					error: "Explorer timed out after 300s while writing its report (turn 8); partial report salvaged",
					usage: zeroUsage,
				},
			],
			dir,
		);
		expect(findUnmarkedFailures(out, dir)).toEqual([]);
		// And not vacuously: the joined text really does carry failing quotes.
		expect(extractQuotes(out).length).toBeGreaterThan(4);
	});

	// A partial report is the text an explorer was still writing when it was
	// killed. Its citations are as real as any other's — they go through the
	// same verifier — but the report is incomplete, and the main agent has to be
	// told both things: here are findings, and this area is not fully covered.
	it("delivers a partial report as marked findings and lists it under Not Covered", () => {
		const out = synthesize(
			[
				{
					brief: "db layer",
					report: "## Files Retrieved\n1. `a.ts` (lines 1-2) - the schema",
					ok: false,
					partial: true,
					error: "Explorer timed out after 300s while writing its report (turn 8); partial report salvaged",
					usage: zeroUsage,
				},
			],
			dir,
		);
		expect(out).toContain("# Explorer: db layer — PARTIAL");
		expect(out).toContain("the schema");
		expect(out).toContain("## Not Covered");
		expect(out).toMatch(/db layer — partially covered/);
		expect(out).not.toMatch(/no findings/i);
	});

	it("counts a non-empty partial report as findings, and an empty one as none", () => {
		const partial = (report: string): ExplorerResult => ({
			brief: "p",
			report,
			ok: false,
			partial: true,
			error: "timed out",
			usage: zeroUsage,
		});
		expect(hasFindings([partial("## Files Retrieved\n1. `a.ts` (lines 1-1) - x")])).toBe(true);
		expect(hasFindings([partial("")])).toBe(false);
	});

	// Measured: told "every explorer failed — timed out", the main agent's next
	// move was to issue the identical call again, which timed out again. The
	// failure text has to say what to do instead.
	it("tells the main agent not to repeat a failed call unchanged", () => {
		const out = synthesize(
			[
				ok("auth", "auth findings"),
				{ brief: "db layer", report: "", ok: false, error: "timed out", usage: zeroUsage },
			],
			dir,
		);
		expect(out).toContain("Do not repeat this explore call unchanged");
		expect(out).toMatch(/narrow|split|read .* directly/i);
	});

	it("carries no retry guidance when everything succeeded", () => {
		expect(synthesize([ok("a", "x")], dir)).not.toContain("Do not repeat");
	});
});
