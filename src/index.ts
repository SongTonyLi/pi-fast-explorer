import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type PartialConfig, loadConfigFrom, resolveConfig } from "./config.js";
import { type ExplorerResult, buildExplorerArgs, runExplorer, runWithConcurrency } from "./explorer.js";
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
				const result = await runExplorer({
					command: "pi",
					args: buildExplorerArgs(cfg, model, PROMPT_PATH, task),
					brief,
					cfg,
					cwd: ctx.cwd,
					signal,
				});
				finished.push(result);
				report();
				return result;
			});

			const results = await runWithConcurrency(tasks, cfg.concurrency);
			// Usage must match pi's Usage shape exactly so session totals include
			// explorer work. Only `cost.total` is available per explorer, so the
			// per-category cost fields stay at zero.
			const usage = results.reduce(
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

			const details: ExploreDetails = { briefs, results };
			return {
				content: [{ type: "text" as const, text: synthesize(results) }],
				details,
				usage,
			};
		},
	});
}
