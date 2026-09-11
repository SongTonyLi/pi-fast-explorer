import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCitation, verifyQuote } from "../src/citations.js";

const dir = mkdtempSync(join(tmpdir(), "fx-cite-"));
writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");

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
});
