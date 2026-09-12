import { describe, expect, it } from "vitest";
import { buildBriefs } from "../src/index.js";

describe("buildBriefs", () => {
	it("uses caller-supplied questions verbatim, avoiding a planner call", () => {
		expect(buildBriefs({ question: "how does auth work", questions: ["find login", "find tokens"] }, 4))
			.toEqual(["find login", "find tokens"]);
	});

	it("caps supplied questions at maxFanout", () => {
		const qs = ["a", "b", "c", "d", "e", "f"];
		expect(buildBriefs({ question: "q", questions: qs }, 3)).toEqual(["a", "b", "c"]);
	});

	it("falls back to the single question when none are supplied", () => {
		expect(buildBriefs({ question: "how does auth work" }, 4)).toEqual(["how does auth work"]);
	});

	it("ignores an empty questions array", () => {
		expect(buildBriefs({ question: "q", questions: [] }, 4)).toEqual(["q"]);
	});

	it("drops blank questions", () => {
		expect(buildBriefs({ question: "q", questions: ["a", "  ", "b"] }, 4)).toEqual(["a", "b"]);
	});
});

describe("resolveExplorerModel", () => {
	it("inherits the session model together with its provider", async () => {
		const { resolveExplorerModel } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(
			resolveExplorerModel(resolveConfig(), { id: "deepseek/deepseek-v4.1-flash", provider: "openrouter" }),
		).toEqual({ id: "deepseek/deepseek-v4.1-flash", provider: "openrouter" });
	});

	it("uses a configured model string without inventing a provider", async () => {
		const { resolveExplorerModel } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(
			resolveExplorerModel(resolveConfig({ model: "openai/gpt-5.6" }), { id: "x", provider: "anthropic" }),
		).toEqual({ id: "openai/gpt-5.6" });
	});

	it("is null when neither config nor session names a model", async () => {
		const { resolveExplorerModel } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(resolveExplorerModel(resolveConfig(), undefined)).toBeNull();
	});
});

describe("buildTask", () => {
	it("appends the checklist and the scope to a brief", async () => {
		const { buildTask } = await import("../src/index.js");
		expect(
			buildTask("how does auth work", [{ index: 1, item: "find login" }, { index: 2, item: "find tokens" }], "src"),
		).toBe(
			"how does auth work\n\nChecklist — resolve every item and cite file:line for each:\n1. find login\n2. find tokens\n\nLimit your search to: src",
		);
	});

	it("is just the brief when there is no checklist and no scope", async () => {
		const { buildTask } = await import("../src/index.js");
		expect(buildTask("q", [], undefined)).toBe("q");
	});
});

describe("buildEscalationBriefs", () => {
	const statuses = [
		{ index: 1, item: "find login", resolved: true, note: "src/auth.ts:10 handled here", source: "A" },
		{ index: 2, item: "find tokens", resolved: false, note: "not reported by any explorer" },
		{ index: 3, item: "find refresh", resolved: false, note: "searched, nothing" },
		{ index: 4, item: "find logout", resolved: false, note: "not reported by any explorer" },
	];
	const prior = ["## Files Retrieved\n1. `src/auth.ts` (lines 1-20) - login\n2. `src/session.ts` (lines 5-9) - s\n"];

	it("spreads unresolved items round-robin over at most maxFanout briefs, keeping their numbers", async () => {
		const { buildEscalationBriefs } = await import("../src/index.js");
		const briefs = buildEscalationBriefs("how does auth work", statuses, prior, 2);
		expect(briefs).toHaveLength(2);
		expect(briefs[0]).toContain("2. find tokens");
		expect(briefs[0]).toContain("4. find logout");
		expect(briefs[0]).not.toContain("3. find refresh");
		expect(briefs[1]).toContain("3. find refresh");
	});

	it("tells each escalation explorer what the first wave established", async () => {
		const { buildEscalationBriefs } = await import("../src/index.js");
		const [brief] = buildEscalationBriefs("how does auth work", statuses, prior, 4);
		expect(brief).toContain("how does auth work");
		expect(brief).toMatch(/already established/);
		expect(brief).toContain("[x] 1. find login — src/auth.ts:10 handled here");
		expect(brief).toContain("src/auth.ts (lines 1-20)");
		expect(brief).toContain("src/session.ts (lines 5-9)");
	});

	it("never makes more briefs than there are unresolved items", async () => {
		const { buildEscalationBriefs } = await import("../src/index.js");
		expect(buildEscalationBriefs("q", statuses, prior, 4)).toHaveLength(3);
	});
});

describe("shouldEscalate", () => {
	const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const okResult = { brief: "a", report: "## Files Retrieved\n1. `a.ts` (lines 1-1) - x", ok: true, usage: zeroUsage };
	const failed = { brief: "a", report: "", ok: false, error: "timed out", usage: zeroUsage };
	const unresolved = [{ index: 1, item: "x", resolved: false, note: "not reported by any explorer" }];
	const resolved = [{ index: 1, item: "x", resolved: true, note: "a.ts:1", source: "a" }];

	it("escalates when something is unresolved and the first wave produced findings", async () => {
		const { shouldEscalate } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(shouldEscalate(resolveConfig(), unresolved, [okResult])).toBe(true);
	});

	it("does not escalate when everything is resolved", async () => {
		const { shouldEscalate } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(shouldEscalate(resolveConfig(), resolved, [okResult])).toBe(false);
	});

	// Re-running the same failure buys nothing; the failure text explains.
	it("does not escalate when the first wave produced no findings", async () => {
		const { shouldEscalate } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(shouldEscalate(resolveConfig(), unresolved, [failed])).toBe(false);
	});

	it("respects the config switch", async () => {
		const { shouldEscalate } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(shouldEscalate(resolveConfig({ escalateUnresolved: false }), unresolved, [okResult])).toBe(false);
	});
});
