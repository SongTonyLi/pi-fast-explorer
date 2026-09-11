import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { FastExplorerConfig } from "./config.js";

/**
 * Explorers are read-only by construction. `bash` is deliberately absent so an
 * explorer cannot mutate the repository regardless of its briefing.
 */
export const EXPLORER_TOOLS = "read,grep,find,ls";

/**
 * Set in every explorer subprocess. The auto-promotion hook in index.ts refuses
 * to run when it sees this.
 *
 * This is the second of two layers against a fork bomb. An explorer's only real
 * tools are grep and find, and the explorer prompt tells it to issue ten
 * searches per turn. If the auto-promotion hook were live inside an explorer,
 * every one of those searches would spawn a fresh wave of explorers, each of
 * which would do the same: a branching factor of roughly maxFanout per grep, not
 * per turn. Layer one is `--no-extensions`; this layer covers the case that flag
 * cannot, namely a wrapper that loads us through an explicit `-e path`, where
 * discovery never happens and `--no-extensions` is therefore not consulted.
 */
export const NESTED_ENV_VAR = "PI_FAST_EXPLORER_NESTED";

export function buildExplorerArgs(
	cfg: FastExplorerConfig,
	model: string | null,
	promptPath: string,
	task: string,
): string[] {
	// `--no-extensions` is load-bearing, not tidiness. Verified against pi 0.85.1:
	// print mode and `--no-session` do NOT stop extension discovery, so without
	// this flag an explorer loads *this* extension and its grep results promote
	// into yet more explorers. Explicit `-e` paths still load, and we pass none.
	// It is also correct on its own terms: an explorer running arbitrary user
	// extensions is neither read-only nor reproducible.
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (model) args.push("--model", model);
	// Thinking is off even when the model is inherited: retrieval is not
	// reasoning, and per-turn latency is the dominant cost. See spec.
	args.push("--thinking", cfg.thinking);
	args.push("--tools", EXPLORER_TOOLS);
	args.push("--append-system-prompt", promptPath);
	// pi has no turn-limit flag, so the budget rides along in the task text and is
	// phrased as what it actually is: a target, not a rule. Wording it as a hard
	// cap bought nothing — the model exceeded it anyway — while inviting an
	// explorer that reaches the number to stop mid-brief and report half an
	// answer. A truncated report is a worse outcome than one extra turn.
	args.push(
		`Task: ${task}\n\nTurn budget: about ${cfg.maxTurnsPerExplorer} turns. Aim to come in ` +
			`well under it — but a complete report matters more than the budget, so take an ` +
			`extra turn if the brief genuinely needs one.`,
	);
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

export interface StreamContentPart {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	args?: Record<string, unknown>;
}

interface StreamMessage {
	role?: string;
	content?: StreamContentPart[];
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

export interface PendingTool {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface Accumulator {
	messages: StreamMessage[];
	usage: ExplorerUsage;
	stopReason?: string;
	errorMessage?: string;
	pendingTools: PendingTool[];
}

export function createAccumulator(): Accumulator {
	return {
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		pendingTools: [],
	};
}

interface StreamEvent {
	type?: string;
	message?: StreamMessage;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
}

function toolArgs(part: StreamContentPart): Record<string, unknown> {
	if (part.arguments && typeof part.arguments === "object") return part.arguments;
	if (part.args && typeof part.args === "object") return part.args;
	return {};
}

function itemsFromMessages(messages: StreamMessage[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
				items.push({ type: "text", text: part.text });
			} else if (part.type === "toolCall" && typeof part.name === "string" && part.name) {
				items.push({ type: "toolCall", name: part.name, args: toolArgs(part) });
			}
		}
	}
	return items;
}

function lastAssistantHasToolCalls(messages: StreamMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		return msg.content.some((part) => part.type === "toolCall" && part.name);
	}
	return false;
}

/**
 * Tool calls and text the explorer has produced so far, in stream order.
 *
 * `tool_execution_start` can land before the assistant `message_end` that
 * records the same calls. Those pending executions are appended only when the
 * latest assistant message does not already list them, so the inspector does
 * not show each grep twice.
 */
export function extractDisplayItems(acc: Accumulator): DisplayItem[] {
	const items = itemsFromMessages(acc.messages);
	if (!lastAssistantHasToolCalls(acc.messages)) {
		for (const tool of acc.pendingTools) {
			items.push({ type: "toolCall", name: tool.name, args: tool.args });
		}
	}
	return items;
}

