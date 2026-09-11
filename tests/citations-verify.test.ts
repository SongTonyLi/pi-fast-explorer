import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCitation, verifyQuote } from "../src/citations.js";

const dir = mkdtempSync(join(tmpdir(), "fx-cite-"));
writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");
// Blank line at line 3, used to exercise the blank-line scan in verifyQuote.
writeFileSync(join(dir, "b.ts"), "one\ntwo\n\nthree\nfour\n");
// "alpha/beta" repeats at lines 1-2 and 4-5, so an anchor onto the second copy
// has to survive the search finding the first one.
writeFileSync(join(dir, "c.ts"), "alpha\nbeta\ngamma\nalpha\nbeta\ndelta\n");

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
		const r = verifyQuote({ file: "a.ts", startLine: 2, code: "two\nthree" }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(2);
		expect(r.drift).toBe(0);
	});

	it("accepts verbatim code found elsewhere and reports the drift", () => {
		const r = verifyQuote({ file: "a.ts", startLine: 1, code: "three\nfour" }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(3);
		expect(r.drift).toBe(2);
	});

	it("reports negative drift when the real code sits above the anchor", () => {
		const r = verifyQuote({ file: "a.ts", startLine: 4, code: "one\ntwo" }, dir);
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
		const r = verifyQuote({ file: "a.ts", startLine: 2, code: "  two\n  three  " }, dir);
		expect(r.valid).toBe(true);
		expect(r.drift).toBe(0);
	});

	it("accepts a correct quote that spans a blank line in the file", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 2, code: "two\nthree" }, dir);
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
		const r = verifyQuote({ file: "nope.ts", startLine: 1, code: "two" }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/file not found/i);
	});

	it("re-anchors rather than rejecting an out-of-bounds start line", () => {
		// The old behaviour called this invalid. The code is real; only the number
		// in front of it is wrong, and that is a different defect.
		const r = verifyQuote({ file: "b.ts", startLine: 999, code: "two" }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(2);
		expect(r.drift).toBe(-997);
	});

	it("rejects a quote whose tail is invented even though its head is real", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 4, code: "three\nfour\nFIVE" }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/fabricated/i);
	});

	it("keeps a correct anchor onto the second of two identical blocks", () => {
		const r = verifyQuote({ file: "c.ts", startLine: 4, code: "alpha\nbeta" }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(4);
		expect(r.drift).toBe(0);
	});

	it("resolves a wrong anchor on repeated code to the first occurrence", () => {
		const r = verifyQuote({ file: "c.ts", startLine: 9, code: "alpha\nbeta" }, dir);
		expect(r.valid).toBe(true);
		expect(r.actualLine).toBe(1);
	});
});
