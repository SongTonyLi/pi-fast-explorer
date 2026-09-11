import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
	MIN_RESOLVED_FRACTION,
	looksLikeSearchOutput,
	resolvedFraction,
	verifyMatchedLines,
} from "../src/detect.js";
import { NESTED_ENV_VAR } from "../src/explorer.js";
import {
	MAX_INTENT_CHARS,
	type SweepContext,
	buildSweepBrief,
	createSweepHandler,
	forgetPromotedOutputs,
	summarizeIntent,
} from "../src/index.js";
import { parseGrepMatches } from "../src/parse.js";

const root = mkdtempSync(join(tmpdir(), "fx-bash-"));

/**
 * A repository big enough to clear every promotion gate: 20 files, each a few
 * kilobytes, each with a known marker on line 3 so search output can be forged
 * exactly as `grep -n` would really have printed it.
 */
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });

const FILE_COUNT = 20;
const MARKER_LINE = 3;

function marker(i: number): string {
	return `export const TOKEN_${i} = "tool_use_id";`;
}

for (let i = 0; i < FILE_COUNT; i++) {
	const padding = Array.from({ length: 60 }, (_, n) => `// padding line ${n} ${"x".repeat(40)}`);
	writeFileSync(join(repo, `f${i}.ts`), [`// f${i}.ts`, "", marker(i), ...padding].join("\n"));
}

/** `grep -n` / `rg` / `git grep -n`: no space after the line number. */
const bareGrepOutput = Array.from(
	{ length: FILE_COUNT },
	(_, i) => `f${i}.ts:${MARKER_LINE}:${marker(i)}`,
).join("\n");

/** pi's own grep shape, which a model can also produce via `bash` (`rg` with a space). */
const spacedGrepOutput = Array.from(
	{ length: FILE_COUNT },
	(_, i) => `f${i}.ts:${MARKER_LINE}: ${marker(i)}`,
).join("\n");

/**
 * A stub `pi` on PATH. The promotion path spawns `pi` by name, so this is the
 * only way to exercise it without spending real model calls — and exercising it
 * is the whole point: the bug being fixed was a hook that never reached its
 * gates, which gate-level tests alone cannot catch.
 */
const binDir = join(root, "bin");
mkdirSync(binDir, { recursive: true });
const stubReport = {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "STUB_REPORT_MARKER" }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		stopReason: "stop",
	},
};
writeFileSync(join(binDir, "pi"), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(stubReport)}'\n`, {
	mode: 0o755,
});

const originalPath = process.env.PATH;

beforeAll(() => {
	process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

afterAll(() => {
	process.env.PATH = originalPath;
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	forgetPromotedOutputs();
});

afterEach(() => {
	delete process.env[NESTED_ENV_VAR];
});

function bashResult(text: string, command = 'grep -RIn -- "tool_use_id" .'): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "tc-bash",
		input: { command },
		content: [{ type: "text", text }],
		isError: false,
		details: undefined,
	};
}

const ctx: SweepContext = { cwd: repo, model: undefined, signal: undefined };
const handler = createSweepHandler(() => resolveConfig({ timeoutMs: 10000 }));

async function promotedText(event: ToolResultEvent): Promise<string | undefined> {
	const result = await handler(event, ctx);
	if (!result) return undefined;
	const [first] = result.content;
	return first && first.type === "text" ? first.text : undefined;
}

describe("bash promotion", () => {
	// The gap this whole change exists to close. Asked explicitly to use the grep
	// tool, a real pi session with its default toolbelt ran
	// `bash: grep -RIn -- "tool_use_id" src/` instead and the hook never fired.
	it("promotes a shell search the model ran instead of the grep tool", async () => {
		const text = await promotedText(bashResult(bareGrepOutput));
		expect(text).toContain("STUB_REPORT_MARKER");
		expect(text).toContain("# Explorer:");
	});

	it("calls the spilled output a command's, not a grep's", async () => {
		const text = await promotedText(bashResult(bareGrepOutput));
		expect(text).toContain("Raw command output (20 files) saved to:");
	});

	it("promotes the spaced form too, so an `rg` alias is not a second gap", async () => {
		expect(await promotedText(bashResult(spacedGrepOutput))).toContain("STUB_REPORT_MARKER");
	});

	// Reading back the spill file is something we actively invite: every promotion
	// ends with "Raw command output saved to: …". With bash on the toolbelt the
	// model reads it with `cat`, and that output is a perfect promotion candidate.
	it("refuses to promote the same output twice, so reading the spill back works", async () => {
		expect(await promotedText(bashResult(bareGrepOutput))).toContain("STUB_REPORT_MARKER");
		// What `cat <spill>` returns: the spilled text verbatim, plus whatever
		// trailing newline the file ended on.
		const catOutput = bashResult(`${bareGrepOutput}\n`, "cat /tmp/fx-matches-….txt");
		expect(await handler(catOutput, ctx)).toBeUndefined();
	});

	it("leaves bash alone when autoPromote.bash is off but grep still promotes", async () => {
		const off = createSweepHandler(() => resolveConfig({ autoPromote: { bash: false } }));
		expect(await off(bashResult(bareGrepOutput), ctx)).toBeUndefined();
	});

	it("leaves a failed command alone", async () => {
		const event = bashResult(bareGrepOutput);
		event.isError = true;
		expect(await handler(event, ctx)).toBeUndefined();
	});

	it("promotes nothing at all when running inside an explorer", async () => {
		process.env[NESTED_ENV_VAR] = "1";
		expect(await handler(bashResult(bareGrepOutput), ctx)).toBeUndefined();
	});

	it("leaves output that is not a search alone", async () => {
		expect(await handler(bashResult("total 8\ndrwxr-xr-x 4 songli staff 128 Sep 11 bin"), ctx)).toBeUndefined();
	});
});

