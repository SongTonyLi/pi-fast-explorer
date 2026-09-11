import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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

export interface ExplorerResult {
	brief: string;
	report: string;
	ok: boolean;
	error?: string;
	usage: ExplorerUsage;
}

export interface RunExplorerOptions {
	command: string;
	args: string[];
	brief: string;
	cfg: FastExplorerConfig;
	cwd: string;
	signal?: AbortSignal;
	onUpdate?: (partial: string) => void;
	/** Overridable so tests need not wait out the production grace period. */
	sigkillGraceMs?: number;
}

const SIGKILL_GRACE_MS = 5000;

/** Errors and stack traces land at the end of a stream, so we keep the tail. */
const STDERR_TAIL_CHARS = 8192;

export function runExplorer(opts: RunExplorerOptions): Promise<ExplorerResult> {
	const {
		command,
		args,
		brief,
		cfg,
		cwd,
		signal,
		onUpdate,
		sigkillGraceMs = SIGKILL_GRACE_MS,
	} = opts;

	return new Promise<ExplorerResult>((resolve) => {
		const acc = createAccumulator();

		// Already aborted: spawning a process only to kill it is pure cost.
		if (signal?.aborted) {
			resolve({ brief, report: "", ok: false, error: "Explorer aborted", usage: acc.usage });
			return;
		}

		// Decoders span chunk boundaries; a UTF-8 sequence can straddle one and
		// decoding each chunk in isolation would corrupt it into U+FFFD.
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let stderr = "";
		let buffer = "";
		let settled = false;
		let failure: string | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;

		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		const kill = () => {
			proc.kill("SIGTERM");
			graceTimer = setTimeout(() => {
				// `proc.killed` only records that a signal was *sent*, so it is
				// already true here and could never gate the escalation. Liveness
				// is the real question: has the child actually exited yet?
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}, sigkillGraceMs);
			// The child's own stdio handles hold the loop open until it dies, so
			// unref costs no kill guarantee and avoids pinning the loop ourselves.
			graceTimer.unref();
		};

		const timer = setTimeout(() => {
			failure = `Explorer timed out after ${cfg.timeoutMs}ms`;
			kill();
		}, cfg.timeoutMs);

		const onAbort = () => {
			failure = "Explorer aborted";
			kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const finish = (result: ExplorerResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const appendStderr = (text: string) => {
			if (!text) return;
			stderr += text;
			if (stderr.length > STDERR_TAIL_CHARS) stderr = stderr.slice(-STDERR_TAIL_CHARS);
		};

		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += stdoutDecoder.write(chunk);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line, acc);
			if (onUpdate) onUpdate(extractFinalText(acc));
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			appendStderr(stderrDecoder.write(chunk));
		});

		proc.on("error", (err) => {
			finish({
				brief,
				report: "",
				ok: false,
				error: `Failed to spawn explorer: ${err.message}`,
				usage: acc.usage,
			});
		});

		proc.on("close", (code) => {
			buffer += stdoutDecoder.end();
			appendStderr(stderrDecoder.end());
			if (buffer.trim()) processLine(buffer, acc);
			const report = extractFinalText(acc);
			const error =
				failure ??
				(code !== 0
					? `Explorer exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
					: acc.stopReason === "error"
						? (acc.errorMessage ?? "Explorer reported an error")
						: !report
							? "Explorer produced no report"
							: undefined);

			finish({ brief, report, ok: !error, error, usage: acc.usage });
		});
	});
}

/**
 * Runs tasks with a bounded number in flight, preserving input order in the
 * returned array. maxFanout is validated to never exceed the limit, so in
 * practice this runs a single wave.
 */
export async function runWithConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	limit: number,
): Promise<T[]> {
	const results = new Array<T>(tasks.length);
	let next = 0;

	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= tasks.length) return;
			results[index] = await tasks[index]!();
		}
	};

	const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
	await Promise.all(workers);
	return results;
}
