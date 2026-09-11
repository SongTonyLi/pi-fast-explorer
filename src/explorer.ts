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

export interface ExplorerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface StreamMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
	stopReason?: string;
	errorMessage?: string;
}

export interface Accumulator {
	messages: StreamMessage[];
	usage: ExplorerUsage;
	stopReason?: string;
	errorMessage?: string;
}

export function createAccumulator(): Accumulator {
	return {
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

export function processLine(line: string, acc: Accumulator): void {
	if (!line.trim()) return;

	let event: { type?: string; message?: StreamMessage };
	try {
		event = JSON.parse(line);
	} catch {
		// Partial or non-JSON lines are expected on a streaming pipe. Drop them.
		return;
	}

	if (event.type !== "message_end" || !event.message) return;
	const msg = event.message;
	acc.messages.push(msg);

	if (msg.role !== "assistant") return;
	acc.usage.turns++;
	const u = msg.usage;
	if (u) {
		acc.usage.input += u.input ?? 0;
		acc.usage.output += u.output ?? 0;
		acc.usage.cacheRead += u.cacheRead ?? 0;
		acc.usage.cacheWrite += u.cacheWrite ?? 0;
		acc.usage.cost += u.cost?.total ?? 0;
	}
	if (msg.stopReason) acc.stopReason = msg.stopReason;
	if (msg.errorMessage) acc.errorMessage = msg.errorMessage;
}

export function extractFinalText(acc: Accumulator): string {
	for (let i = acc.messages.length - 1; i >= 0; i--) {
		const msg = acc.messages[i]!;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}
