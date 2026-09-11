import { randomUUID } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ToolResultEvent,
	getAgentDir,
	isFindToolResult,
	isGrepToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type FastExplorerConfig, type PartialConfig, loadConfigFrom, resolveConfig } from "./config.js";
import {
	type ExplorerResult,
	NESTED_ENV_VAR,
	buildExplorerArgs,
	runExplorer,
	runWithConcurrency,
} from "./explorer.js";
import { parseFindOutput, parseGrepOutput } from "./parse.js";
import { bucketByDirectory, computeFanout, shouldExplore } from "./partition.js";
import { synthesize } from "./synthesis.js";

export interface ExploreInput {
	question: string;
	questions?: string[];
	scope?: string;
	fanout?: number;
}

/** Structured payload attached to every tool result, partial and final alike. */
export interface ExploreDetails {
	briefs: string[];
	results: ExplorerResult[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, "..", "prompts", "explorer.md");

/** Basename of both the user-level and project-level config files. */
export const CONFIG_FILE_NAME = "fast-explorer.json";

/**
 * Caller-supplied `questions` remove a blocking planner round-trip from the
 * critical path: the main agent is already reasoning when it calls explore, so
 * it can decompose in the turn it already occupies.
 */
export function buildBriefs(input: ExploreInput, maxFanout: number): string[] {
	const supplied = (input.questions ?? []).map((q) => q.trim()).filter((q) => q.length > 0);
	if (supplied.length > 0) return supplied.slice(0, maxFanout);
	return [input.question];
}

/** A match-dense result still needs several files before partitioning helps. */
const MIN_FILES_FOR_MATCH_TRIGGER = 3;

/**
 * Promote on breadth (many files) or on density (many matches across at least a
 * few files). A single file with thousands of matches is a narrow search, not a
 * sweep, so it is never promoted.
 *
 * This function owns the whole "is this a sweep" question. `shouldExplore` then
 * answers only "is there enough content to be worth it". Keep those separate:
 * when both applied a file-count floor, the density branch could never survive
 * the second gate.
 */
export function shouldAutoPromote(
	files: string[],
	matchCount: number,
	cfg: FastExplorerConfig,
): boolean {
	if (!cfg.autoPromote.enabled) return false;
	if (files.length >= cfg.autoPromote.minFiles) return true;
	return matchCount >= cfg.autoPromote.minMatches && files.length >= MIN_FILES_FOR_MATCH_TRIGGER;
}

/**
 * Upper bound on file paths inlined into a single explorer brief. A find sweep
 * returns up to 1000 paths by default; pasting 250 of them into a prompt
 * recreates inside the subprocess exactly the context bloat this feature exists
 * to remove. The explorer is told how many were withheld so it reports on a
 * sample knowingly rather than mistaking its slice for the whole set.
 */
export const MAX_FILES_PER_BRIEF = 40;

/**
 * Process-wide ceiling on explorers running at once, shared by every caller.
 *
 * This MUST be global rather than per-invocation. A model can issue ten greps in
 * one message; each result fires its own `tool_result` hook, and a limit applied
 * inside a single hook call would still allow ten hooks x concurrency explorers
 * to land on the machine simultaneously. `cfg.concurrency` is the budget for the
 * extension as a whole, not for one grep.
 */
let running = 0;
const waiting: Array<() => void> = [];

function acquireSlot(limit: number): Promise<void> {
	if (running < limit) {
		running++;
		return Promise.resolve();
	}
	// Resolved by releaseSlot, which hands over its slot without decrementing,
	// so `running` already accounts for this holder when the await returns.
	return new Promise<void>((unblock) => waiting.push(unblock));
}

function releaseSlot(): void {
	const next = waiting.shift();
	// Hand the slot straight to the next waiter. Decrementing first would let a
	// fresh acquireSlot observe the gap and take it, over-subscribing by one.
	if (next) next();
	else running--;
}

/**
 * Runs `fn` holding one of the process-wide explorer slots. Both the explore
 * tool and auto-promotion go through here, so the two paths share one budget
 * rather than each assuming it owns the whole machine.
 */
export async function withExplorerSlot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
	await acquireSlot(limit);
	try {
		return await fn();
	} finally {
		releaseSlot();
	}
}

/** Exposed for tests: how many explorers currently hold a slot. */
export function activeExplorerCount(): number {
	return running;
}

