import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { runExplorer } from "../src/explorer.js";

const dir = mkdtempSync(join(tmpdir(), "fx-"));

function stub(name: string, body: string): string {
	const p = join(dir, name);
	writeFileSync(p, body, { mode: 0o755 });
	return p;
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
});
