import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { buildExplorerArgs } from "../src/explorer.js";

describe("buildExplorerArgs", () => {
	it("builds a read-only, thinking-off invocation", () => {
		const args = buildExplorerArgs(resolveConfig(), "claude-opus-5", "/tmp/p.md", "find auth");
		expect(args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"claude-opus-5",
			"--thinking",
			"off",
			"--tools",
			"read,grep,find,ls",
			"--append-system-prompt",
			"/tmp/p.md",
			"Task: find auth",
		]);
	});

	it("never grants bash", () => {
		const args = buildExplorerArgs(resolveConfig(), "m", "/tmp/p.md", "t");
		const tools = args[args.indexOf("--tools") + 1];
		expect(tools).not.toContain("bash");
	});

	it("honors a configured thinking level", () => {
		const cfg = resolveConfig({ thinking: "low" });
		const args = buildExplorerArgs(cfg, "m", "/tmp/p.md", "t");
		expect(args[args.indexOf("--thinking") + 1]).toBe("low");
	});

	it("omits --model when no model is resolved", () => {
		const args = buildExplorerArgs(resolveConfig(), null, "/tmp/p.md", "t");
		expect(args).not.toContain("--model");
	});
});