/**
 * Every fixture below is the real output of the named tool, captured on this
 * machine and rewritten only to point at the fixture repository — which is the
 * hostile version, because it gives each one genuinely resolvable paths.
 */
describe("bash output that is not a search", () => {
	function rejects(text: string) {
		return Promise.all([
			expect(handler(bashResult(text), ctx)).resolves.toBeUndefined(),
			expect(looksLikeSearchOutput(parseGrepMatches(text), repo)).toBe(false),
		]);
	}

	// `tsc` writes `file(line,col): error TS…`, which never parses as a match at
	// all. Recorded so a future relaxation of the parser has to face it.
	it("does not promote tsc diagnostics", async () => {
		const out = Array.from(
			{ length: FILE_COUNT },
			(_, i) => `f${i}.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.`,
		).join("\n");
		expect(parseGrepMatches(out)).toHaveLength(0);
		await rejects(out);
	});

	// clang and gcc write `path:line:col: severity: message`. The strict parser
	// takes `path:line` as the path, so the paths do not resolve — no vocabulary
	// of severity words is needed to tell a diagnostic from a match.
	it("does not promote clang diagnostics", async () => {
		const out = Array.from(
			{ length: FILE_COUNT },
			(_, i) =>
				`f${i}.ts:${MARKER_LINE}:14: error: incompatible pointer to integer conversion [-Wint-conversion]`,
		).join("\n");
		expect(resolvedFraction(parseGrepMatches(out).map((m) => m.file), repo)).toBe(0);
		await rejects(out);
	});

	it("does not promote eslint's unix formatter", async () => {
		const out = Array.from(
			{ length: FILE_COUNT },
			(_, i) => `f${i}.ts:${MARKER_LINE}:14: Missing semicolon [Error/semi]`,
		).join("\n");
		await rejects(out);
	});

	// The one that path resolution cannot catch, and the reason the second gate
	// exists. mypy's default format has no column, so it parses to a real file at
	// a real line — it just does not carry that line's text.
	it("does not promote mypy diagnostics, which resolve perfectly", async () => {
		const out = Array.from(
			{ length: FILE_COUNT },
			(_, i) => `f${i}.ts:${MARKER_LINE}: error: Incompatible types in assignment  [assignment]`,
		).join("\n");
		const matches = parseGrepMatches(out);
		expect(matches).toHaveLength(FILE_COUNT);
		expect(resolvedFraction(matches.map((m) => m.file), repo)).toBe(1);
		expect(verifyMatchedLines(matches, repo).verified).toBe(0);
		await rejects(out);
	});

	it("does not promote a node stack trace", async () => {
		const frames = Array.from(
			{ length: FILE_COUNT },
			(_, i) => `    at fn${i} (${join(repo, `f${i}.ts`)}:${MARKER_LINE}:21)`,
		);
		await rejects(["Error: boom", ...frames].join("\n"));
	});

	it("does not promote a python traceback", async () => {
		const frames = Array.from({ length: FILE_COUNT }, (_, i) => [
			`  File "${join(repo, `f${i}.ts`)}", line ${MARKER_LINE}, in fn${i}`,
			"    a()",
		]).flat();
		await rejects(["Traceback (most recent call last):", ...frames, "ValueError: boom"].join("\n"));
	});

	it("does not promote a vitest failure report", async () => {
		const blocks = Array.from({ length: FILE_COUNT }, (_, i) => [
			` FAIL  f${i}.ts > a`,
			"AssertionError: expected 1 to be 2 // Object.is equality",
			` ❯ f${i}.ts:${MARKER_LINE}:27`,
			`      3| ${marker(i)}`,
			"       |                           ^",
		]).flat();
		await rejects(blocks.join("\n"));
	});
});

