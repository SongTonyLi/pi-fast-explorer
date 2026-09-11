import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		const brief = buildSweepBrief(true, "parseConfig", "under `src`", 20, ["src/a.ts"]);
		expect(brief).toContain("parseConfig");
		expect(brief).toContain("under `src`");
		expect(brief).toContain("- src/a.ts");
	});

	// A glob says only "these are .ts files". Phrasing find's brief like grep's
	// invites the explorer to invent a purpose that was never in the request.
	it("does not ask find's explorer to infer an intent from a glob", () => {
		const brief = buildSweepBrief(false, "**/*.test.ts", "", 30, ["a.test.ts"]);
		expect(brief).toContain("**/*.test.ts");
		expect(brief).toMatch(/carries no intent|do not guess/i);
	});

	it("lists every file when the bucket fits under the cap", () => {
		const bucket = ["a.ts", "b.ts", "c.ts"];
		const brief = buildSweepBrief(true, "x", "", 3, bucket);
		for (const f of bucket) expect(brief).toContain(`- ${f}`);
		expect(brief).not.toMatch(/not listed/);
	});

	// A silently truncated list would have the explorer report on a sample while
	// believing it held the whole set — the failure "Not Covered" exists to stop.
	it("caps the list and says how many it withheld", () => {
		const bucket = Array.from({ length: MAX_FILES_PER_BRIEF + 15 }, (_, i) => `f${i}.ts`);
		const brief = buildSweepBrief(true, "x", "", bucket.length, bucket);
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
