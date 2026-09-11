import type { FastExplorerConfig } from "./config.js";

/**
 * Explorers are read-only by construction. `bash` is deliberately absent so an
 * explorer cannot mutate the repository regardless of its briefing.
 */
export const EXPLORER_TOOLS = "read,grep,find,ls";

export function buildExplorerArgs(
	cfg: FastExplorerConfig,
	model: string | null,
	promptPath: string,
	task: string,
): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	// Thinking is off even when the model is inherited: retrieval is not
	// reasoning, and per-turn latency is the dominant cost. See spec.
	args.push("--thinking", cfg.thinking);
	args.push("--tools", EXPLORER_TOOLS);
	args.push("--append-system-prompt", promptPath);
	args.push(`Task: ${task}`);
	return args;
}
