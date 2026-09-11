import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { NESTED_ENV_VAR } from "../src/explorer.js";
import {
	MAX_FILES_PER_BRIEF,
	type SweepContext,
	activeExplorerCount,
	buildSweepBrief,
	createSweepHandler,
	describeScope,
	isNestedExplorer,
	measureBytes,
	normalizeMatchPaths,
	shouldAutoPromote,
	withExplorerSlot,
} from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "fx-promote-"));

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
	delete process.env[NESTED_ENV_VAR];
});

describe("shouldAutoPromote", () => {
	const cfg = resolveConfig();

	it("promotes when the file count clears the threshold", () => {
		const files = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
		expect(shouldAutoPromote(files, 100, cfg)).toBe(true);
	});

	it("promotes a match-dense result that is below the file threshold", () => {
		expect(shouldAutoPromote(["a.ts", "b.ts", "c.ts", "d.ts"], 61, cfg)).toBe(true);
	});

	it("does not promote a small result", () => {
		expect(shouldAutoPromote(["a.ts", "b.ts"], 4, cfg)).toBe(false);
	});

	it("does not promote when disabled", () => {
		const off = resolveConfig({ autoPromote: { enabled: false } });
		const files = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`);
		expect(shouldAutoPromote(files, 500, off)).toBe(false);
	});

	it("requires the file threshold even when matches are high", () => {
		expect(shouldAutoPromote(["a.ts"], 5000, cfg)).toBe(false);
	});
});

describe("normalizeMatchPaths", () => {
	// The silent-closed bug. grep and find emit paths relative to their search
	// root; a scoped search left unnormalized stats nothing, scores zero bytes,
	// and never promotes — looking exactly like the feature being switched off.
	it("re-anchors a scoped search's paths on the session cwd", () => {
		expect(normalizeMatchPaths(["a.ts", "nested/b.ts"], "/repo", "src")).toEqual([
			"src/a.ts",
			"src/nested/b.ts",
		]);
	});

	it("leaves an unscoped search alone", () => {
		expect(normalizeMatchPaths(["src/a.ts"], "/repo", ".")).toEqual(["src/a.ts"]);
	});

	it("handles an absolute search path", () => {
		expect(normalizeMatchPaths(["a.ts"], "/repo", "/repo/lib")).toEqual(["lib/a.ts"]);
	});
});

describe("measureBytes", () => {
	const scoped = join(root, "scoped");
	mkdirSync(join(scoped, "src"), { recursive: true });
	writeFileSync(join(scoped, "src", "a.ts"), "x".repeat(4096));
	writeFileSync(join(scoped, "src", "b.ts"), "x".repeat(4096));

	it("sums the sizes of files it can stat", () => {
		expect(measureBytes(["src/a.ts", "src/b.ts"], scoped, 1_000_000)).toBe(8192);
	});

	// Regression for the scoped-search bug, stated as the two behaviours side by
	// side: raw grep output scores nothing, normalized output scores the truth.
	it("scores zero on raw scoped paths and the real total once normalized", () => {
		expect(measureBytes(["a.ts", "b.ts"], scoped, 1_000_000)).toBe(0);
		const fixed = normalizeMatchPaths(["a.ts", "b.ts"], scoped, "src");
		expect(measureBytes(fixed, scoped, 1_000_000)).toBe(8192);
	});

	it("stops early once the floor is cleared", () => {
		// Only the first file is needed to clear 1024, so the second is never
		// stat'd and cannot contribute. find returns up to 1000 paths by default
		// and these are synchronous stats on the host agent's event loop.
		expect(measureBytes(["src/a.ts", "src/b.ts"], scoped, 1024)).toBe(4096);
	});

	it("ignores unreadable entries rather than throwing", () => {
		expect(measureBytes(["does/not/exist.ts"], scoped, 1_000_000)).toBe(0);
	});
});

describe("describeScope", () => {
	it("is empty for an unscoped search", () => {
		expect(describeScope(".", undefined)).toBe("");
	});

	it("names the directory and the glob", () => {
		expect(describeScope("src", "*.ts")).toBe("under `src`, restricted to `*.ts`");
	});

	it("ignores a non-string glob", () => {
		expect(describeScope("src", 42)).toBe("under `src`");
	});
});

describe("buildSweepBrief", () => {
	it("leans on the pattern for grep, because a regex carries real intent", () => {
		const brief = buildSweepBrief("grep", "parseConfig", "under `src`", 20, ["src/a.ts"]);
		expect(brief).toContain("parseConfig");
		expect(brief).toContain("under `src`");
		expect(brief).toContain("- src/a.ts");
	});

	// A glob says only "these are .ts files". Phrasing find's brief like grep's
	// invites the explorer to invent a purpose that was never in the request.
	it("does not ask find's explorer to infer an intent from a glob", () => {
		const brief = buildSweepBrief("find", "**/*.test.ts", "", 30, ["a.test.ts"]);
		expect(brief).toContain("**/*.test.ts");
		expect(brief).toMatch(/carries no intent|do not guess/i);
	});

	it("lists every file when the bucket fits under the cap", () => {
		const bucket = ["a.ts", "b.ts", "c.ts"];
		const brief = buildSweepBrief("grep", "x", "", 3, bucket);
		for (const f of bucket) expect(brief).toContain(`- ${f}`);
		expect(brief).not.toMatch(/not listed/);
	});

	// A silently truncated list would have the explorer report on a sample while
	// believing it held the whole set — the failure "Not Covered" exists to stop.
	it("caps the list and says how many it withheld", () => {
		const bucket = Array.from({ length: MAX_FILES_PER_BRIEF + 15 }, (_, i) => `f${i}.ts`);
		const brief = buildSweepBrief("grep", "x", "", bucket.length, bucket);
		const listed = brief.split("\n").filter((l) => l.startsWith("- "));
		expect(listed).toHaveLength(MAX_FILES_PER_BRIEF);
		expect(brief).toContain("15 more not listed");
	});
});

describe("withExplorerSlot", () => {
	// The ceiling must hold ACROSS calls, not within one. A model can issue ten
	// greps in a single message; each result fires its own tool_result hook, so a
	// per-invocation limit would still put ten times the budget on the machine.
	it("caps concurrency across independent invocations", async () => {
		let peak = 0;
		const task = () =>
			withExplorerSlot(2, async () => {
				peak = Math.max(peak, activeExplorerCount());
				await new Promise((r) => setTimeout(r, 20));
			});

		// Six separate calls, as six separate hook invocations would make them.
		await Promise.all(Array.from({ length: 6 }, task));

		expect(peak).toBe(2);
		expect(activeExplorerCount()).toBe(0);
	});

	it("releases the slot when the task throws", async () => {
		await expect(
			withExplorerSlot(1, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(activeExplorerCount()).toBe(0);
	});
});

describe("isNestedExplorer", () => {
	it("is false in a normal session", () => {
		expect(isNestedExplorer({})).toBe(false);
	});

	it("is true once the marker is set", () => {
		expect(isNestedExplorer({ [NESTED_ENV_VAR]: "1" })).toBe(true);
	});

	it("reads the live process environment by default", () => {
		expect(isNestedExplorer()).toBe(false);
		process.env[NESTED_ENV_VAR] = "1";
		expect(isNestedExplorer()).toBe(true);
	});
});

function grepResult(text: string, input: Record<string, unknown> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "grep",
		toolCallId: "tc-1",
		input: { pattern: "parseConfig", ...input },
		content: [{ type: "text", text }],
		isError: false,
		details: undefined,
	};
}

/** A sweep wide enough and heavy enough to clear every promotion gate. */
const sweepDir = join(root, "sweep");
mkdirSync(sweepDir, { recursive: true });
const sweepFiles = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
for (const f of sweepFiles) writeFileSync(join(sweepDir, f), "x".repeat(8192));
const sweepOutput = sweepFiles.map((f, i) => `${f}:${i + 1}: parseConfig(x)`).join("\n");

const sweepCtx: SweepContext = { cwd: sweepDir, model: undefined, signal: undefined };

describe("createSweepHandler", () => {
	// timeoutMs is deliberately tiny: if a guard ever regresses and this suite
	// spawns real explorers, they are reaped immediately instead of billing.
	const handler = createSweepHandler(() => resolveConfig({ timeoutMs: 50 }));

	it("leaves a small result untouched", async () => {
		const out = "a.ts:1: parseConfig(x)\nb.ts:2: parseConfig(y)";
		expect(await handler(grepResult(out), sweepCtx)).toBeUndefined();
	});

	it("leaves other tools alone", async () => {
		const read: ToolResultEvent = {
			type: "tool_result",
			toolName: "read",
			toolCallId: "tc-2",
			input: { path: "a.ts" },
			content: [{ type: "text", text: sweepOutput }],
			isError: false,
			details: undefined,
		};
		expect(await handler(read, sweepCtx)).toBeUndefined();
	});

	it("leaves a failed search alone", async () => {
		const event = grepResult(sweepOutput);
		event.isError = true;
		expect(await handler(event, sweepCtx)).toBeUndefined();
	});

	it("leaves a wide but featherweight result alone", async () => {
		const empty = join(root, "empty");
		mkdirSync(empty, { recursive: true });
		for (const f of sweepFiles) writeFileSync(join(empty, f), "x");
		const ctx: SweepContext = { cwd: empty, model: undefined, signal: undefined };
		expect(await handler(grepResult(sweepOutput), ctx)).toBeUndefined();
	});

	// THE fork-bomb test. This input clears every promotion gate, so without the
	// nesting guard the handler would spawn explorers — and inside a real
	// explorer each of those would do the same, per grep, ten greps per turn.
	it("promotes nothing at all when running inside an explorer", async () => {
		// Same input is genuinely promotable: every other gate says yes.
		expect(shouldAutoPromote(sweepFiles, 20, resolveConfig())).toBe(true);
		expect(measureBytes(sweepFiles, sweepDir, 51200)).toBeGreaterThanOrEqual(51200);

		process.env[NESTED_ENV_VAR] = "1";
		expect(await handler(grepResult(sweepOutput), sweepCtx)).toBeUndefined();
		expect(activeExplorerCount()).toBe(0);
	});
});

/**
 * A stand-in for the `pi` binary the handler spawns.
 *
 * The handler resolves `pi` off PATH with `shell: false`, so a stub on PATH is
 * the only way to exercise the sweep end to end without a model call — and the
 * only way the negative test below means anything, since a test that can never
 * produce a promotion would pass with the handler deleted.
 *
 * The shebang names this process's own node rather than `env node`, so the stub
 * still runs when PATH has been narrowed to the stub directory.
 */
function piStub(name: string, message: Record<string, unknown>): string {
	const binDir = join(root, `bin-${name}`);
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(binDir, "pi"),
		`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ type: "message_end", message }))});\n`,
		{ mode: 0o755 },
	);
	return binDir;
}

const STUB_REPORT = "## Files Retrieved\n1. `f0.ts` (lines 1-1) - padding\n\n## Architecture\nPadding.";

/** What pi streams for a turn that finished normally. */
const reportingPi = piStub("ok", {
	role: "assistant",
	content: [{ type: "text", text: STUB_REPORT }],
	usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
	stopReason: "stop",
});

/**
 * The same successful turn, reported under a stopReason this extension does not
 * allow-list. This is the upstream rename in [2.1] of the audit, reproduced: pi
 * finishes the work, `runExplorer` calls it a failure, and every explorer in
 * every configuration is reported failed.
 */
const renamedStopReasonPi = piStub("renamed", {
	role: "assistant",
	content: [{ type: "text", text: STUB_REPORT }],
	usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
	stopReason: "end_turn",
});

/** Spill files this sweep would have written, by content rather than by name. */
function spillsHolding(text: string, since: readonly string[]): string[] {
	return readdirSync(tmpdir())
		.filter((f) => f.startsWith("fx-matches-") && !since.includes(f))
		.filter((f) => {
			try {
				return readFileSync(join(tmpdir(), f), "utf8") === text;
			} catch {
				return false;
			}
		});
}

function spillNames(): string[] {
	return readdirSync(tmpdir()).filter((f) => f.startsWith("fx-matches-"));
}

/**
 * What happens when exploration produces nothing.
 *
 * Auto-promotion REPLACES the model's tool result, and it used to do that
 * unconditionally — so a sweep whose explorers all failed handed the model
 * "Exploration produced no findings — every explorer failed" in place of a real
 * grep result, plus the path to a spill file it had to spend a turn reading back
 * to recover what it already had.
 *
 * That is bad on its own and much worse composed with the `stopReason`
 * allow-list: a pi release that renames `"stop"` does not degrade this
 * extension, it inverts it. Every promotable search in every session returns a
 * failure notice, after paying for four model calls, with the original output
 * destroyed.
 */
describe("createSweepHandler when every explorer fails", () => {
	const handler = createSweepHandler(() => resolveConfig({ timeoutMs: 10_000 }));
	const originalPath = process.env.PATH;

	afterEach(() => {
		process.env.PATH = originalPath;
	});

	it("promotes normally when an explorer does come back with findings", async () => {
		// The positive control. Everything below asserts that promotion does NOT
		// happen; this is what proves the fixture can make it happen at all.
		process.env.PATH = `${reportingPi}${delimiter}${originalPath ?? ""}`;
		const result = await handler(grepResult(sweepOutput), sweepCtx);

		expect(result).toBeDefined();
		const text = result?.content?.[0]?.text ?? "";
		expect(text).toContain("# Explorer:");
		// Text only this stub writes, so the assertion cannot be satisfied by a real
		// `pi` that happens to be installed on the machine running the suite.
		expect(text).toContain("## Architecture\nPadding.");
		expect(text).toContain("Raw grep output (20 files) saved to:");
		// The cost of the subprocesses is still reported: a feature that spawns
		// model calls must not hide them from session totals.
		expect(result?.usage?.cost?.total).toBeGreaterThan(0);
		expect(activeExplorerCount()).toBe(0);
	});

	it("leaves the original result untouched when pi cannot be spawned", async () => {
		// PATH with nothing on it: `spawn("pi")` fails ENOENT, every explorer comes
		// back `ok: false`, and there is nothing to promote. Returning undefined is
		// what leaves pi's own tool result in place — a handler result, even an
		// identical-looking one, would replace it.
		const before = spillNames();
		process.env.PATH = join(root, "bin-empty");
		mkdirSync(process.env.PATH, { recursive: true });

		expect(await handler(grepResult(sweepOutput), sweepCtx)).toBeUndefined();
		expect(activeExplorerCount()).toBe(0);
		// And no spill file was left behind for a promotion that never happened.
		expect(spillsHolding(sweepOutput, before)).toEqual([]);
	});

	it("survives a stopReason rename with the search result intact", async () => {
		// The composed failure, as a regression test. The explorers here SUCCEED —
		// same report, same usage — and are reported failed only because the
		// stopReason string changed. Before the fallback this returned a failure
		// notice in place of the grep output; now the search result survives an
		// upstream vocabulary change untouched.
		const before = spillNames();
		process.env.PATH = `${renamedStopReasonPi}${delimiter}${originalPath ?? ""}`;

		expect(await handler(grepResult(sweepOutput), sweepCtx)).toBeUndefined();
		expect(activeExplorerCount()).toBe(0);
		expect(spillsHolding(sweepOutput, before)).toEqual([]);
	});
});
