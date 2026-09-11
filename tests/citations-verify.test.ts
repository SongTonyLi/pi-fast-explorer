import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCitation, verifyQuote } from "../src/citations.js";

const dir = mkdtempSync(join(tmpdir(), "fx-cite-"));
writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");
// Blank line at line 3, used to exercise the blank-line scan in verifyQuote.
writeFileSync(join(dir, "b.ts"), "one\ntwo\n\nthree\nfour\n");

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
	it("accepts a quote matching the file bytes", () => {
		expect(verifyQuote({ file: "a.ts", startLine: 2, code: "two\nthree" }, dir).valid).toBe(true);
	});

	it("rejects a hallucinated quote", () => {
		const r = verifyQuote({ file: "a.ts", startLine: 2, code: "NOT REAL" }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/does not match/i);
	});

	it("ignores leading and trailing whitespace differences", () => {
		expect(verifyQuote({ file: "a.ts", startLine: 2, code: "  two\n  three  " }, dir).valid).toBe(true);
	});

	it("accepts a correct quote that spans a blank line in the file", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 2, code: "two\nthree" }, dir);
		expect(r.valid).toBe(true);
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

	it("rejects a startLine past end of file", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 999, code: "two" }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/out of bounds/i);
	});

	it("rejects a quote that runs past end of file", () => {
		const r = verifyQuote({ file: "b.ts", startLine: 4, code: "three\nfour\nFIVE" }, dir);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/past end/i);
	});
});
