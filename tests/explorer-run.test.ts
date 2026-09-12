import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { runExplorer } from "../src/explorer.js";

const dir = mkdtempSync(join(tmpdir(), "fx-"));

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function stub(name: string, body: string): string {
	const p = join(dir, name);
	writeFileSync(p, body, { mode: 0o755 });
	return p;
}

/**
 * Source text for a stub that builds one assistant `message_end` line, the
 * shape pi streams on stdout.
 */
function msgLine(text: string): string {
	return `JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(text)} }], usage: { input: 1, output: 1, cost: { total: 0.001 } }, stopReason: "stop" } })`;
}

const okStub = stub(
	"ok.mjs",
	`const msg = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Files Retrieved\\n1. a.ts (lines 1-5) - x" }], usage: { input: 1, output: 1, cost: { total: 0.001 } }, stopReason: "stop" } };
console.log(JSON.stringify(msg));`,
);

const hangStub = stub("hang.mjs", `setTimeout(() => {}, 60000);`);
const failStub = stub("fail.mjs", `console.error("bad things"); process.exit(3);`);

// Ignores SIGTERM. Only a real SIGKILL escalation can reap this one, so it is
// the stub that catches a `proc.killed` guard (signal-sent, not process-death).
const stubbornStub = stub(
	"stubborn.mjs",
	`process.on("SIGTERM", () => {});
setTimeout(() => {}, 60000);`,
);

// Exits on SIGTERM, announcing that it got there. Proves we actually signal
// rather than relying on the SIGKILL escalation to do all the work.
const sigtermStub = stub(
	"sigterm.mjs",
	`process.on("SIGTERM", () => {
	process.stdout.write(${msgLine("SIGTERM_RECEIVED")} + "\\n", () => process.exit(0));
});
setTimeout(() => {}, 60000);`,
);

// Splits a UTF-8 sequence across two stdout writes. Decoding each chunk in
// isolation corrupts the character into U+FFFD.
const splitUtf8Stub = stub(
	"split-utf8.mjs",
	`const msg = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "h\\u00e9llo \\u65e5\\u672c\\u8a9e" }], usage: { input: 1, output: 1, cost: { total: 0.001 } }, stopReason: "stop" } };
const buf = Buffer.from(JSON.stringify(msg) + "\\n", "utf8");
const k = buf.findIndex((b) => b >= 0x80) + 1; // lands inside a multi-byte sequence
process.stdout.write(buf.subarray(0, k));
setTimeout(() => process.stdout.write(buf.subarray(k)), 50);`,
);

const noisyStderrStub = stub(
	"noisy.mjs",
	`process.stderr.write("A".repeat(50000) + "\\nTAIL_MARKER", () => process.exit(3));`,
);

// The model hit its output cap: exit 0, non-empty but truncated report.
const lengthStub = stub(
	"length.mjs",
	`const msg = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "1. a.ts - partial findings, cut off mid-" }], usage: { input: 1, output: 1, cost: { total: 0.001 } }, stopReason: "length" } };
process.stdout.write(JSON.stringify(msg) + "\\n", () => process.exit(0));`,
);

const errorStopStub = stub(
	"error-stop.mjs",
	`const msg = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "boom" } };
process.stdout.write(JSON.stringify(msg) + "\\n", () => process.exit(0));`,
);

const emptyStub = stub("empty.mjs", `process.exit(0);`);

// No trailing newline: the report only survives if the final buffer is flushed.
const noNewlineStub = stub(
	"no-newline.mjs",
	`process.stdout.write(${msgLine("report without a trailing newline")}, () => process.exit(0));`,
);

// Two reports, spaced out, so progress is observed more than once.
const twoPassStub = stub(
	"two-pass.mjs",
	`process.stdout.write(${msgLine("first pass")} + "\\n");
setTimeout(() => process.stdout.write(${msgLine("second pass")} + "\\n", () => process.exit(0)), 60);`,
);

// Reports back whatever the nesting marker was set to in its environment, plus
// an inherited variable, so the test can tell "env was replaced" apart from
// "env was extended".
const envStub = stub(
	"env.mjs",
	`const text = "NESTED=" + (process.env.PI_FAST_EXPLORER_NESTED ?? "unset") + " PATH=" + (process.env.PATH ? "inherited" : "missing");
const msg = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, cost: { total: 0.001 } }, stopReason: "stop" } };
process.stdout.write(JSON.stringify(msg) + "\\n", () => process.exit(0));`,
);

const grandchildStub = stub("grandchild.mjs", `setTimeout(() => {}, 3000);`);

