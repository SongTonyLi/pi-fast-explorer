import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MAX_VERIFY_BYTES,
	findUnmarkedFailures,
	reanchorReport,
	verifyCitation,
	verifyQuote,
} from "../src/citations.js";
import { MAX_VERIFY_FILE_BYTES } from "../src/detect.js";

/**
 * Quote verification reads cited files whole, synchronously, inside the host
 * agent's turn. Until this cap it read them with no size limit at all, while the
 * auto-promotion path next door capped the analogous read at 4 MB — so a report
 * citing a vendored bundle, a minified asset or a matched log blocked the user's
 * event loop for as long as the read took.
 *
 * The rule the cap has to obey is what the rest of this suite is about: a quote
 * we declined to check must not come back verified, and must not come back
 * fabricated either. We did not look.
 */
const dir = mkdtempSync(join(tmpdir(), "fx-large-"));
mkdirSync(join(dir, "src"), { recursive: true });

/** Real content, genuinely at line 1 — so `unread` cannot be mistaken for a miss. */
const REAL_LINE = "export const findMeInTheHugeFile = 1";
const filler = `const padding = "${"x".repeat(200)}"\n`;
writeFileSync(
	join(dir, "src", "huge.ts"),
	`${REAL_LINE}\n${filler.repeat(Math.ceil(MAX_VERIFY_BYTES / filler.length))}`,
);

/** The same first line, in a file small enough to read. */
writeFileSync(join(dir, "src", "small.ts"), `${REAL_LINE}\nexport const other = 2\n`);

const F = "```";

function block(header: string, ...code: string[]): string {
	return [`${F}ts`, header, ...code, F, ""].join("\n");
}

function deliveredHeader(report: string): string {
	return report.split("\n")[1] ?? "";
}

describe("the verification size cap", () => {
	it("is the same number the auto-promotion path uses", () => {
		// Two constants rather than one import, because `bench/run.ts` loads
		// `src/citations.ts` directly under `node --experimental-strip-types`, which
		// cannot resolve the `.js` specifier a value import of detect would need.
		// This assertion is what stops the duplication drifting.
		expect(MAX_VERIFY_BYTES).toBe(MAX_VERIFY_FILE_BYTES);
		expect(MAX_VERIFY_BYTES).toBe(4 * 1024 * 1024);
	});

	it("reports a quote from an over-cap file as unread, not verified", () => {
		const r = verifyQuote({ file: "src/huge.ts", startLine: 1, code: REAL_LINE }, dir);
		expect(r.verdict).toBe("unread");
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/over the .* verification cap/);
	});

	it("does not report it as fabricated or missing", () => {
		// The two verdicts it must never inherit. `missing-file` would accuse the
		// model of citing a file that is sitting right there; `fabricated` would
		// accuse it of inventing a line that is genuinely the file's first.
		const r = verifyQuote({ file: "src/huge.ts", startLine: 1, code: "const notInAnyFile = 9" }, dir);
		expect(r.verdict).toBe("unread");
	});

	it("keeps it out of both sides of the fidelity ratio", () => {
		const r = verifyQuote({ file: "src/huge.ts", startLine: 1, code: REAL_LINE }, dir);
		expect(r.checkable).toBe(false);
		// `!valid && checkable` is the release gate's predicate. A gate that fired
		// because we declined to read a 4 MB file is one people learn to override.
		expect(r.valid && r.checkable).toBe(false);
	});

	it("still verifies the same content in a file under the cap", () => {
		// The negative case for the cap itself: it must not be quietly capping
		// everything.
		expect(verifyQuote({ file: "src/small.ts", startLine: 1, code: REAL_LINE }, dir).verdict).toBe(
			"exact",
		);
	});

	it("does not relocate a quote into an over-cap candidate file", () => {
		// Misattribution is an accusation about a specific other file. A candidate we
		// never opened is no evidence that the code lives there.
		const r = verifyQuote({ file: "src/small.ts", startLine: 9, code: `${filler.trim()}` }, dir, {
			searchFiles: ["src/huge.ts"],
		});
		expect(r.verdict).toBe("fabricated");
	});
});

describe("what the caller is told", () => {
	it("marks the block UNCHECKED rather than shipping it bare", () => {
		const out = reanchorReport(block("// src/huge.ts:1", REAL_LINE), dir);
		expect(out.unread).toBe(1);
		expect(out.fabricated).toBe(0);
		expect(out.trivial).toBe(0);
		expect(deliveredHeader(out.report)).toBe(
			"// src/huge.ts:1 — UNCHECKED: cited file is too large to verify",
		);
	});

	it("does not move the anchor of a block it never read", () => {
		const out = reanchorReport(block("// src/huge.ts:40", REAL_LINE), dir);
		expect(out.corrected).toBe(0);
		expect(out.report).toContain("// src/huge.ts:40 — UNCHECKED");
	});

	it("does not let an unread block poison a citation entry another quote pinned", () => {
		// `unread` abstains from the anchor map, exactly as `empty` and `trivial` do:
		// it knows nothing about any line, so it may neither move a range nor
		// overrule a quote that does.
		const report = [
			"## Files Retrieved",
			"1. `src/small.ts` (lines 1-2) - the real one",
			"",
			block("// src/small.ts:1", "export const other = 2"),
			block("// src/huge.ts:1", REAL_LINE),
		].join("\n");
		const out = reanchorReport(report, dir);
		expect(out.report).toContain("1. `src/small.ts` (lines 2-3)");
		expect(findUnmarkedFailures(out.report, dir)).toEqual([]);
	});

	it("re-anchors idempotently", () => {
		const once = reanchorReport(block("// src/huge.ts:1", REAL_LINE), dir).report;
		const twice = reanchorReport(once, dir).report;
		expect(twice).toBe(once);
		expect(reanchorReport(twice, dir).report).toBe(once);
	});

	it("leaves a citation entry for an over-cap file alone rather than calling it missing", () => {
		const r = verifyCitation({ file: "src/huge.ts", startLine: 1, endLine: 3 }, dir);
		expect(r.valid).toBe(true);
		expect(r.reason).toMatch(/not checked/);
		// And a genuinely absent file is still a failure, so `valid` has not become
		// meaningless.
		expect(verifyCitation({ file: "src/gone.ts", startLine: 1, endLine: 3 }, dir).valid).toBe(false);
	});
});
