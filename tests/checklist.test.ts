import { describe, expect, it } from "vitest";
import { formatChecklistCoverage, matchChecklist, parseChecklist } from "../src/checklist.js";

const REPORT = [
	"## Files Retrieved",
	"1. `src/auth.ts` (lines 1-20) - login",
	"",
	"## Checklist",
	"1. [x] find login — src/auth.ts:10 handled here",
	"2. [ ] find tokens — searched src/, nothing",
	"",
	"## Architecture",
	"- [x] this bracket is prose, not a checklist line",
].join("\n");

describe("parseChecklist", () => {
	it("reads numbered checkbox lines from the Checklist section", () => {
		expect(parseChecklist(REPORT)).toEqual([
			{ index: 1, resolved: true, text: "find login — src/auth.ts:10 handled here" },
			{ index: 2, resolved: false, text: "find tokens — searched src/, nothing" },
		]);
	});

	it("stops at the next section heading", () => {
		expect(parseChecklist(REPORT).some((l) => l.text.includes("prose"))).toBe(false);
	});

	it("numbers unnumbered bullets by position and accepts an uppercase X", () => {
		expect(parseChecklist("## Checklist\n- [X] a\n- [ ] b\n")).toEqual([
			{ index: 1, resolved: true, text: "a" },
			{ index: 2, resolved: false, text: "b" },
		]);
	});

	// A model that drops the heading still wrote the lines; the lines are the
	// contract, the heading is where they are supposed to live.
	it("falls back to checkbox lines anywhere when the heading is missing", () => {
		expect(parseChecklist("Findings:\n1. [x] a — here\n2. [ ] b\n")).toEqual([
			{ index: 1, resolved: true, text: "a — here" },
			{ index: 2, resolved: false, text: "b" },
		]);
	});

	it("returns nothing for a report with no checklist", () => {
		expect(parseChecklist("## Files Retrieved\n1. `a.ts` (lines 1-2) - x\n")).toEqual([]);
		expect(parseChecklist("")).toEqual([]);
	});
});

describe("matchChecklist", () => {
	const items = ["find login", "find tokens"];

	it("aligns by index and strips the echoed item from the note", () => {
		expect(matchChecklist(items, [{ brief: "A", report: REPORT }])).toEqual([
			{ index: 1, item: "find login", resolved: true, note: "src/auth.ts:10 handled here", source: "A" },
			{ index: 2, item: "find tokens", resolved: false, note: "searched src/, nothing", source: "A" },
		]);
	});

	it("marks an item no report mentions as unresolved", () => {
		const out = matchChecklist(items, [{ brief: "A", report: "## Checklist\n1. [x] find login — src/auth.ts:10\n" }]);
		expect(out[1]).toEqual({ index: 2, item: "find tokens", resolved: false, note: "not reported by any explorer" });
	});

	it("lets any resolved line win across reports and records which explorer resolved it", () => {
		const out = matchChecklist(items, [
			{ brief: "A", report: "## Checklist\n1. [ ] find login — could not find\n" },
			{ brief: "B", report: "## Checklist\n1. [x] find login — src/auth.ts:10\n" },
		]);
		expect(out[0]).toEqual({ index: 1, item: "find login", resolved: true, note: "src/auth.ts:10", source: "B" });
	});

	// An escalation explorer is handed a subset and may renumber it from 1. The
	// echoed item text is the more reliable key when it is present.
	it("matches a renumbered line by its item text", () => {
		const out = matchChecklist(items, [
			{ brief: "B", report: "## Checklist\n1. [x] find tokens — src/token.ts:3 minted here\n" },
		]);
		expect(out[0].resolved).toBe(false);
		expect(out[1]).toEqual({ index: 2, item: "find tokens", resolved: true, note: "src/token.ts:3 minted here", source: "B" });
	});

	it("returns an empty list for an empty checklist", () => {
		expect(matchChecklist([], [{ brief: "A", report: REPORT }])).toEqual([]);
	});
});

describe("formatChecklistCoverage", () => {
	it("summarises the count and lists every item with its state", () => {
		const out = formatChecklistCoverage([
			{ index: 1, item: "find login", resolved: true, note: "src/auth.ts:10 handled here", source: "A" },
			{ index: 2, item: "find tokens", resolved: false, note: "not reported by any explorer" },
		]);
		expect(out.startsWith("## Checklist coverage")).toBe(true);
		expect(out).toContain("1/2 resolved");
		expect(out).toContain("- [x] 1. find login — src/auth.ts:10 handled here");
		expect(out).toContain("- [ ] 2. find tokens — not reported by any explorer");
	});
});
