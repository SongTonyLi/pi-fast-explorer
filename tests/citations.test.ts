import { describe, expect, it } from "vitest";
import { extractCitations, extractQuotes } from "../src/citations.js";

const REPORT = `## Files Retrieved
1. \`src/auth/session.ts\` (lines 40-96) - token refresh
2. src/auth/clock.ts (lines 12-28) - skew correction

## Key Code

\`\`\`typescript
// src/auth/session.ts:71
if (now - issued >= REFRESH_WINDOW) {}
\`\`\`

## Architecture
Stuff.
`;

describe("extractCitations", () => {
	it("reads numbered entries with or without backticks", () => {
		expect(extractCitations(REPORT)).toEqual([
			{ file: "src/auth/session.ts", startLine: 40, endLine: 96 },
			{ file: "src/auth/clock.ts", startLine: 12, endLine: 28 },
		]);
	});

	it("accepts singular 'line'", () => {
		expect(extractCitations("1. a.ts (line 5) - x")).toEqual([
			{ file: "a.ts", startLine: 5, endLine: 5 },
		]);
	});

	it("returns empty when there are no citations", () => {
		expect(extractCitations("no citations here")).toEqual([]);
	});
});

describe("extractQuotes", () => {
	it("reads fenced blocks headed by a file:line comment", () => {
		const quotes = extractQuotes(REPORT);
		expect(quotes).toHaveLength(1);
		expect(quotes[0]!.file).toBe("src/auth/session.ts");
		expect(quotes[0]!.startLine).toBe(71);
		expect(quotes[0]!.code).toBe("if (now - issued >= REFRESH_WINDOW) {}");
	});

	it("ignores fenced blocks with no file:line header", () => {
		expect(extractQuotes("```ts\nconst x = 1;\n```")).toEqual([]);
	});
});

/** Written out rather than inlined so the fences below stay readable. */
const F = "```";

/**
 * Explorers group several related excerpts into one fence far more often than
 * the prompt would suggest. Reading only the first header swallowed every later
 * header as if it were code, producing one quote that could never match the file
 * — so an honest grouped excerpt was scored as a fabrication.
 */
describe("extractQuotes on blocks holding several excerpts", () => {
	it("splits a two-excerpt block into two correctly anchored quotes", () => {
		const block = [
			`${F}typescript`,
			"// src/utils/toolResultStorage.ts:97",
			"function getSessionDir() {}",
			"",
			"// src/utils/toolResultStorage.ts:104",
			"function getToolResultsDir() {}",
			F,
		].join("\n");
		expect(extractQuotes(block)).toEqual([
			{ file: "src/utils/toolResultStorage.ts", startLine: 97, code: "function getSessionDir() {}" },
			{
				file: "src/utils/toolResultStorage.ts",
				startLine: 104,
				code: "function getToolResultsDir() {}",
			},
		]);
	});

	it("splits a three-excerpt block, including one naming another file", () => {
		const block = [
			`${F}ts`,
			"// src/a.ts:1",
			"const one = 1;",
			"",
			"// src/a.ts:8",
			"const two = 2;",
			"const three = 3;",
			"",
			"# src/b.py:40",
			"four = 4",
			F,
		].join("\n");
		expect(extractQuotes(block)).toEqual([
			{ file: "src/a.ts", startLine: 1, code: "const one = 1;" },
			{ file: "src/a.ts", startLine: 8, code: "const two = 2;\nconst three = 3;" },
			{ file: "src/b.py", startLine: 40, code: "four = 4" },
		]);
	});

	it("still yields exactly one quote for a multi-line single-excerpt block", () => {
		const block = [`${F}ts`, "// src/a.ts:3", "const one = 1;", "", "const two = 2;", F].join("\n");
		expect(extractQuotes(block)).toEqual([
			{ file: "src/a.ts", startLine: 3, code: "const one = 1;\n\nconst two = 2;" },
		]);
	});

	it("yields nothing when a header appears only below the first line", () => {
		// Splitting mid-block must not promote a block that never announced
		// itself as a citation into one.
		const block = [`${F}ts`, "const x = 1;", "// src/a.ts:9", "const y = 2;", F].join("\n");
		expect(extractQuotes(block)).toEqual([]);
	});

	it("gives a trailing header with no body an empty quote rather than dropping it", () => {
		// verifyQuote rejects the empty quote. Dropping it here instead would
		// delete a malformed citation from the verifier's denominator, which
		// raises the fidelity score by hiding the defect.
		const block = [`${F}ts`, "// src/a.ts:1", "const one = 1;", "", "// src/a.ts:9", "  ", F].join(
			"\n",
		);
		expect(extractQuotes(block)).toEqual([
			{ file: "src/a.ts", startLine: 1, code: "const one = 1;" },
			{ file: "src/a.ts", startLine: 9, code: "  " },
		]);
	});
});
