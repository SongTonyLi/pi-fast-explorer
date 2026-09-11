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
});