// Exits cleanly, but leaves a grandchild holding the inherited stdio pipes, so
// the write end never closes and 'close' never fires.
const leakyStub = stub(
	"leaky.mjs",
	`import { spawn } from "node:child_process";
const gc = spawn(process.execPath, [${JSON.stringify(grandchildStub)}], { stdio: ["ignore", "inherit", "inherit"] });
gc.unref();
process.stdout.write(${msgLine("report from parent")} + "\\n", () => process.exit(0));`,
);

describe("runExplorer", () => {
	it("returns the final report on success", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [okStub],
			brief: "find a",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(true);
		expect(r.report).toContain("Files Retrieved");
		expect(r.usage.turns).toBe(1);
	});

	it("reports failure with stderr on non-zero exit", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [failStub],
			brief: "find b",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("bad things");
	});

	it("times out and reports failure", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [hangStub],
			brief: "find c",
			cfg: resolveConfig({ timeoutMs: 300 }),
			cwd: dir,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/timed out/i);
	});

	it("aborts when the signal fires", async () => {
		const ac = new AbortController();
		const p = runExplorer({
			command: process.execPath,
			args: [hangStub],
			brief: "find d",
			cfg: resolveConfig(),
			cwd: dir,
			signal: ac.signal,
		});
		setTimeout(() => ac.abort(), 100);
		const r = await p;
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/abort/i);
	});

	// Regression: `proc.killed` is true the moment a signal is *sent*, so a
	// `if (!proc.killed)` guard never escalates and a child that ignores
	// SIGTERM leaves this promise pending forever.
	it(
		"escalates to SIGKILL and still settles when the child ignores SIGTERM",
		async () => {
			const r = await runExplorer({
				command: process.execPath,
				args: [stubbornStub],
				brief: "find e",
				cfg: resolveConfig({ timeoutMs: 300 }),
				cwd: dir,
				sigkillGraceMs: 200,
			});
			expect(r.ok).toBe(false);
			expect(r.error).toMatch(/timed out/i);
		},
		5000,
	);

	// Guards the SIGTERM itself: a kill() that sent no signal at all would
	// otherwise stay green, covered for by the SIGKILL escalation.
	it("sends SIGTERM first, well before the SIGKILL escalation", async () => {
		const started = Date.now();
		const r = await runExplorer({
			command: process.execPath,
			args: [sigtermStub],
			brief: "find i",
			cfg: resolveConfig({ timeoutMs: 300 }),
			cwd: dir,
			sigkillGraceMs: 4000,
		});
		const elapsed = Date.now() - started;
		expect(r.report).toContain("SIGTERM_RECEIVED");
		expect(r.error).toMatch(/timed out/i);
		expect(elapsed).toBeLessThan(2000);
	});

	it("does not spawn at all when the signal is already aborted", async () => {
		const r = await runExplorer({
			command: "/nonexistent/definitely-not-a-real-binary",
			args: [],
			brief: "find f",
			cfg: resolveConfig(),
			cwd: dir,
			signal: AbortSignal.abort(),
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/abort/i);
		// A spawn attempt would have surfaced a spawn error instead.
		expect(r.error).not.toMatch(/spawn/i);
	});

	it("preserves multi-byte characters split across chunk boundaries", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [splitUtf8Stub],
			brief: "find g",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(true);
		expect(r.report).toBe("héllo 日本語");
		expect(r.report).not.toContain("�");
	});

	it("keeps only the tail of a chatty child's stderr", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [noisyStderrStub],
			brief: "find h",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(false);
		// The tail is what matters: that is where the actual error lands.
		expect(r.error).toContain("TAIL_MARKER");
		expect(r.error!.length).toBeLessThan(9000);
	});

	// A truncated report exits 0 with non-empty text. Treating that as success
	// files a half-finished sweep under findings instead of "Not Covered".
	it("reports failure when the model hits its output cap", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [lengthStub],
			brief: "find j",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/length/);
		// The partial text is still handed back, just not as a success.
		expect(r.report).toContain("partial findings");
	});

	it("reports failure when the explorer stops with an error", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [errorStopStub],
			brief: "find k",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("boom");
	});

	it("reports failure when the explorer exits cleanly with no report", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [emptyStub],
			brief: "find l",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/no report/i);
	});

	// The likeliest field failure: pi is not on PATH.
	it("reports a spawn failure when the command is missing", async () => {
		const r = await runExplorer({
			command: join(dir, "definitely-not-installed-pi"),
			args: [],
			brief: "find m",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/failed to spawn/i);
	});

	it("reads a final report that has no trailing newline", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [noNewlineStub],
			brief: "find n",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(true);
		expect(r.report).toBe("report without a trailing newline");
	});

	// Regression: 'close' needs stdio EOF as well as process exit, so a
	// grandchild holding the pipes leaves this pending forever.
	it("settles even when a grandchild holds the stdio pipes open", async () => {
		const started = Date.now();
		const r = await runExplorer({
			command: process.execPath,
			args: [leakyStub],
			brief: "find o",
			cfg: resolveConfig(),
			cwd: dir,
		});
		const elapsed = Date.now() - started;
		expect(r.ok).toBe(true);
		expect(r.report).toContain("report from parent");
		// Settled off the drain timer, not by outwaiting the 3s grandchild.
		expect(elapsed).toBeLessThan(2500);
	});

	// Second fork-bomb layer. `--no-extensions` stops pi discovering us inside an
	// explorer, but a wrapper can load us explicitly with `-e`, bypassing
	// discovery. The hook reads this marker and refuses to promote under it.
	it("marks the child environment as nested, without clobbering the rest of env", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [envStub],
			brief: "find r",
			cfg: resolveConfig(),
			cwd: dir,
		});
		expect(r.ok).toBe(true);
		expect(r.report).toBe("NESTED=1 PATH=inherited");
	});

	it("reports live tool calls on each activity callback", async () => {
		const toolStub = stub(
			"tools.mjs",
			`console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "x", path: "src" } }], usage: { input: 1, output: 1, cost: { total: 0.001 } } } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cost: { total: 0.001 } }, stopReason: "stop" } }));`,
		);
		const seen: string[][] = [];
		const { extractDisplayItems } = await import("../src/explorer.js");
		const r = await runExplorer({
			command: process.execPath,
			args: [toolStub],
			brief: "find tools",
			cfg: resolveConfig(),
			cwd: dir,
			onActivity: (acc) => seen.push(extractDisplayItems(acc).map((i) => (i.type === "toolCall" ? i.name : "text"))),
		});
		expect(r.ok).toBe(true);
		expect(seen.some((names) => names.includes("grep"))).toBe(true);
		expect(seen.at(-1)).toContain("text");
	});

	it("reports the whole accumulated report on each progress callback", async () => {
		const seen: string[] = [];
		const r = await runExplorer({
			command: process.execPath,
			args: [twoPassStub],
			brief: "find p",
			cfg: resolveConfig(),
			cwd: dir,
			onProgress: (report) => seen.push(report),
		});
		expect(r.ok).toBe(true);
		expect(seen.length).toBeGreaterThanOrEqual(2);
		// Replace semantics: every call carries the full report, not a delta.
		expect(seen[0]).toBe("first pass");
		expect(seen.at(-1)).toBe("second pass");
		expect(r.report).toBe(seen.at(-1));
	});

	// onProgress runs inside a 'data' handler, where a throw would become an
	// uncaught exception and take down the host agent.
	it("survives an onActivity callback that throws", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [okStub],
			brief: "find q",
			cfg: resolveConfig(),
			cwd: dir,
			onActivity: () => {
				throw new Error("consumer blew up");
			},
		});
		expect(r.ok).toBe(true);
		expect(r.report).toContain("Files Retrieved");
	});

	it("survives an onProgress callback that throws", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [okStub],
			brief: "find q",
			cfg: resolveConfig(),
			cwd: dir,
			onProgress: () => {
				throw new Error("consumer blew up");
			},
		});
		expect(r.ok).toBe(true);
		expect(r.report).toContain("Files Retrieved");
	});
});

