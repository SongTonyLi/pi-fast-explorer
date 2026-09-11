import { describe, expect, it } from "vitest";
import type { ExplorerResult } from "../src/explorer.js";
import { synthesize } from "../src/synthesis.js";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function ok(brief: string, report: string): ExplorerResult {
	return { brief, report, ok: true, usage: zeroUsage };
}

describe("synthesize", () => {
	it("includes every successful report", () => {
		const out = synthesize([ok("auth", "auth findings"), ok("db", "db findings")]);
		expect(out).toContain("auth findings");
		expect(out).toContain("db findings");
	});

	it("names failed explorers under Not Covered", () => {
		const out = synthesize([
			ok("auth", "auth findings"),
			{ brief: "db layer", report: "", ok: false, error: "timed out", usage: zeroUsage },
		]);
		expect(out).toContain("## Not Covered");
		expect(out).toContain("db layer");
		expect(out).toContain("timed out");
	});

	it("omits the Not Covered section when everything succeeded", () => {
		expect(synthesize([ok("a", "x")])).not.toContain("## Not Covered");
	});

	it("states plainly when every explorer failed", () => {
		const out = synthesize([
			{ brief: "a", report: "", ok: false, error: "boom", usage: zeroUsage },
		]);
		expect(out).toMatch(/no findings/i);
		expect(out).toContain("boom");
	});

	it("returns a clear message for no results at all", () => {
		expect(synthesize([])).toMatch(/no explorers/i);
	});
});