/**
 * True when this process is itself an explorer we spawned.
 *
 * Fork-bomb guard, layer two. See NESTED_ENV_VAR. Layer one is
 * `--no-extensions`, which stops pi discovering this extension inside an
 * explorer; this layer covers a wrapper that loads us through an explicit
 * `-e path`, where discovery never runs and the flag is never consulted.
 */
export function isNestedExplorer(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env[NESTED_ENV_VAR]);
}

/**
 * grep and find both emit paths relative to their own search root, not to the
 * session cwd (core/tools/grep.js formatPath, core/tools/find.js
 * relativizeFindResultPath). Re-anchoring them on cwd is not cosmetic: for a
 * scoped search such as `path: "src"`, leaving them alone makes every statSync
 * throw, the byte total stay at zero, and auto-promotion silently never fire —
 * a failure indistinguishable from the feature simply being switched off. It
 * would also hand explorers paths they cannot open.
 */
export function normalizeMatchPaths(files: string[], cwd: string, searchDir: string): string[] {
	const searchRoot = resolve(cwd, searchDir);
	return files.map((f) => relative(cwd, resolve(searchRoot, f)) || f);
}

/**
 * Sums file sizes, stopping as soon as `minTotalBytes` is cleared.
 *
 * The early exit is the point. find returns up to 1000 paths by default and
 * these are synchronous stats on the host agent's event loop; the exact total is
 * never used for anything once the floor is passed. Unreadable entries simply do
 * not contribute.
 */
export function measureBytes(files: string[], cwd: string, minTotalBytes: number): number {
	let totalBytes = 0;
	for (const f of files) {
		if (totalBytes >= minTotalBytes) break;
		try {
			totalBytes += statSync(resolve(cwd, f)).size;
		} catch {
			// A path we cannot stat contributes nothing to the budget.
		}
	}
	return totalBytes;
}

/** Renders the search's scope so the explorer knows what was and was not swept. */
export function describeScope(searchDir: string, glob: unknown): string {
	const parts: string[] = [];
	if (searchDir && searchDir !== ".") parts.push(`under \`${searchDir}\``);
	if (typeof glob === "string" && glob) parts.push(`restricted to \`${glob}\``);
	return parts.join(", ");
}

/**
 * Briefs are phrased per tool because the two inputs carry very different
 * amounts of intent. A grep pattern is a real signal — someone was looking for
 * that specific thing — so the brief leans on it. A find glob says only "these
 * are .ts files", so leaning on it invites the explorer to invent a purpose that
 * was never there; that brief asks what the files *are* instead.
 *
 * The file list is capped, and the cap is disclosed. An explorer handed a silent
 * truncation would report on a sample while believing it had the whole set,
 * which is the same failure mode the "Not Covered" contract exists to prevent.
 */
export function buildSweepBrief(
	isGrep: boolean,
	pattern: string,
	scope: string,
	totalFiles: number,
	bucket: string[],
): string {
	const shown = bucket.slice(0, MAX_FILES_PER_BRIEF);
	const omitted = bucket.length - shown.length;
	const where = scope ? ` ${scope}` : "";

	const header = isGrep
		? `The main agent searched this repository for the pattern \`${pattern}\`${where} ` +
			`and matched ${totalFiles} files. Investigate what that pattern is doing across ` +
			`your share of them: what each site is for, how they relate, and what someone ` +
			`would need to know before changing it.`
		: `The main agent listed files matching the glob \`${pattern}\`${where} and got ` +
			`${totalFiles} paths. A glob carries no intent, so do not guess at one — report ` +
			`what these files are and what they do, grouped by what they have in common.`;

	const listHeader =
		omitted > 0
			? `Your files (${shown.length} of ${bucket.length} assigned to you; ${omitted} more not listed — say so if that limits your answer):`
			: `Your files (${shown.length}):`;

	return `${header}\n\n${listHeader}\n${shown.map((f) => `- ${f}`).join("\n")}`;
}

/**
 * Usage must match pi's Usage shape exactly so session totals include explorer
 * work. Only `cost.total` is available per explorer, so the per-category cost
 * fields stay at zero.
 */