describe("the resolution gate", () => {
	/** 18 real rows plus 4 invented ones: enough real bytes to clear the floor. */
	const polluted = [
		...Array.from({ length: 18 }, (_, i) => `f${i}.ts:${MARKER_LINE}:${marker(i)}`),
		...Array.from({ length: 4 }, (_, i) => `ghost${i}.ts:${MARKER_LINE}:${marker(i)}`),
	].join("\n");

	const clean = Array.from(
		{ length: 18 },
		(_, i) => `f${i}.ts:${MARKER_LINE}:${marker(i)}`,
	).join("\n");

	// The pair matters more than either half. The same 18 rows promote on their
	// own, so the rejection below is the resolution fraction doing the work and
	// not the breadth or byte floor quietly failing first.
	it("promotes the clean 18 rows", async () => {
		expect(await promotedText(bashResult(clean))).toContain("STUB_REPORT_MARKER");
	});

	it("rejects the same 18 rows once 4 unresolvable ones are mixed in", async () => {
		expect(resolvedFraction(parseGrepMatches(polluted).map((m) => m.file), repo)).toBeLessThan(
			MIN_RESOLVED_FRACTION,
		);
		expect(await handler(bashResult(polluted), ctx)).toBeUndefined();
	});

	// One stale path in the smallest promotable sweep must not cost a promotion:
	// the bash tool truncates long output mid-line, and the surviving head of the
	// first row parses to a stump.
	it("tolerates a single unresolvable path in a 20-row sweep", async () => {
		const truncated = bareGrepOutput.replace(/^f0\.ts/, ".ts");
		expect(await promotedText(bashResult(truncated))).toContain("STUB_REPORT_MARKER");
	});
});

describe("verifyMatchedLines", () => {
	it("verifies real search output line for line", () => {
		const tally = verifyMatchedLines(parseGrepMatches(bareGrepOutput), repo);
		expect(tally.attempted).toBe(10);
		expect(tally.verified).toBe(10);
	});

	it("spreads its sample across files rather than exhausting the first", () => {
		const dense = Array.from({ length: FILE_COUNT }, (_, i) =>
			[`f${i}.ts:${MARKER_LINE}:${marker(i)}`, `f${i}.ts:1:// f${i}.ts`].join("\n"),
		).join("\n");
		expect(verifyMatchedLines(parseGrepMatches(dense), repo).verified).toBe(10);
	});

	it("does not count a file it cannot read as a failed sample", () => {
		const ghosts = Array.from({ length: FILE_COUNT }, (_, i) => `ghost${i}.ts:1:x`).join("\n");
		expect(verifyMatchedLines(parseGrepMatches(ghosts), repo)).toEqual({
			attempted: 0,
			verified: 0,
		});
	});

	it("refuses a sample too small to mean anything", () => {
		expect(looksLikeSearchOutput(parseGrepMatches(`f0.ts:${MARKER_LINE}:${marker(0)}`), repo)).toBe(
			false,
		);
	});
});

describe("the bash brief", () => {
	const brief = buildSweepBrief(
		"bash",
		'grep -RIn -- "tool_use_id" src/',
		"",
		20,
		["src/a.ts", "src/b.ts"],
	);

	it("hands the explorer the command as the statement of intent", () => {
		expect(brief).toContain('grep -RIn -- "tool_use_id" src/');
		expect(brief).toContain("- src/a.ts");
		expect(brief).toContain("matched 20 files");
	});

	// Explorers have no bash. A brief that reads like an instruction to run the
	// command would spend a turn discovering that.
	it("tells the explorer not to run it", () => {
		expect(brief).toMatch(/do not run it/i);
	});

	it("does not phrase a command like a grep pattern", () => {
		expect(brief).not.toContain("for the pattern");
	});
});

describe("summarizeIntent", () => {
	it("flattens a multi-line command onto one line", () => {
		expect(summarizeIntent("grep -rn foo \\\n  src/")).toBe("grep -rn foo \\ src/");
	});

	it("caps a command long enough to crowd out the brief", () => {
		const long = `grep -rn ${"x".repeat(400)} src/`;
		const capped = summarizeIntent(long);
		expect(capped).toHaveLength(MAX_INTENT_CHARS + 1);
		expect(capped.endsWith("…")).toBe(true);
	});
});
