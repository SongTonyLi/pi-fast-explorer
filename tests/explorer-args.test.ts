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
			"--no-extensions",
			"--model",
			"claude-opus-5",
			"--thinking",
			"off",
			"--tools",
			"read,grep,find,ls",
			"--append-system-prompt",
			"/tmp/p.md",
			"Task: find auth\n\nTurn budget: about 8 turns. Aim to come in well under it — but a " +
				"complete report matters more than the budget, so take an extra turn if the brief " +
				"genuinely needs one.",
		]);
	});

	// The budget is advisory and always was: pi has no turn-limit flag, so this
	// sentence is the entire mechanism. It is worded as a target rather than a cap
	// because a 5-turn "hard cap" was measured being exceeded anyway — and an
	// explorer that reads the number as a wall stops mid-brief and reports half an
	// answer. Do not restore "Complete this in at most N turns".
	it("carries the configured budget as a target rather than a hard cap", () => {
		const args = buildExplorerArgs(resolveConfig({ maxTurnsPerExplorer: 3 }), "m", "/tmp/p.md", "t");
		const task = args.at(-1) ?? "";
		expect(task.startsWith("Task: t\n\n")).toBe(true);
		expect(task).toContain("about 3 turns");
		expect(task).not.toMatch(/at most/);
	});

	// DO NOT DELETE AS REDUNDANT WITH THE toEqual PIN ABOVE. This flag is the
	// fork-bomb guard, and it is asserted separately so that a future rewrite of
	// the argv pin cannot drop it silently.
	//
	// Verified against pi 0.85.1: neither `-p` nor `--no-session` stops extension
	// discovery in a subprocess (core/resource-loader.js gates only on the
	// `--no-extensions` flag). Without this, an explorer loads this very
	// extension, its own greps trip auto-promotion, and each spawns another wave
	// of explorers. The explorer prompt asks for ten searches per turn, so the
	// branching is per-grep: ~40 processes at depth 1, ~1600 at depth 2.
	it("passes --no-extensions so an explorer cannot re-enter this extension", () => {
		const args = buildExplorerArgs(resolveConfig(), "m", "/tmp/p.md", "t");
		expect(args).toContain("--no-extensions");
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