function aggregateUsage(results: ExplorerResult[]) {
	return results.reduce(
		(a, r) => ({
			input: a.input + r.usage.input,
			output: a.output + r.usage.output,
			cacheRead: a.cacheRead + r.usage.cacheRead,
			cacheWrite: a.cacheWrite + r.usage.cacheWrite,
			totalTokens: a.totalTokens + r.usage.input + r.usage.output,
			cost: { ...a.cost, total: a.cost.total + r.usage.cost },
		}),
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	);
}

/**
 * The slice of pi's ExtensionContext that auto-promotion actually uses.
 *
 * Declared structurally rather than importing ExtensionContext so the handler
 * can be exercised in tests with a three-field object. ExtensionContext is
 * assignable to this, so `pi.on` still accepts the handler unchanged.
 */
export interface SweepContext {
	cwd: string;
	model: { id: string } | undefined;
	/** Undefined when the agent is not streaming. Threaded so Esc cancels explorers. */
	signal: AbortSignal | undefined;
}

/**
 * Builds the `tool_result` handler that turns an oversized grep or find into
 * cited findings.
 *
 * Takes a config *getter* rather than a config, because the extension reloads
 * its config on every session_start and a captured snapshot would go stale.
 *
 * The return type is left to inference: pi does not re-export
 * ToolResultEventResult from its root entry point, and restating it here would
 * be a copy that could drift. The `pi.on("tool_result", ...)` call site below is
 * the real conformance check.
 */
export function createSweepHandler(getConfig: () => FastExplorerConfig) {
	return async (event: ToolResultEvent, ctx: SweepContext) => {
		// Fork-bomb guard, layer two. Must be the very first check: everything
		// below this line spawns processes. An explorer's own greps must never
		// promote, or each one spawns a fresh wave that does the same.
		if (isNestedExplorer()) return undefined;

		// `event.toolName === "grep"` cannot narrow the union, because
		// CustomToolResultEvent declares `toolName: string` and so overlaps every
		// string literal. pi ships these guards for exactly that reason.
		const grep = isGrepToolResult(event);
		if (!grep && !isFindToolResult(event)) return undefined;
		if (event.isError) return undefined;

		const cfg = getConfig();
		const text = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		const parsed = grep ? parseGrepOutput(text) : { files: parseFindOutput(text), matchCount: 0 };
		if (!shouldAutoPromote(parsed.files, parsed.matchCount, cfg)) return undefined;

		const searchDir = typeof event.input.path === "string" ? event.input.path : ".";
		const files = normalizeMatchPaths(parsed.files, ctx.cwd, searchDir);
		if (!shouldExplore(measureBytes(files, ctx.cwd, cfg.minTotalBytes), cfg).explore) {
			return undefined;
		}

		// randomUUID, not toolCallId: Gemini synthesizes tool call ids as
		// `${name}_${Date.now()}_${counter}` with a per-response counter, so two
		// concurrent sessions can collide in a shared tmpdir — and a
		// provider-controlled string does not belong in a path unsanitized. 0600
		// because on Linux tmpdir() is a world-traversable /tmp and this file is
		// verbatim source text.
		const spillPath = join(tmpdir(), `fx-matches-${randomUUID()}.txt`);
		let spilled = true;
		try {
			writeFileSync(spillPath, text, { encoding: "utf8", mode: 0o600 });
		} catch {
			// Best-effort. Exploration proceeds, but we must not then point the model
			// at a file that is not there: that costs it a wasted turn.
			spilled = false;
		}

		const buckets = bucketByDirectory(files, computeFanout(files.length, cfg.maxFanout));
		const model = cfg.model ?? ctx.model?.id ?? null;
		const scope = describeScope(searchDir, event.input.glob);
		const pattern = typeof event.input.pattern === "string" ? event.input.pattern : "";

		const tasks = buckets.map((bucket) => () =>
			withExplorerSlot(cfg.concurrency, () =>
				runExplorer({
					command: "pi",
					args: buildExplorerArgs(
						cfg,
						model,
						PROMPT_PATH,
						buildSweepBrief(grep, pattern, scope, files.length, bucket),
					),
					brief: `${bucket.length} files under ${dirname(bucket[0] ?? ".")}`,
					cfg,
					cwd: ctx.cwd,
					signal: ctx.signal,
				}),
			),
		);

		const results = await runWithConcurrency(tasks, cfg.concurrency);

		const spillNote = spilled
			? `Raw ${grep ? "grep" : "find"} output (${files.length} files) saved to: ${spillPath}`
			: `${files.length} files matched. Raw output could not be saved to disk.`;

		return {
			content: [{ type: "text" as const, text: `${synthesize(results)}\n\n---\n\n${spillNote}` }],
			// This REPLACES the tool's usage rather than adding to it
			// (core/agent-session.js: `usage: hookResult?.usage`). Safe only because
			// grep and find report no usage of their own. Reporting it is not
			// optional: a feature that silently spawns LLM subprocesses must not
			// hide their cost from session totals.
			usage: aggregateUsage(results),
		};
	};
}

