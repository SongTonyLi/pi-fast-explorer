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
