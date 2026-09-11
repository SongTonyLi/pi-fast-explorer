import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractQuotes, verifyCitation, verifyQuote } from "../src/citations.js";

const dir = mkdtempSync(join(tmpdir(), "fx-cite-"));

/**
 * These fixtures used to read `one` / `two` / `three` / `four`. They are real
 * lines now because the verifier grew a floor under what counts as evidence: a
 * three-character quote is refused as `trivial` however faithfully it matches,
 * so placeholders that short can no longer stand in for code here.
 *
 * Nothing else about these tests changed. They are about WHERE content was
 * found — drift, re-anchoring, which of two identical copies won — and that is
 * independent of how long the content is, so each placeholder was swapped for a
 * line of the same role that clears the floor.
 */
const L1 = "const alpha = loadAlpha(config);";
const L2 = "const beta = loadBeta(config);";
const L3 = "const gamma = loadGamma(config);";
const L4 = "const delta = loadDelta(config);";

writeFileSync(join(dir, "a.ts"), `${L1}\n${L2}\n${L3}\n${L4}\n`);
// Blank line at line 3, used to exercise the blank-line scan in verifyQuote.
writeFileSync(join(dir, "b.ts"), `${L1}\n${L2}\n\n${L3}\n${L4}\n`);
// L1/L2 repeats at lines 1-2 and 4-5, so an anchor onto the second copy has to
// survive the search finding the first one.
writeFileSync(join(dir, "c.ts"), `${L1}\n${L2}\n${L3}\n${L1}\n${L2}\n${L4}\n`);

describe("verifyCitation", () => {
	it("accepts an in-bounds range", () => {
		expect(verifyCitation({ file: "a.ts", startLine: 2, endLine: 3 }, dir).valid).toBe(true);
	});

	it("rejects a range past end of file", () => {
		const r = verifyCitation({ file: "a.ts", startLine: 2, endLine: 99 }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/out of bounds/i);
	});

	it("rejects a missing file", () => {
		const r = verifyCitation({ file: "nope.ts", startLine: 1, endLine: 1 }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/not found/i);
	});
});

describe("verifyQuote", () => {
	it("reports zero drift for a quote sitting at its stated line", () => {
		const r = verifyQuote({ file: "a.ts", startLine: 2, code: `${L2}\n${L3}` }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(2);
		expect(r.drift).toBe(0);
	});

	it("accepts verbatim code found elsewhere and reports the drift", () => {
		const r = verifyQuote({ file: "a.ts", startLine: 1, code: `${L3}\n${L4}` }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(3);
		expect(r.drift).toBe(2);
	});

	it("reports negative drift when the real code sits above the anchor", () => {
		const r = verifyQuote({ file: "a.ts", startLine: 4, code: `${L1}\n${L2}` }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(1);
		expect(r.drift).toBe(-3);
	});

	it("rejects a hallucinated quote as fabricated", () => {
		const r = verifyQuote({ file: "a.ts", startLine: 2, code: "NOT REAL" }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/fabricated/i);
		expect(r.actualLine).toBeUndefined();
	});

	it("ignores leading and trailing whitespace differences", () => {
		const r = verifyQuote({ file: "a.ts", startLine: 2, code: `  ${L2}\n  ${L3}  ` }, dir);
		expect(r.valid).toBe(true);
		expect(r.drift).toBe(0);
	});

	it("accepts a correct quote that spans a blank line in the file", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 2, code: `${L2}\n${L3}` }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(2);
		expect(r.drift).toBe(0);
	});

	it("rejects an empty quote", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 1, code: "" }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/empty/i);
	});

	it("rejects a whitespace-only quote", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 1, code: "   \n  " }, dir);
		expect(r.valid).toBe(false);
	});

	it("rejects a missing file", () => {
		const r = verifyQuote({ file: "nope.ts", startLine: 1, code: L2 }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/file not found/i);
	});

	it("re-anchors rather than rejecting an out-of-bounds start line", () => {
		// The old behaviour called this invalid. The code is real; only the number
		// in front of it is wrong, and that is a different defect.
		const r = verifyQuote({ file: "b.ts", startLine: 999, code: L2 }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(2);
		expect(r.drift).toBe(-997);
	});

	it("rejects a quote whose tail is invented even though its head is real", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 4, code: `${L3}\n${L4}\nconst epsilon = never();` }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/fabricated/i);
	});

	it("keeps a correct anchor onto the second of two identical blocks", () => {
		const r = verifyQuote({ file: "c.ts", startLine: 4, code: `${L1}\n${L2}` }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(4);
		expect(r.drift).toBe(0);
	});

	it("resolves a wrong anchor on repeated code to the first occurrence", () => {
		const r = verifyQuote({ file: "c.ts", startLine: 9, code: `${L1}\n${L2}` }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(1);
	});
});

/** Written out rather than inlined so the fences below stay readable. */
const F = "```";

/**
 * Splitting a fenced block at every `// path:line` line is a bet: it rescues
 * grouped excerpts, and it mis-cuts a quote whose own code contains a line of
 * that shape. Both directions are pinned here, because a heuristic added later
 * to win the second case would silently lose the first — which is the bug the
 * split exists to fix.
 */
describe("splitting grouped blocks, verified against disk", () => {
	it("verifies both excerpts of a grouped block that used to fail as one", () => {
		const report = [`${F}text`, "// a.ts:1", L1, L2, "", "// a.ts:3", L3, L4, F].join("\n");
		const quotes = extractQuotes(report);
		expect(quotes).toHaveLength(2);
		for (const q of quotes) expect(verifyQuote(q, dir).valid).toBe(true);
		expect(quotes.map((q) => verifyQuote(q, dir).drift)).toEqual([0, 0]);
	});

	it("would score that same block as fabricated if it were read as one quote", () => {
		// The unsplit reading: the second header is swallowed as a line of code,
		// so the quote can never match. This is the artifact being removed, and it
		// is asserted so that regressing the split shows up as this test failing.
		const code = `${L1}\n${L2}\n\n// a.ts:3\n${L3}\n${L4}`;
		const asOneQuote = verifyQuote({ file: "a.ts", startLine: 1, code }, dir);
		expect(asOneQuote.valid).toBe(false);
		expect(asOneQuote.reason).toMatch(/fabricated/i);
	});

	it("mis-cuts a quote whose own source contains a header-shaped comment", () => {
		// The accepted cost. `d.ts` really does contain the line `// e.ts:12`, so
		// the split fires inside a single honest excerpt. Zero lines of the 3.4M
		// in the reference corpus have this shape, which is why the split is
		// unconditional; this test records what it costs when that bet loses.
		const head = "const head = loadHead();";
		const tail = "const tail = loadTail();";
		writeFileSync(join(dir, "d.ts"), `${head}\n// e.ts:12\n${tail}\n`);
		const report = [`${F}text`, "// d.ts:1", head, "// e.ts:12", tail, F].join("\n");
		const quotes = extractQuotes(report);
		expect(quotes).toEqual([
			{ file: "d.ts", startLine: 1, code: head },
			{ file: "e.ts", startLine: 12, code: tail },
		]);
		// The head still verifies. The tail is checked against the file the stray
		// comment named, which does not exist, so it is reported rather than
		// quietly passed.
		expect(verifyQuote(quotes[0]!, dir).valid).toBe(true);
		expect(verifyQuote(quotes[1]!, dir).reason).toMatch(/file not found/i);
	});
});
