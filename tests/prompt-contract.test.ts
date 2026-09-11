import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractCitations, extractQuotes } from "../src/citations.js";

/**
 * `prompts/explorer.md` teaches explorers a citation format that `src/citations.ts`
 * parses with regexes. Nothing at runtime couples the two, and the failure is
 * silent in the dangerous direction: if the prompt drifts, the parsers match
 * nothing, zero extractions yield zero mismatches, and the hallucination gate
 * reports a perfect score while verifying nothing at all.
 *
 * These tests run the real parsers over the prompt's own worked examples, so
 * drift fails loudly here instead of quietly in the quality gate.
 */
const PROMPT_PATH = join(import.meta.dirname, "..", "prompts", "explorer.md");
const PROMPT = readFileSync(PROMPT_PATH, "utf8");

const DRIFT =
	"prompts/explorer.md no longer matches the parsers in src/citations.ts. " +
	"This is not a Markdown nitpick: explorers copy these shapes, the verifier " +
	"extracts nothing from shapes it does not recognise, and a report with zero " +
	"extracted citations scores as zero hallucinations. Reformatting the prompt " +
	"blinds the quality gate rather than breaking it. Restore the example shapes, " +
	"or change src/citations.ts and this test together.";

/** The four sections an explorer is instructed to emit, in order. */
const OUTPUT_SECTIONS = ["## Files Retrieved", "## Key Code", "## Architecture", "## Not Covered"];

describe("explorer prompt citation contract", () => {
	it("worked examples parse as exactly two citations and one quote", () => {
		expect(extractCitations(PROMPT), DRIFT).toHaveLength(2);
		expect(extractQuotes(PROMPT), DRIFT).toHaveLength(1);
	});

	it("citation examples keep the numbered `path` (lines A-B) shape", () => {
		expect(extractCitations(PROMPT), DRIFT).toEqual([
			{ file: "path/to/file.ts", startLine: 10, endLine: 50 },
			{ file: "path/to/other.ts", startLine: 100, endLine: 150 },
		]);
	});

	it("quote example keeps its `// path:line` header", () => {
		const quotes = extractQuotes(PROMPT);
		expect(quotes[0]?.startLine, DRIFT).toBe(71);
		expect(quotes[0]?.code, DRIFT).toBe("if (now - issued >= REFRESH_WINDOW) {}");
	});

	it("examples cite placeholder paths, never real-looking ones", () => {
		// An explorer with nothing worth quoting may echo the example. A
		// real-looking path then fails verification and is logged as a
		// hallucination that we authored, not one the model committed.
		const why =
			"the prompt's examples must use placeholder paths. A plausible real path " +
			"invites the explorer to echo it, which the verifier reads as a fabricated " +
			"citation — inflating the hallucination rate with our own artifact.";
		expect(extractQuotes(PROMPT)[0]?.file, why).toBe("path/to/file.ts");
		expect(PROMPT, why).not.toContain("src/auth/session.ts");
	});

	it("reserves `##` headings for the four sections explorers emit", () => {
		// Instructional headings live at `#`. If one is written at `##` it becomes
		// indistinguishable from an output section, and an explorer may echo it
		// verbatim into its report.
		const why =
			"only the four emitted sections may be `##` headings. An instructional " +
			"heading at the same level as the output contract invites the explorer to " +
			"echo it as a literal section — demote it to `#` instead.";
		const headings = PROMPT.split("\n").filter((l) => l.startsWith("## "));
		expect(headings, why).toEqual(OUTPUT_SECTIONS);
	});
});
