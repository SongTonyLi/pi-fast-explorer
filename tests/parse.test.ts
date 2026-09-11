import { describe, expect, it } from "vitest";
import { parseFindOutput, parseGrepMatches, parseGrepOutput } from "../src/parse.js";

describe("parseGrepOutput", () => {
	it("extracts distinct files and counts matches", () => {
		const out = [
			"src/a.ts:10: const x = 1;",
			"src/a.ts:22: const y = 2;",
			"src/b/c.ts:5: export function f() {}",
		].join("\n");
		expect(parseGrepOutput(out)).toEqual({
			files: ["src/a.ts", "src/b/c.ts"],
			matchCount: 3,
		});
	});

	it("ignores the trailing notices block", () => {
		const out = "src/a.ts:1: hit\n\n[200 matches limit reached. Use limit=400 for more]";
		expect(parseGrepOutput(out).files).toEqual(["src/a.ts"]);
	});

	it("handles paths containing colons in the match text", () => {
		const out = "src/a.ts:7: const url = 'http://x';";
		expect(parseGrepOutput(out)).toEqual({ files: ["src/a.ts"], matchCount: 1 });
	});

	it("returns empty for empty input", () => {
		expect(parseGrepOutput("")).toEqual({ files: [], matchCount: 0 });
	});
});

describe("parseGrepMatches", () => {
	it("keeps the line number and the matched text", () => {
		expect(parseGrepMatches("src/a.ts:10: const x = 1;")).toEqual([
			{ file: "src/a.ts", line: 10, text: "const x = 1;" },
		]);
	});

	// `grep -n`, `rg` and `git grep -n` omit the space pi's own grep inserts.
	// Nothing parsed this shape before, which is why a model searching with the
	// shell was invisible to auto-promotion.
	it("parses the spaceless shape bash search tools emit", () => {
		expect(parseGrepMatches("src/a.ts:10:const x = 1;")).toEqual([
			{ file: "src/a.ts", line: 10, text: "const x = 1;" },
		]);
	});

	it("keeps leading indentation out of the file name and inside the text", () => {
		expect(parseGrepMatches("src/a.ts:10:\t\tconst x = 1;")).toEqual([
			{ file: "src/a.ts", line: 10, text: "\t\tconst x = 1;" },
		]);
	});

	// The strict form is tried first so a path containing `:<digits>:` still wins
	// the way it always did. Relaxing that order would silently truncate paths.
	it("still prefers the strict shape when both could match", () => {
		expect(parseGrepMatches("a:1:b.ts:5: text")).toEqual([
			{ file: "a:1:b.ts", line: 5, text: "text" },
		]);
	});

	it("ignores lines with no line number at all", () => {
		expect(parseGrepMatches("src/a.ts:const x = 1;\nBinary file src/b.bin matches")).toEqual([]);
	});
});

describe("parseFindOutput", () => {
	it("returns one path per line", () => {
		expect(parseFindOutput("src/a.ts\nsrc/b.ts\n")).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("ignores the notices block", () => {
		expect(parseFindOutput("src/a.ts\n\n[1000 results limit reached]")).toEqual(["src/a.ts"]);
	});

	it("returns empty for the no-results sentinel", () => {
		expect(parseFindOutput("No files found matching pattern")).toEqual([]);
	});
});
