import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChecklist } from "../src/checklist.js";
import { extractCitations, extractQuotes } from "../src/citations.js";
import { EXPLORER_TOOLS } from "../src/explorer.js";

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

/** The five sections an explorer is instructed to emit, in order. */
const OUTPUT_SECTIONS = ["## Files Retrieved", "## Key Code", "## Checklist", "## Architecture", "## Not Covered"];

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

	// src/checklist.ts parses the Checklist section the same way citations.ts
	// parses the others: by shape. The worked example must be the shape.
	it("checklist example parses as one resolved and one unresolved line", () => {
		const lines = parseChecklist(PROMPT);
		expect(lines, DRIFT).toHaveLength(2);
		expect(lines[0]?.resolved, DRIFT).toBe(true);
		expect(lines[1]?.resolved, DRIFT).toBe(false);
		expect(lines.map((l) => l.index), DRIFT).toEqual([1, 2]);
	});

	// Explorers are spawned with a fixed tool set and no way to widen it. An
	// explorer that hits the edge of that set has two bad options — retry the
	// same call, or improvise an answer it cannot support — and one good one:
	// say what it could not do. The prompt has to name the tools it actually
	// has, from the same constant the spawn uses, or it describes a different
	// explorer than the one running.
	it("tells an explorer to report a capability it lacks under Not Covered, not retry", () => {
		const why =
			"the prompt must carry a limits statement: name the spawned tool set from " +
			"EXPLORER_TOOLS, forbid retrying a call those tools cannot make, and route " +
			"the limitation to `## Not Covered` so the dispatching agent can act on it.";
		const start = PROMPT.indexOf("# Limits\n");
		expect(start, why).toBeGreaterThan(-1);
		const rest = PROMPT.slice(start + "# Limits\n".length);
		const end = rest.search(/^# /m);
		const limits = end === -1 ? rest : rest.slice(0, end);
		for (const tool of EXPLORER_TOOLS.split(",")) {
			expect(limits, why).toContain(`\`${tool}\``);
		}
		expect(limits, why).toMatch(/do not retry/i);
		expect(limits, why).toContain("`## Not Covered`");
	});

	it("reserves `##` headings for the five sections explorers emit", () => {
		// Instructional headings live at `#`. If one is written at `##` it becomes
		// indistinguishable from an output section, and an explorer may echo it
		// verbatim into its report.
		const why =
			"only the five emitted sections may be `##` headings. An instructional " +
			"heading at the same level as the output contract invites the explorer to " +
			"echo it as a literal section — demote it to `#` instead.";
		const headings = PROMPT.split("\n").filter((l) => l.startsWith("## "));
		expect(headings, why).toEqual(OUTPUT_SECTIONS);
	});
});
