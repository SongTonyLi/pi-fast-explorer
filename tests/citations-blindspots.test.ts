import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractQuotes, findUnmarkedFailures, reanchorReport, verifyQuote } from "../src/citations.js";

/**
 * The shapes the verifier could not see, and the checker could not see either.
 *
 * An audit fed `reanchorReport` a fabricated quote inside each of three ordinary
 * markdown shapes and got `quotes=0, fabricated=0, no marker` from all three —
 * and then `findUnmarkedFailures` reported a clean run on the delivered text,
 * because it re-parses with the same parser. A check that passes because it
 * cannot see is the failure this package has hit before, and the one that has to
 * stop recurring.
 *
 * Every test here is written against the delivered text: for each shape, a quote
 * of code that is NOT in the file must come out either marked or reported as
 * unparseable. "Neither" is the bug.
 */
const dir = mkdtempSync(join(tmpdir(), "fx-blind-"));
for (const sub of ["src", "db", "web", "app", "boot", "plot", "style"]) {
	mkdirSync(join(dir, sub), { recursive: true });
}

writeFileSync(
	join(dir, "src", "keep.ts"),
	["export const budgetCeiling = 100", "export const windowMs = 5_000", ""].join("\n"),
);
writeFileSync(
	join(dir, "db", "query.sql"),
	["SELECT id, email FROM accounts", "WHERE deleted_at IS NULL", ""].join("\n"),
);
writeFileSync(
	join(dir, "web", "page.html"),
	["<main class=\"panel\">", "  <h1>Accounts</h1>", "</main>", ""].join("\n"),
);
writeFileSync(
	join(dir, "app", "init.lua"),
	["local config = require('config')", "return config.build()", ""].join("\n"),
);
writeFileSync(
	join(dir, "boot", "start.asm"),
	["mov ax, 0x07C0", "add ax, 0x0220", ""].join("\n"),
);
writeFileSync(
	join(dir, "plot", "fig.m"),
	["figure('Name', 'coverage')", "plot(times, values)", ""].join("\n"),
);
writeFileSync(
	join(dir, "style", "main.css"),
	[".panel { display: grid }", ".panel > h1 { margin: 0 }", ""].join("\n"),
);

const B = "```";
const T = "~~~";

/** The fence header exactly as the caller would read it. */
function deliveredHeader(report: string, fence = B): string {
	const at = report.indexOf(fence);
	return report.slice(at).split("\n")[1] ?? "";
}

/**
 * A fabricated excerpt in each comment style the widened header set admits.
 *
 * Every `code` line is absent from the file it is attributed to, so every one of
 * these must reach the caller marked. Before the widening, every row but the
 * first produced no quote at all — on a SQL, HTML, Lua, assembly, MATLAB or CSS
 * repository that is not one missed block, it is all of them.
 */
const MARKER_CASES: { name: string; header: string; code: string }[] = [
	{ name: "//", header: "// src/keep.ts:1", code: "export const neverWritten = 1" },
	{ name: "#", header: "# src/keep.ts:1", code: "export const neverWritten = 1" },
	{ name: "--", header: "-- db/query.sql:1", code: "DELETE FROM accounts WHERE 1=1" },
	{ name: "<!--", header: "<!-- web/page.html:1 -->", code: "<aside>invented</aside>" },
	{ name: "-- (lua)", header: "-- app/init.lua:1", code: "local invented = true" },
	{ name: ";", header: "; boot/start.asm:1", code: "int 0x80" },
	{ name: "%", header: "% plot/fig.m:1", code: "title('invented')" },
	{ name: "/*", header: "/* style/main.css:1 */", code: ".invented { color: red }" },
];

describe("comment markers other than // and #", () => {
	for (const { name, header, code } of MARKER_CASES) {
		it(`extracts and verifies a quote headed with ${name}`, () => {
			const report = [`${B}text`, header, code, B, ""].join("\n");
			const quotes = extractQuotes(report);
			expect(quotes).toHaveLength(1);
			expect(verifyQuote(quotes[0]!, dir).verdict).toBe("fabricated");
		});

		it(`marks a fabrication headed with ${name}, and leaves no unmarked failure`, () => {
			const report = [`${B}text`, header, code, B, ""].join("\n");
			// Raw, the failure is visible and unmarked — which is what makes the
			// delivered assertion below mean something.
			expect(findUnmarkedFailures(report, dir)).toHaveLength(1);

			const out = reanchorReport(report, dir);
			expect(out.fabricated).toBe(1);
			expect(deliveredHeader(out.report)).toContain("UNVERIFIED");
			expect(findUnmarkedFailures(out.report, dir)).toEqual([]);
			// The model's code is never discarded, only the header's claim changes.
			expect(out.report).toContain(code);
		});

		it(`re-anchors a ${name} block idempotently`, () => {
			const report = [`${B}text`, header, code, B, ""].join("\n");
			const once = reanchorReport(report, dir).report;
			expect(reanchorReport(once, dir).report).toBe(once);
			expect(deliveredHeader(once).split(" — ")).toHaveLength(2);
		});
	}

	it("keeps a two-sided comment closed when it corrects the anchor", () => {
		// `<!-- page.html:1 -->` whose code is really at line 2. Rewriting the line
		// number must not drop the `-->` and hand the caller a broken comment.
		const report = [`${B}html`, "<!-- web/page.html:1 -->", "  <h1>Accounts</h1>", B, ""].join("\n");
		const out = reanchorReport(report, dir);
		expect(out.corrected).toBe(1);
		expect(deliveredHeader(out.report)).toBe("<!-- web/page.html:2 -->");
		expect(findUnmarkedFailures(out.report, dir)).toEqual([]);
		expect(reanchorReport(out.report, dir).report).toBe(out.report);
	});

	it("does the same for a C-style block comment header", () => {
		const report = [`${B}css`, "/* style/main.css:1 */", ".panel > h1 { margin: 0 }", B, ""].join("\n");
		const out = reanchorReport(report, dir);
		expect(out.corrected).toBe(1);
		expect(deliveredHeader(out.report)).toBe("/* style/main.css:2 */");
	});
});