export default function (pi: ExtensionAPI, userConfig?: PartialConfig) {
	// Mutable because config is reloaded on every session_start. `execute` reads
	// this binding at call time, so a reload takes effect without re-registering.
	let cfg = resolveConfig(userConfig);

	// pi's loader calls the factory with only `pi`, so `userConfig` is populated
	// exclusively by a wrapper extension. Disk is the path real users have.
	pi.on("session_start", (_event, ctx) => {
		const { config, error } = loadConfigFrom(
			join(getAgentDir(), CONFIG_FILE_NAME),
			join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
			ctx.isProjectTrusted(),
			userConfig,
			cfg,
		);
		cfg = config;
		if (error) {
			ctx.ui.notify(`fast-explorer: ignoring invalid config — ${error}`, "warning");
		}
	});

	pi.registerTool({
		name: "explore",
		label: "Explore",
		description:
			"Investigate code spanning many files using parallel read-only explorers. " +
			"Returns cited findings (file:line) instead of raw file contents. " +
			"Supply `questions` with 2-4 sub-questions when you can decompose the problem — " +
			"it removes a planning round-trip and is faster.",
		promptSnippet: "Explore code across many files in parallel, returning cited findings",
		promptGuidelines: [
			"Use explore when you need to understand code spanning more than ~5 files.",
			"When calling explore, supply `questions` with 2-4 sub-questions if you can decompose the task.",
			"Do not use explore when you already know the exact file and line you need.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "What you need to find out" }),
			questions: Type.Optional(
				Type.Array(Type.String(), { description: "Pre-decomposed sub-questions, one per explorer" }),
			),
			scope: Type.Optional(Type.String({ description: "Glob or directory to limit the search" })),
			fanout: Type.Optional(Type.Number({ description: "Override the number of explorers" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input: ExploreInput = params;
			// A model-supplied fanout of 0 or a negative would dispatch nothing at
			// all, so the floor of 1 keeps a bad argument from silently no-opping.
			const maxFanout = Math.max(1, Math.min(input.fanout ?? cfg.maxFanout, cfg.maxFanout));
			const briefs = buildBriefs(input, maxFanout);
			const model = cfg.model ?? ctx.model?.id ?? null;

			// Partial updates carry `details` too — AgentToolResult requires it on
			// every emission, not just the final one.
			const finished: ExplorerResult[] = [];
			const report = () =>
				onUpdate?.({
					content: [
						{ type: "text", text: `${finished.length}/${briefs.length} explorers done` },
					],
					details: { briefs, results: [...finished] },
				});
			report();

			const tasks = briefs.map((brief) => async () => {
				const task = input.scope ? `${brief}\n\nLimit your search to: ${input.scope}` : brief;
				// The ceiling is shared with auto-promotion: both paths spawn the
				// same subprocesses, so neither may budget for itself alone.
				const result = await withExplorerSlot(cfg.concurrency, () =>
					runExplorer({
						command: "pi",
						args: buildExplorerArgs(cfg, model, PROMPT_PATH, task),
						brief,
						cfg,
						cwd: ctx.cwd,
						signal,
					}),
				);
				finished.push(result);
				report();
				return result;
			});

			const results = await runWithConcurrency(tasks, cfg.concurrency);
			const usage = aggregateUsage(results);

			const details: ExploreDetails = { briefs, results };
			return {
				content: [{ type: "text" as const, text: synthesize(results) }],
				details,
				usage,
			};
		},
	});

	// Path B: intercept sweeps the model did not know were sweeps. This matters
	// more in practice than the explore tool, because the common failure is the
	// model not anticipating that a grep would span the whole repository.
	//
	// `cfg` is read through a getter, not captured, so a session_start reload
	// takes effect without re-registering the handler.
	pi.on("tool_result", createSweepHandler(() => cfg));
}