export function processLine(line: string, acc: Accumulator): void {
	if (!line.trim()) return;

	let event: StreamEvent;
	try {
		event = JSON.parse(line);
	} catch {
		// Partial or non-JSON lines are expected on a streaming pipe. Drop them.
		return;
	}

	if (event.type === "tool_execution_start" && event.toolName) {
		acc.pendingTools.push({
			id: typeof event.toolCallId === "string" ? event.toolCallId : `${event.toolName}-${acc.pendingTools.length}`,
			name: event.toolName,
			args: event.args && typeof event.args === "object" ? event.args : {},
		});
		return;
	}

	if (event.type === "tool_execution_end" && event.toolCallId) {
		acc.pendingTools = acc.pendingTools.filter((tool) => tool.id !== event.toolCallId);
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
	/**
	 * Called with the entire report accumulated so far, re-emitted on every
	 * chunk. Replace what you are holding; do not append, or the report will
	 * duplicate itself.
	 */
	onProgress?: (report: string) => void;
	/**
	 * Called with the live accumulator after every parsed event. Used to surface
	 * tool calls in the TUI; the report text still goes through `onProgress`.
	 */
	onActivity?: (acc: Accumulator) => void;
	/** Overridable so tests need not wait out the production grace period. */
	sigkillGraceMs?: number;
}

const SIGKILL_GRACE_MS = 5000;

/**
 * `close` needs stdio EOF as well as process exit, and a grandchild that
 * inherited the pipes keeps the write end open after the explorer itself is
 * gone. After `exit` we allow this long for a clean drain, then finalize
 * regardless. This timer is never unref'd: it is the last guarantee that the
 * promise settles at all.
 */
const DRAIN_MS = 1000;

/** Errors and stack traces land at the end of a stream, so we keep the tail. */
const STDERR_TAIL_CHARS = 8192;

/**
 * Memory guard against a child that streams without ever emitting a newline.
 * A partial line this large is already unparseable, so bounding growth costs
 * nothing that was not lost anyway.
 */
const STDOUT_BUFFER_CHARS = 1_048_576;

export function runExplorer(opts: RunExplorerOptions): Promise<ExplorerResult> {
	const {
		command,
		args,
		brief,
		cfg,
		cwd,
		signal,
		onProgress,
		onActivity,
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
		let spawned = false;
		let failure: string | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;

		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// Inherited by the whole subtree, so the guard holds at any depth.
			env: { ...process.env, [NESTED_ENV_VAR]: "1" },
		});
		proc.on("spawn", () => {
			spawned = true;
		});

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
			if (drainTimer) clearTimeout(drainTimer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const emitProgress = () => {
			if (onProgress) {
				try {
					onProgress(extractFinalText(acc));
				} catch {
					// A throwing consumer would otherwise become an uncaught
					// exception in a 'data' handler and take down the host agent.
				}
			}
			if (onActivity) {
				try {
					onActivity(acc);
				} catch {
					// Same isolation as onProgress: the host session must survive.
				}
			}
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
			if (buffer.length > STDOUT_BUFFER_CHARS) buffer = buffer.slice(-STDOUT_BUFFER_CHARS);
			for (const line of lines) processLine(line, acc);
			emitProgress();
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			appendStderr(stderrDecoder.write(chunk));
		});

		// A pipe error is fatal to the host in exactly the same way. Windows in
		// particular surfaces ECONNRESET here when a child is killed. Exit code,
		// stopReason and an empty report remain the authoritative failure signals.
		proc.stdout.on("error", () => {});
		proc.stderr.on("error", () => {});

		proc.on("error", (err) => {
			if (!spawned) {
				finish({
					brief,
					report: "",
					ok: false,
					error: `Failed to spawn explorer: ${err.message}`,
					usage: acc.usage,
				});
				return;
			}
			// Post-spawn, 'error' also covers a failed kill. Settling here would
			// clear the grace timer and abandon a child that is still alive, so
			// record it and let exit/close decide.
			failure ??= `Explorer process error: ${err.message}`;
		});

		const finalize = (code: number | null, termSignal: NodeJS.Signals | null) => {
			if (settled) return;
			buffer += stdoutDecoder.end();
			appendStderr(stderrDecoder.end());
			if (buffer.trim()) processLine(buffer, acc);
			emitProgress();
			const report = extractFinalText(acc);
			const exited = termSignal ? `signal ${termSignal}` : `code ${code}`;
			const error =
				failure ??
				(code !== 0 || termSignal
					? `Explorer exited with ${exited}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
					: // Allow-list of one. pi's full stopReason vocabulary is seven
						// values, and the source is a TRANSITIVE dependency this package
						// does not declare, so nothing here type-checks against it:
						//
						//   node_modules/@earendil-works/pi-coding-agent/node_modules/
						//     @earendil-works/pi-ai/dist/types.d.ts:287   (pi-ai 0.85.1)
						//   "pending" | "stop" | "length" | "toolUse" | "error"
						//     | "aborted" | "deferred"
						//
						// Read that line before trusting this list: two other sources
						// disagree with it and with each other — pi's own
						// docs/session-format.md:88 omits `pending` and `deferred`, and an
						// earlier version of this comment omitted `toolUse` and `error`.
						// The six non-`stop` values all mean the brief was not fully
						// covered, so failing on them is right.
						//
						// What is NOT right is how much rides on the literal string
						// "stop". A rename upstream — to `end_turn`, the name the provider
						// APIs use — reports every explorer in every configuration as
						// failed, with the money already spent. `StreamMessage` is
						// hand-redeclared here, so TypeScript cannot catch that. The
						// containment for it is downstream, in `createSweepHandler`: a
						// sweep where every explorer "failed" returns the original search
						// result untouched instead of replacing it with a failure notice.
						acc.stopReason && acc.stopReason !== "stop"
						? `Explorer stopped with reason "${acc.stopReason}"${
								acc.errorMessage ? `: ${acc.errorMessage}` : ""
							}`
						: !report
							? "Explorer produced no report"
							: undefined);

			finish({ brief, report, ok: !error, error, usage: acc.usage });
		};

		// Fast path: process exited and stdio reached EOF.
		proc.on("close", (code, termSignal) => finalize(code, termSignal));

		// Backstop: the process exited but something else still holds the pipes.
		proc.on("exit", (code, termSignal) => {
			drainTimer = setTimeout(() => finalize(code, termSignal), DRAIN_MS);
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
