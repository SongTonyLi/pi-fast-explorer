import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { buildExplorerArgs } from "../src/explorer.js";

describe("buildExplorerArgs", () => {
	it("builds a read-only, thinking-off invocation pinned to the session's provider", () => {
		const args = buildExplorerArgs(
			resolveConfig(),
			{ id: "claude-opus-5", provider: "anthropic" },
			"/tmp/p.md",
			"find auth",
		);
		expect(args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--provider",
			"anthropic",
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

	// A model id alone is ambiguous when two providers serve the same id —
	// `deepseek/deepseek-v4.1-flash` is offered by openrouter and by deepseek
	// directly. Inheriting the session's model must mean inheriting its provider,
	// or an explorer can silently bill a different account than the session.
	it("passes --provider when the inherited model carries one", () => {
		const args = buildExplorerArgs(
			resolveConfig(),
			{ id: "deepseek/deepseek-v4.1-flash", provider: "openrouter" },
			"/tmp/p.md",
			"t",
		);
		expect(args[args.indexOf("--provider") + 1]).toBe("openrouter");
		expect(args[args.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4.1-flash");
	});

	// A configured `model` is a string the user wrote; they can put `provider/id`
	// in it themselves, and pi resolves that form. Inventing a provider here would
	// override what they asked for.
	it("omits --provider for a configured model string", () => {
		const args = buildExplorerArgs(resolveConfig(), { id: "openai/gpt-5.6" }, "/tmp/p.md", "t");
		expect(args).not.toContain("--provider");
		expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-5.6");
	});

	// The budget is advisory and always was: pi has no turn-limit flag, so this
	// sentence is the entire mechanism. It is worded as a target rather than a cap
	// because a 5-turn "hard cap" was measured being exceeded anyway — and an
	// explorer that reads the number as a wall stops mid-brief and reports half an
	// answer. Do not restore "Complete this in at most N turns".
	it("carries the configured budget as a target rather than a hard cap", () => {
		const args = buildExplorerArgs(
			resolveConfig({ maxTurnsPerExplorer: 3 }),
			{ id: "m" },
			"/tmp/p.md",
			"t",
		);
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
		const args = buildExplorerArgs(resolveConfig(), { id: "m" }, "/tmp/p.md", "t");
		expect(args).toContain("--no-extensions");
	});

	// Retrieval needs no skills and no prompt templates, and every one the user
	// has installed is otherwise paid for in every explorer's system prompt.
	// Context files (AGENTS.md) are deliberately still loaded: repository
	// conventions help an explorer read the tree.
	it("disables skills and prompt templates but not context files", () => {
		const args = buildExplorerArgs(resolveConfig(), { id: "m" }, "/tmp/p.md", "t");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-prompt-templates");
		expect(args).not.toContain("--no-context-files");
	});

	it("never grants bash", () => {
		const args = buildExplorerArgs(resolveConfig(), { id: "m" }, "/tmp/p.md", "t");
		const tools = args[args.indexOf("--tools") + 1];
		expect(tools).not.toContain("bash");
	});

	it("honors a configured thinking level", () => {
		const cfg = resolveConfig({ thinking: "low" });
		const args = buildExplorerArgs(cfg, { id: "m" }, "/tmp/p.md", "t");
		expect(args[args.indexOf("--thinking") + 1]).toBe("low");
	});

	it("omits --model and --provider when no model is resolved", () => {
		const args = buildExplorerArgs(resolveConfig(), null, "/tmp/p.md", "t");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--provider");
	});
});
