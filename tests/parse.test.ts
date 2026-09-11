import { describe, expect, it } from "vitest";
import { parseFindOutput, parseGrepOutput } from "../src/parse.js";

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