/**
 * The half of the judgement that costs something if it is wrong.
 *
 * Widening the marker set widens what can be mistaken for a header, and a
 * wrongly split block loses a line from verification or gets checked against the
 * wrong file. These are the near-misses: lines that look like headers to a
 * careless pattern and must not split a block.
 */
describe("prose that only looks like a header", () => {
	const notHeaders = [
		"-- see db/query.sql:12 for why",
		"-- 10:30:00",
		"---",
		"; TODO: boot/start.asm:1 needs a rewrite",
		"% coverage was 12:00",
		"<!-- web/page.html -->",
		"/* style/main.css */",
		"' src/keep.ts:1",
		"! src/keep.ts:1",
		"* src/keep.ts:1",
	];

	for (const line of notHeaders) {
		it(`does not split a block on ${JSON.stringify(line)}`, () => {
			const report = [
				`${B}ts`,
				"// src/keep.ts:1",
				"export const budgetCeiling = 100",
				line,
				"export const windowMs = 5_000",
				B,
				"",
			].join("\n");
			// One quote, not two: the line stayed part of the code.
			const quotes = extractQuotes(report);
			expect(quotes).toHaveLength(1);
			expect(quotes[0]!.code).toContain(line);
		});
	}

	it("leaves `'` and `!` outside the marker set deliberately", () => {
		// VB and Fortran, the two openers the widened set does NOT admit. If someone
		// adds them, this test is where the decision gets re-made rather than
		// happening by accident: the block below would start parsing as a citation.
		for (const header of ["' src/keep.ts:1", "! src/keep.ts:1"]) {
			expect(extractQuotes([`${B}vb`, header, "invented", B, ""].join("\n"))).toEqual([]);
		}
	});
});

describe("tilde fences", () => {
	it("verifies a quote inside a ~~~ fence", () => {
		const report = [`${T}sql`, "-- db/query.sql:1", "SELECT id, email FROM accounts", T, ""].join("\n");
		const quotes = extractQuotes(report);
		expect(quotes).toHaveLength(1);
		expect(verifyQuote(quotes[0]!, dir).verdict).toBe("exact");
	});

	it("marks a fabrication inside a ~~~ fence and keeps the fence a tilde fence", () => {
		const report = [`${T}sql`, "-- db/query.sql:1", "DROP TABLE accounts", T, ""].join("\n");
		expect(findUnmarkedFailures(report, dir)).toHaveLength(1);
		const out = reanchorReport(report, dir);
		expect(out.fabricated).toBe(1);
		expect(out.report.startsWith(`${T}sql\n`)).toBe(true);
		expect(out.report.trimEnd().endsWith(T)).toBe(true);
		expect(deliveredHeader(out.report, T)).toContain("UNVERIFIED");
		expect(findUnmarkedFailures(out.report, dir)).toEqual([]);
	});

	it("does not let a backtick fence close a tilde fence", () => {
		// Mixing the two is not a closed block; it is an unterminated tilde fence
		// with a backtick run inside it. It must not be parsed as a verified quote.
		const report = [`${T}sql`, "-- db/query.sql:1", "DROP TABLE accounts", B, ""].join("\n");
		expect(extractQuotes(report)).toEqual([]);
		expect(findUnmarkedFailures(report, dir).map((f) => f.verdict)).toEqual(["unparsed"]);
	});

	it("leaves a headerless ~~~ block alone and reports nothing for it", () => {
		const prose = `Some prose.\n\n${T}sh\nnpm run build\n${T}\n`;
		expect(findUnmarkedFailures(prose, dir)).toEqual([]);
		expect(reanchorReport(prose, dir).report).toBe(prose);
	});
});