/** Source text for one `message_update` line carrying an assistant text event. */
function updLine(ev: Record<string, unknown>): string {
	return `JSON.stringify({ type: "message_update", assistantMessageEvent: ${JSON.stringify(ev)} })`;
}

// Streams a report one line at a time, slower than the idle window in the
// tests below but well under their hard cap, then finishes cleanly.
const slowStreamStub = stub(
	"slow-stream.mjs",
	`process.stdout.write(${updLine({ type: "text_start", contentIndex: 0 })} + "\\n");
let i = 0;
const t = setInterval(() => {
	process.stdout.write(${updLine({ type: "text_delta", contentIndex: 0, delta: "## Files Retrieved\\n" })} + "\\n");
	if (++i === 20) {
		clearInterval(t);
		process.stdout.write(${updLine({ type: "text_end", contentIndex: 0 })} + "\\n" + ${msgLine("## Files Retrieved\n1. a.ts (lines 1-2) - done")} + "\\n", () => process.exit(0));
	}
}, 60);`,
);

// Says one thing and then goes quiet forever: a stalled provider call.
const stallStub = stub(
	"stall.mjs",
	`process.stdout.write(${msgLine("thinking")} + "\\n");
setTimeout(() => {}, 60000);`,
);

// Never stops streaming. Only the hard cap can end this one.
const foreverStub = stub(
	"forever.mjs",
	`process.stdout.write(${updLine({ type: "text_start", contentIndex: 0 })} + "\\n");
setInterval(() => process.stdout.write(${updLine({ type: "text_delta", contentIndex: 0, delta: "x" })} + "\\n"), 50);`,
);

