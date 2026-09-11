import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExplorerResult } from "../src/explorer.js";
import { synthesize } from "../src/synthesis.js";

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
});