describe("a fence that is never closed", () => {
	const truncated = [
		"## Key Code",
		"",
		`${B}ts`,
		"// src/keep.ts:1",
		"export const neverWritten = 1",
	].join("\n");

	it("extracts no quote from it, deliberately", () => {
		// Parsing to end-of-report is the tempting alternative and it is worse: the
		// "quote" would include whatever prose followed the fence, and the verdict
		// would be a fabrication the parser manufactured.
		expect(extractQuotes(truncated)).toEqual([]);
	});

	it("is reported rather than passed over in silence", () => {
		const gaps = findUnmarkedFailures(truncated, dir);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]!.verdict).toBe("unparsed");
		expect(gaps[0]!.file).toBe("src/keep.ts");
		expect(gaps[0]!.startLine).toBe(1);
		expect(gaps[0]!.header).toBe("// src/keep.ts:1");
		expect(gaps[0]!.reason).toMatch(/never closed/i);
	});

	it("reaches the caller marked UNCHECKED, and then reports clean", () => {
		const out = reanchorReport(truncated, dir);
		expect(out.unparsed).toBe(1);
		expect(out.fabricated).toBe(0);
		expect(out.report).toContain("// src/keep.ts:1 — UNCHECKED: unterminated code fence");
		expect(findUnmarkedFailures(out.report, dir)).toEqual([]);
		// The excerpt itself is untouched — we did not verify it, so we say so
		// rather than editing it.
		expect(out.report).toContain("export const neverWritten = 1");
	});

	it("re-anchors idempotently", () => {
		const once = reanchorReport(truncated, dir).report;
		const twice = reanchorReport(once, dir).report;
		expect(twice).toBe(once);
		expect(reanchorReport(twice, dir).report).toBe(once);
	});

	it("does not correct the anchor of a block it could not read", () => {
		// The quote below IS in the file, at line 2. A pass that "corrected" the
		// header would be claiming to have checked a block it never parsed.
		const drifted = [`${B}ts`, "// src/keep.ts:1", "export const windowMs = 5_000"].join("\n");
		const out = reanchorReport(drifted, dir);
		expect(out.corrected).toBe(0);
		expect(out.report).toContain("// src/keep.ts:1 — UNCHECKED");
	});

	it("reports nothing for an unterminated fence that claims nothing", () => {
		// No `path:line` header, so no claim to be a checked excerpt — the same
		// treatment a closed headerless fence has always had. Counted, not flagged.
		const noClaim = `Prose.\n\n${B}sh\nnpm run build --watch`;
		expect(findUnmarkedFailures(noClaim, dir)).toEqual([]);
		const out = reanchorReport(noClaim, dir);
		expect(out.unparsed).toBe(1);
		expect(out.report).toBe(noClaim);
	});

	it("pairs an odd fence run sequentially, as markdown does", () => {
		// Three delimiters: the second opens nothing, it closes the first. Recorded
		// so nobody reads the unterminated handling as cleverer than it is.
		const odd = [
			`${B}ts`,
			"// src/keep.ts:1",
			"export const budgetCeiling = 100",
			`${B}ts`,
			"// src/keep.ts:2",
			"export const windowMs = 5_000",
		].join("\n");
		const quotes = extractQuotes(odd);
		expect(quotes).toHaveLength(1);
		expect(quotes[0]!.startLine).toBe(1);
		expect(findUnmarkedFailures(odd, dir)).toEqual([]);
	});
});

/**
 * The audit's table, reproduced as a test. Every row read
 * `quotes=0, fabricated=0, no marker` before; none may now.
 */
describe("the audited blind spots, end to end", () => {
	const shapes: { name: string; report: string }[] = [
		{
			name: "closed ``` fence (control)",
			report: [`${B}ts`, "// src/keep.ts:1", "const invented = 1", B, ""].join("\n"),
		},
		{
			name: "closed ```` fence",
			report: ["````ts", "// src/keep.ts:1", "const invented = 1", "````", ""].join("\n"),
		},
		{
			name: "unterminated fence",
			report: [`${B}ts`, "// src/keep.ts:1", "const invented = 1"].join("\n"),
		},
		{
			name: "~~~ fence",
			report: [`${T}ts`, "// src/keep.ts:1", "const invented = 1", T, ""].join("\n"),
		},
		{
			name: "-- header",
			report: [`${B}sql`, "-- db/query.sql:1", "DROP TABLE accounts", B, ""].join("\n"),
		},
	];

	for (const { name, report } of shapes) {
		it(`does not ship ${name} both unverified and unreported`, () => {
			const gaps = findUnmarkedFailures(report, dir);
			expect(gaps).toHaveLength(1);

			const out = reanchorReport(report, dir);
			// Either the verifier judged it (fabricated) or it said it could not
			// (unparsed). What it may never do is count zero of both.
			expect(out.fabricated + out.unparsed).toBe(1);
			expect(findUnmarkedFailures(out.report, dir)).toEqual([]);
			// And the caller can see it: the delivered text carries a note, whichever
			// of the two kinds applies.
			expect(/ — (?:UNVERIFIED|UNCHECKED):/.test(out.report)).toBe(true);
		});
	}
});