// Two completed tool turns, then a report that is still being written when
// the deadline hits — the shape measured in the field: seven tool turns in
// 43 s, then a 123 s report turn killed by a 120 s cap.
const partialStub = stub(
	"partial.mjs",
	`const toolTurn = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "x" } }], usage: { input: 1, output: 1, cost: { total: 0.001 } }, stopReason: "toolUse" } });
process.stdout.write(toolTurn + "\\n" + toolTurn + "\\n");
process.stdout.write(${updLine({ type: "text_start", contentIndex: 0 })} + "\\n");
process.stdout.write(${updLine({ type: "text_delta", contentIndex: 0, delta: "## Files Retrieved\n1. `a.ts` (lines 1-3) - partial\n\n" })} + "\\n");
process.stdout.write(${updLine({ type: "text_delta", contentIndex: 0, delta: "## Key Code\n" })} + "\\n");
setTimeout(() => {}, 60000);`,
);

// Mid-sentence narration, no report sections, then a hang.
const narrationStub = stub(
	"narration.mjs",
	`process.stdout.write(${updLine({ type: "text_start", contentIndex: 0 })} + "\\n");
process.stdout.write(${updLine({ type: "text_delta", contentIndex: 0, delta: "Let me look at a few more files before" })} + "\\n");
setTimeout(() => {}, 60000);`,
);

describe("runExplorer deadlines", () => {
	// The field failure: a healthy explorer streaming its report was killed by a
	// wall-clock cap set below the time its report takes to generate. Activity
	// is the right signal — pi streams a delta for every token — so the idle
	// window must reset on output.
	it("keeps a slowly streaming explorer alive past the idle window", async () => {
		const started = Date.now();
		const r = await runExplorer({
			command: process.execPath,
			args: [slowStreamStub],
			brief: "find s",
			cfg: resolveConfig({ idleTimeoutMs: 300, timeoutMs: 10000 }),
			cwd: dir,
		});
		expect(r.ok).toBe(true);
		expect(r.report).toContain("done");
		expect(r.partial).toBeFalsy();
		expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
	});

	it("kills an explorer that goes silent, long before the hard cap", async () => {
		const started = Date.now();
		const r = await runExplorer({
			command: process.execPath,
			args: [stallStub],
			brief: "find t",
			cfg: resolveConfig({ idleTimeoutMs: 300, timeoutMs: 60000 }),
			cwd: dir,
			sigkillGraceMs: 200,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/stalled/i);
		expect(r.error).toMatch(/no output for 0\.3s/);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("enforces the hard cap on an explorer that never stops streaming", async () => {
		const started = Date.now();
		const r = await runExplorer({
			command: process.execPath,
			args: [foreverStub],
			brief: "find u",
			cfg: resolveConfig({ idleTimeoutMs: 5000, timeoutMs: 400 }),
			cwd: dir,
			sigkillGraceMs: 200,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/timed out after 0\.4s/);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("salvages the report the explorer was writing when the hard cap hit", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [partialStub],
			brief: "find v",
			cfg: resolveConfig({ timeoutMs: 500 }),
			cwd: dir,
			sigkillGraceMs: 200,
		});
		expect(r.ok).toBe(false);
		expect(r.partial).toBe(true);
		expect(r.report).toContain("## Files Retrieved");
		expect(r.report).toContain("partial");
		expect(r.error).toMatch(/while writing its report/);
		expect(r.error).toMatch(/turn 3/);
		expect(r.error).toMatch(/partial report salvaged/);
	});

	it("salvages the partial report on abort too", async () => {
		const ac = new AbortController();
		const p = runExplorer({
			command: process.execPath,
			args: [partialStub],
			brief: "find w",
			cfg: resolveConfig(),
			cwd: dir,
			signal: ac.signal,
			sigkillGraceMs: 200,
		});
		setTimeout(() => ac.abort(), 300);
		const r = await p;
		expect(r.ok).toBe(false);
		expect(r.partial).toBe(true);
		expect(r.report).toContain("## Files Retrieved");
		expect(r.error).toMatch(/abort/i);
		expect(r.error).toMatch(/partial report salvaged/);
	});

	// Salvage is for reports. Streamed narration carries no section and would
	// reach the main agent as findings that say nothing.
	it("does not salvage streamed narration that is not a report", async () => {
		const r = await runExplorer({
			command: process.execPath,
			args: [narrationStub],
			brief: "find x",
			cfg: resolveConfig({ timeoutMs: 400 }),
			cwd: dir,
			sigkillGraceMs: 200,
		});
		expect(r.ok).toBe(false);
		expect(r.partial).toBeFalsy();
		expect(r.report).toBe("");
		expect(r.error).toMatch(/no report written/);
	});
});
