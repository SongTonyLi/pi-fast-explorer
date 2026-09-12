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
			{ index: 1, explicit: true, resolved: true, text: "find login — src/auth.ts:10 handled here" },
			{ index: 2, explicit: true, resolved: false, text: "find tokens — searched src/, nothing" },
		]);
	});

	it("stops at the next section heading", () => {
		expect(parseChecklist(REPORT).some((l) => l.text.includes("prose"))).toBe(false);
	});

	it("numbers unnumbered bullets by position and accepts an uppercase X", () => {
		expect(parseChecklist("## Checklist\n- [X] a\n- [ ] b\n")).toEqual([
			{ index: 1, explicit: false, resolved: true, text: "a" },
			{ index: 2, explicit: false, resolved: false, text: "b" },
		]);
	});

	// A model that drops the heading still wrote the lines; the lines are the
	// contract, the heading is where they are supposed to live.
	it("falls back to checkbox lines anywhere when the heading is missing", () => {
		expect(parseChecklist("Findings:\n1. [x] a — here\n2. [ ] b\n")).toEqual([
			{ index: 1, explicit: true, resolved: true, text: "a — here" },
			{ index: 2, explicit: true, resolved: false, text: "b" },
		]);
	});

	it("returns nothing for a report with no checklist", () => {
		expect(parseChecklist("## Files Retrieved\n1. `a.ts` (lines 1-2) - x\n")).toEqual([]);
		expect(parseChecklist("")).toEqual([]);
	});
});

describe("matchChecklist", () => {
	const items = ["find login", "find tokens"];

	it("matches echoed items by text and strips the echo from the note", () => {
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

	// Measured: explorers restate the item in their own words before the
	// answer ("File path where agent events are persisted on disk — src/…"),
	// so the coverage line read "item — paraphrase — answer". A leading clause
	// that is mostly the item's own words is the item, not the answer.
	it("strips a paraphrase of the item that precedes the answer", () => {
		const out = matchChecklist(
			["The file path where agent events are persisted on disk"],
			[{ brief: "A", report: "## Checklist\n1. [x] File path where agent events are persisted on disk — `src/a.ts:391` sets EVENTS_FILE\n" }],
		);
		expect(out[0]?.note).toBe("`src/a.ts:391` sets EVENTS_FILE");
	});

	it("keeps a leading clause that is not a paraphrase of the item", () => {
		const out = matchChecklist(
			["find login"],
			[{ brief: "A", report: "## Checklist\n1. [x] handled in the auth module — src/auth.ts:10\n" }],
		);
		expect(out[0]?.note).toBe("handled in the auth module — src/auth.ts:10");
	});

	// The item is at the START of the line by contract. Scanning the answer text
	// too lets one item's answer, which naturally mentions related items, claim
	// them — and a wrongly resolved item is never escalated.
	it("does not let one item's answer text claim another item", () => {
		const out = matchChecklist(
			["the idle deadline", "the timeoutMs hard cap default"],
			[{ brief: "A", report: "## Checklist\n1. [x] the idle deadline — armIdle at src/explorer.ts:430, distinct from the timeoutMs hard cap default\n" }],
		);
		expect(out[0]?.resolved).toBe(true);
		expect(out[1]?.resolved).toBe(false);
	});

	// A second-wave explorer is handed a subset and may bullet it, so its
	// positional numbers restart at 1. The numbers that brief carried are known
	// and must be the key, or a wave-2 answer lands on item 1.
	it("maps a subset report's positional lines through the numbers that brief was handed", () => {
		const out = matchChecklist(
			["where the retry budget is configured", "how idle is measured", "how the drain timer is armed"],
			[{ brief: "esc", report: "## Checklist\n- [x] drain timer armed on the exit event — src/explorer.ts:591\n", allowed: [3] }],
		);
		expect(out[0]?.resolved).toBe(false);
		expect(out[2]).toEqual({
			index: 3,
			item: "how the drain timer is armed",
			resolved: true,
			// The leading clause is a paraphrase of the item and is stripped.
			note: "src/explorer.ts:591",
			source: "esc",
		});
	});

	it("ignores an explicit number a subset report was not handed", () => {
		const out = matchChecklist(
			["a", "b", "c"],
			[{ brief: "esc", report: "## Checklist\n1. [x] something — src/y.ts:2\n", allowed: [3] }],
		);
		expect(out.every((s) => !s.resolved)).toBe(true);
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
