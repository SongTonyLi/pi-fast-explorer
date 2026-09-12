import { createHash, randomUUID } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ToolResultEvent,
	getAgentDir,
	isBashToolResult,
	isFindToolResult,
	isGrepToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type ExplorerSnapshot,
	nextExplorerId,
	resetExplorers,
	shouldResetExplorers,
	upsertExplorer,
} from "./activity.js";
import {
	type ChecklistItem,
	type ChecklistStatus,
	formatChecklistCoverage,
	matchChecklist,
} from "./checklist.js";
import { extractCitations } from "./citations.js";
import { type FastExplorerConfig, type PartialConfig, loadConfigFrom, resolveConfig } from "./config.js";
import { looksLikeSearchOutput } from "./detect.js";
import {
	type Accumulator,
	type ExplorerModel,
	type ExplorerResult,
	NESTED_ENV_VAR,
	buildExplorerArgs,
	extractDisplayItems,
	extractFinalText,
	runExplorer,
	runWithConcurrency,
} from "./explorer.js";
import { bindExplorerUi, refreshExplorerWidget, registerExplorerCommands, renderExploreCall, renderExploreResult } from "./ui.js";
import { parseFindOutput, parseGrepMatches, parseGrepOutput, summarizeMatches } from "./parse.js";
import { bucketByDirectory, computeFanout, shouldExplore } from "./partition.js";
import { hasFindings, synthesize } from "./synthesis.js";

export interface ExploreInput {
	question: string;
	/** Specific things to locate or answer; each comes back resolved or not. */
	checklist?: string[];
	questions?: string[];
	scope?: string;
	fanout?: number;
}

/** Structured payload attached to every tool result, partial and final alike. */
export interface ExploreDetails {
	briefs: string[];
	/**
	 * Each explorer's report exactly as it came back, before `synthesize`
	 * re-anchors citations against disk. This is the record of what was said;
	 * the text content is the corrected version the main agent reasons from.
	 */
	results: ExplorerResult[];
	/** Live tool-call stream used by the TUI inspector and renderers. */
	live: ExplorerSnapshot[];
	/** One verdict per checklist item, after every wave. Empty without a checklist. */
	checklist: ChecklistStatus[];
}

function snapshotFromAcc(
	id: string,
	brief: string,
	acc: Accumulator,
	status: ExplorerSnapshot["status"] = "running",
	error?: string,
): ExplorerSnapshot {
	return {
		id,
		brief,
		status,
		items: extractDisplayItems(acc),
		report: extractFinalText(acc),
		error,
	};
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, "..", "prompts", "explorer.md");

/** Basename of both the user-level and project-level config files. */
export const CONFIG_FILE_NAME = "fast-explorer.json";

/**
 * What the model reads before deciding whether to call explore at all.
 *
 * Exported so the wording is pinned by a test rather than living only inside a
 * registration call. The cost figures are deliberate: the model is choosing
 * between one subprocess and four, and it cannot weigh that without numbers.
 *
 * This used to recommend `questions` for a question spanning separable areas of
 * the codebase. That recommendation has since been measured on exactly that case
 * and it lost — see the note on `buildBriefs` — so the wording states the
 * measurement instead of a preference. Not "never helps", which we have not
 * shown; "no measured benefit", which is what the data supports.
 */
export const EXPLORE_DESCRIPTION =
	"Investigate code spanning many files using parallel read-only explorers. " +
	"Returns cited findings (file:line) instead of raw file contents. " +
	"Pass `checklist` — the specific things you need located or answered — and every " +
	"item comes back marked resolved with a citation or unresolved, with unresolved items " +
	"re-dispatched once to fresh explorers. " +
	"One explorer is the default: pass `question` alone. `questions` runs one " +
	"explorer per entry and has no measured benefit — on questions a single " +
	"explorer already covered it cost about 3.6x for identical recall and worse " +
	"precision, and on the one question measured whose answer genuinely spanned " +
	"four subsystems it cost 2.3x and found LESS (recall 0.80 against 1.00). " +
	"Supply it only for a reason the measurement has not tested.";

/**
 * pi appends these to the system prompt flat, with no tool-name grouping, so
 * every bullet has to name `explore` or it reads as advice about nothing.
 *
 * The decomposition bullet names the parameter and then argues against reaching
 * for it, rather than omitting it. A parameter the schema advertises and the
 * guidance never mentions is a trap: the model finds it anyway and has nothing
 * to weigh it with. This wording gives it the number instead.
 */
export const EXPLORE_PROMPT_GUIDELINES = [
	"Use explore when you need to understand code spanning more than ~5 files.",
	"Give explore a `checklist` when you know the specific things you need — files, " +
		"call sites, values, decisions. Each item is returned resolved with file:line or " +
		"unresolved, and unresolved items are re-dispatched once to fresh explorers that are " +
		"told what the first one established. Prefer a `checklist` over `questions`.",
	"Call explore with `question` alone by default — one explorer is the configuration " +
		"with evidence behind it, and it matched or beat four explorers on recall on every " +
		"benchmark question.",
	"Do not split a question into `questions` for explore hoping for better coverage: " +
		"decomposition has no measured benefit. On questions one explorer already covered, " +
		"four explorers cost about 3.6x for identical recall and worse precision; on the one " +
		"question measured whose answer genuinely spanned separable areas of the codebase — " +
		"four subsystems, ~5,100 lines — four explorers cost 2.3x and scored LOWER recall " +
		"(0.80 against 1.00), missing the same file in 4 of 5 runs though a sub-question " +
		"aimed straight at it. Each explorer covers its slice and stops, so what connects " +
		"the slices is what goes missing.",
	"Do not use explore when you already know the exact file and line you need.",
];

/**
 * Caller-supplied `questions` remove a blocking planner round-trip from the
 * critical path: the main agent is already reasoning when it calls explore, so
 * it can decompose in the turn it already occupies.
 *
 * The fallback to a single brief is the common case, not a degraded one — and
 * on the evidence it is the better one everywhere it has been measured.
 * Benchmark run `2026-09-11T05-44-05`, 5 questions x 3 arms x 5 runs (that run's
 * artifact is not published — see README):
 * fan-out never beat one explorer on recall and was worse on precision on all
 * five. On the four questions one explorer saturated it cost 3.6x for identical
 * recall. On `bash-approval` — added to give fan-out its best case, an answer
 * spanning four subsystems and ~5,100 lines — it cost 2.3x and scored LOWER
 * recall (0.80 against 1.00), missing the same ground-truth file in 4 of 5 runs
 * despite a sub-question aimed squarely at it. That is partition blindness,
 * measured: each explorer covers its slice and stops, so the connective tissue
 * between subsystems falls through.
 *
 * The path is kept anyway. One separable question on one corpus with one model
 * is not enough to delete tested, working code, and the machinery is what a
 * sequential-escalation design would run on — explore once, fan out only if the
 * first report's `## Not Covered` is non-trivial. See the spec's "Open question:
 * is fan-out ever worth it?". What changed is the advice: see
 * EXPLORE_PROMPT_GUIDELINES.
 */
export function buildBriefs(input: ExploreInput, maxFanout: number): string[] {
	const supplied = (input.questions ?? []).map((q) => q.trim()).filter((q) => q.length > 0);
	if (supplied.length > 0) return supplied.slice(0, maxFanout);
	return [input.question];
}

/** The checklist as numbered items, blanks dropped, numbered as the explorer will echo them. */
export function checklistItems(input: ExploreInput): ChecklistItem[] {
	return (input.checklist ?? [])
		.map((c) => c.trim())
		.filter((c) => c.length > 0)
		.map((item, i) => ({ index: i + 1, item }));
}

const CHECKLIST_HEADER = "Checklist — resolve every item and cite file:line for each:";

/** The full task text for one explorer: brief, then checklist, then scope. */
export function buildTask(brief: string, items: ChecklistItem[], scope: string | undefined): string {
	let task = brief;
	if (items.length > 0) {
		task += `\n\n${CHECKLIST_HEADER}\n${items.map((i) => `${i.index}. ${i.item}`).join("\n")}`;
	}
	if (scope) task += `\n\nLimit your search to: ${scope}`;
	return task;
}

/** Cap on first-wave files inlined into an escalation brief; see MAX_FILES_PER_BRIEF. */
export const MAX_ESTABLISHED_FILES = 40;

/**
 * Briefs for the second wave: the items the first wave left unresolved,
 * spread round-robin over at most `maxFanout` explorers, each told what the
 * first wave established so it starts from there rather than from nothing.
 *
 * Handing the second wave the first's resolved lines and retrieved files is
 * the mitigation for partition blindness — the measured failure of fan-out,
 * where each explorer covers its slice and the connective tissue falls through.
 * A second-wave explorer is not covering a slice; it is filling gaps in a map
 * it has been shown. Items keep their original numbers so the reply lines
 * match up by index as well as by text.
 */
export function buildEscalationBriefs(
	question: string,
	statuses: ChecklistStatus[],
	priorReports: string[],
	maxFanout: number,
): string[] {
	const unresolved = statuses.filter((s) => !s.resolved);
	if (unresolved.length === 0) return [];
	const resolved = statuses.filter((s) => s.resolved);

	const files = new Map<string, string>();
	for (const report of priorReports) {
		for (const c of extractCitations(report)) {
			if (!files.has(c.file)) files.set(c.file, `${c.file} (lines ${c.startLine}-${c.endLine})`);
		}
	}
	const fileLines = [...files.values()].slice(0, MAX_ESTABLISHED_FILES);

	const established = [
		...resolved.map((s) => `- [x] ${s.index}. ${s.item} — ${s.note}`),
		...(fileLines.length > 0 ? ["Files it retrieved:", ...fileLines.map((f) => `- ${f}`)] : []),
	];
	const header =
		`${question}\n\nA first explorer already established the following — do not re-verify it, ` +
		`build on it:\n${established.join("\n")}`;

	const n = Math.max(1, Math.min(maxFanout, unresolved.length));
	const groups: ChecklistStatus[][] = Array.from({ length: n }, () => []);
	unresolved.forEach((s, i) => groups[i % n]!.push(s));
	return groups.map(
		(g) => `${header}\n\n${CHECKLIST_HEADER}\n${g.map((s) => `${s.index}. ${s.item}`).join("\n")}`,
	);
}

/** Short label for a second-wave explorer, from the item numbers its task carries. */
export function escalationLabel(task: string, ordinal: number, total: number): string {
	const tail = task.slice(task.lastIndexOf(CHECKLIST_HEADER));
	const numbers = [...tail.matchAll(/^(\d+)\. /gm)].map((m) => m[1]);
	return `escalation ${ordinal}/${total}: unresolved item${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}`;
}

/**
 * Escalate only when there is something to escalate and something to build
 * on. A first wave that produced nothing would only be repeated, at the same
 * cost, and the failure text already says what to do instead.
 */
export function shouldEscalate(
	cfg: FastExplorerConfig,
	statuses: ChecklistStatus[],
	wave: ExplorerResult[],
): boolean {
	return cfg.escalateUnresolved && statuses.some((s) => !s.resolved) && hasFindings(wave);
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

/** How many promoted bash outputs are remembered. Bounded, newest last. */
const PROMOTED_MEMORY = 32;
const promotedOutputs: string[] = [];

/**
 * Records a bash output as promoted, returning false if it already was.
 *
 * This closes a loop the bash trigger opens and the grep trigger cannot. Every
 * promotion tells the model "Raw command output saved to: /tmp/fx-matches-….txt"
 * — an invitation to go and read it, and with bash on the toolbelt the model
 * reads it by running `cat`. That `cat` returns the match list verbatim, which
 * parses as a search, resolves against disk and verifies line for line: a
 * perfect promotion candidate. Left alone, every attempt to recover the raw
 * output would spend another fan-out and return findings instead, and the model
 * would never get the thing it asked for.
 *
 * It is not a fork bomb — each round is one model turn and the concurrency
 * ceiling still holds — but it is an unbounded spend triggered by following our
 * own advice, which is worse than it sounds.
 *
 * Deliberately bash-only. A model repeating the same grep twice is repeating a
 * search and should be promoted twice; a model reading back a spill file is not
 * searching at all.
 */
export function claimOutput(text: string): boolean {
	const key = createHash("sha256").update(text.trim()).digest("hex");
	if (promotedOutputs.includes(key)) return false;
	promotedOutputs.push(key);
	if (promotedOutputs.length > PROMOTED_MEMORY) promotedOutputs.shift();
	return true;
}

/** Exposed for tests, which must not inherit each other's promotion history. */
export function forgetPromotedOutputs(): void {
	promotedOutputs.length = 0;
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
 * Heading for one auto-promotion bucket. Buckets are bin-packed by directory
 * and routinely span several, so the label names them all (up to three) rather
 * than the first file's — measured: "8 files under src/memdir" for a bucket
 * whose report was mostly about src/services.
 */
export function describeBucket(bucket: string[]): string {
	const dirs = [...new Set(bucket.map((f) => dirname(f)))];
	if (dirs.length <= 1) return `${bucket.length} files under ${dirs[0] ?? "."}`;
	const shown = dirs.slice(0, 3).join(", ");
	const more = dirs.length > 3 ? ` +${dirs.length - 3} more` : "";
	return `${bucket.length} files across ${shown}${more}`;
}

/** Which tool result a sweep came from. Decides the brief and the spill note. */
export type SweepKind = "grep" | "find" | "bash";

/**
 * Ceiling on the intent string inlined into a brief.
 *
 * Only `bash` can get near it. A grep pattern is short by nature; a shell
 * command can be a three-line pipeline with a heredoc in it, and pasting that
 * verbatim into every explorer prompt spends context on quoting rather than on
 * intent.
 */
export const MAX_INTENT_CHARS = 200;

/** Collapses a command to one line and caps it, for inlining into a brief. */
export function summarizeIntent(intent: string): string {
	const flat = intent.replace(/\s+/g, " ").trim();
	return flat.length > MAX_INTENT_CHARS ? `${flat.slice(0, MAX_INTENT_CHARS)}…` : flat;
}

/**
 * Briefs are phrased per source because the three inputs carry very different
 * amounts of intent. A grep pattern is a real signal — someone was looking for
 * that specific thing — so the brief leans on it. A find glob says only "these
 * are .ts files", so leaning on it invites the explorer to invent a purpose that
 * was never there; that brief asks what the files *are* instead.
 *
 * `bash` gets the command, because the command is all there is: pi's bash tool
 * takes `{ command, timeout }` and no structured pattern. That turns out to be
 * the richest of the three — `rg -n --glob '!node_modules' 'tool_use_id' src/`
 * states the pattern, the exclusions and the scope in one string — but it is
 * also the only one an explorer might misread as an instruction to run, which it
 * cannot do and must not try. The wording therefore says what the command was
 * *for* rather than quoting it as a thing to do.
 *
 * The file list is capped, and the cap is disclosed. An explorer handed a silent
 * truncation would report on a sample while believing it had the whole set,
 * which is the same failure mode the "Not Covered" contract exists to prevent.
 */
export function buildSweepBrief(
	kind: SweepKind,
	intent: string,
	scope: string,
	totalFiles: number,
	bucket: string[],
): string {
	const shown = bucket.slice(0, MAX_FILES_PER_BRIEF);
	const omitted = bucket.length - shown.length;
	const where = scope ? ` ${scope}` : "";

	const header =
		kind === "grep"
			? `The main agent searched this repository for the pattern \`${intent}\`${where} ` +
				`and matched ${totalFiles} files. Investigate what that pattern is doing across ` +
				`your share of them: what each site is for, how they relate, and what someone ` +
				`would need to know before changing it.`
			: kind === "find"
				? `The main agent listed files matching the glob \`${intent}\`${where} and got ` +
					`${totalFiles} paths. A glob carries no intent, so do not guess at one — report ` +
					`what these files are and what they do, grouped by what they have in common.`
				: `The main agent searched this repository by running the shell command ` +
					`\`${summarizeIntent(intent)}\`${where}, which matched ${totalFiles} files. That ` +
					`command is the only statement of intent you get: read it for what was being ` +
					`looked for, and do not run it or anything else. Investigate what it found across ` +
					`your share of those files: what each site is for, how they relate, and what ` +
					`someone would need to know before changing it.`;

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
 * Which model an explorer runs on: the configured one, else the session's.
 *
 * A configured model is a string the user wrote and may already be
 * `provider/id`; no provider is invented for it. An inherited model carries the
 * session's provider, because a bare id can be served by more than one provider
 * and an explorer landing on the other one bills a different account silently.
 */
export function resolveExplorerModel(
	cfg: FastExplorerConfig,
	sessionModel: { id: string; provider?: string } | undefined,
): ExplorerModel | null {
	if (cfg.model) return { id: cfg.model };
	if (sessionModel?.id) return { id: sessionModel.id, provider: sessionModel.provider };
	return null;
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
	model: { id: string; provider?: string } | undefined;
	/** Undefined when the agent is not streaming. Threaded so Esc cancels explorers. */
	signal: AbortSignal | undefined;
}

/**
 * Which of the three promotable tools produced this result, if any.
 *
 * `event.toolName === "grep"` cannot narrow the union, because
 * CustomToolResultEvent declares `toolName: string` and so overlaps every string
 * literal. pi ships these guards for exactly that reason.
 *
 * `bash` is here because the trigger set was measured being bypassed. Asked
 * explicitly to "use the grep tool", pi with its default toolbelt ran
 * `bash: grep -RIn -- "tool_use_id" src/` instead, and the hook never fired. The
 * same session restricted to `--tools read,grep,find,ls` promoted correctly, so
 * the machinery was right and only the trigger was too narrow. Models reach for
 * the shell; a hook that only watches the structured tools watches the path they
 * do not take.
 *
 * Only model-initiated bash arrives here. A command the *user* typed at the
 * prompt goes through pi's `user_bash` event, which this extension does not
 * register for, so nothing a human ran by hand can have its output replaced.
 */
function sweepKind(event: ToolResultEvent): SweepKind | null {
	if (isGrepToolResult(event)) return "grep";
	if (isFindToolResult(event)) return "find";
	if (isBashToolResult(event)) return "bash";
	return null;
}

/**
 * Builds the `tool_result` handler that turns an oversized search into cited
 * findings, whether it arrived as `grep`, `find`, or a shell command.
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
		// promote, or each one spawns a fresh wave that does the same. Adding bash
		// to the trigger set does not widen this: explorers are spawned with
		// `--tools read,grep,find,ls`, so an explorer has no bash whose output
		// could promote, and this guard fires before that even comes up.
		if (isNestedExplorer()) return undefined;

		const kind = sweepKind(event);
		if (!kind) return undefined;
		if (event.isError) return undefined;

		const cfg = getConfig();
		if (kind === "bash" && !cfg.autoPromote.bash) return undefined;

		const text = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		// Only bash needs the rows themselves; grep and find are searches by
		// construction and are summarized exactly as they always were.
		const matches = kind === "bash" ? parseGrepMatches(text) : [];
		const parsed =
			kind === "grep"
				? parseGrepOutput(text)
				: kind === "find"
					? { files: parseFindOutput(text), matchCount: 0 }
					: summarizeMatches(matches);
		if (!shouldAutoPromote(parsed.files, parsed.matchCount, cfg)) return undefined;

		// bash has no `path` argument, and none is wanted: it runs in the session
		// cwd and prints paths relative to it, so the search root is already cwd.
		const searchDir = typeof event.input.path === "string" ? event.input.path : ".";
		const files = normalizeMatchPaths(parsed.files, ctx.cwd, searchDir);
		if (!shouldExplore(measureBytes(files, ctx.cwd, cfg.minTotalBytes), cfg).explore) {
			return undefined;
		}

		// Last, because it reads files: the cheap gates have already rejected
		// everything that was never going to be worth the read.
		if (kind === "bash") {
			if (!looksLikeSearchOutput(matches, ctx.cwd)) return undefined;
			if (!claimOutput(text)) return undefined;
		}

		const buckets = bucketByDirectory(files, computeFanout(files.length, cfg.maxFanout));
		const model = resolveExplorerModel(cfg, ctx.model);
		const scope = describeScope(searchDir, event.input.glob);
		// grep and find state their intent in `pattern`; bash has only `command`.
		const intentKey = kind === "bash" ? "command" : "pattern";
		const intent = typeof event.input[intentKey] === "string" ? event.input[intentKey] : "";

		const tasks = buckets.map((bucket) => () => {
			const brief = describeBucket(bucket);
			const id = nextExplorerId();
			let items: ExplorerSnapshot["items"] = [];
			upsertExplorer({ id, brief, status: "running", items, report: "" });
			refreshExplorerWidget();
			return withExplorerSlot(cfg.concurrency, async () => {
				const result = await runExplorer({
					command: "pi",
					args: buildExplorerArgs(
						cfg,
						model,
						PROMPT_PATH,
						buildSweepBrief(kind, intent, scope, files.length, bucket),
					),
					brief,
					cfg,
					cwd: ctx.cwd,
					signal: ctx.signal,
					onActivity: (acc) => {
						const snap = snapshotFromAcc(id, brief, acc);
						items = snap.items;
						upsertExplorer(snap);
						refreshExplorerWidget();
					},
				});
				upsertExplorer({
					id,
					brief,
					status: result.ok ? "ok" : "failed",
					items,
					report: result.report,
					error: result.error,
				});
				refreshExplorerWidget();
				return result;
			});
		});

		const results = await runWithConcurrency(tasks, cfg.concurrency);

		// Every explorer failed, so there is nothing to promote. Returning here
		// leaves pi's own result in place byte for byte (`agent-session.js:258` —
		// a handler that returns undefined is not applied at all), which is the
		// whole point: without this branch the model's search result was replaced
		// with "Exploration produced no findings — every explorer failed" plus a
		// path to a spill file it must spend a turn reading back. Losing the match
		// list AND getting nothing useful is strictly worse than not promoting.
		//
		// It is also the containment for a failure this extension cannot detect on
		// its own. `runExplorer` treats any stopReason but the literal "stop" as a
		// failure, against a seven-value vocabulary in an undeclared transitive
		// dependency (see the note there). If pi ever renames it, every explorer is
		// reported failed — and without this branch that does not degrade the
		// feature, it INVERTS it: every promotable search returns a failure notice,
		// at four model calls apiece, with the original output destroyed. With it,
		// the same upstream change costs money and changes nothing the model sees.
		// That holds for any future cause of total failure, not just this one.
		//
		// The cost of returning undefined rather than a faithful reconstruction of
		// the original result is that the explorers' usage goes unreported, and
		// this package holds that spawning LLM subprocesses must not hide their
		// cost. The alternative was `{ content: event.content, details:
		// event.details, usage }`, which pi would accept — but it would rebuild the
		// tool result from a hand-copied field list, so any field pi adds later is
		// silently dropped. That is the same shape of version coupling as the bug
		// this branch exists to contain, and it would be introduced on the one path
		// whose entire job is to be safe when upstream changed underneath us.
		if (!hasFindings(results)) return undefined;

		// Spilled only now that the result is actually going to be replaced. Written
		// before the sweep it would be litter in exactly the case above: a 0600 file
		// of repository text, in the OS temp directory, whose path nobody was ever
		// told — spill files are never deleted (README limitation 11), so the only
		// way not to leave one behind is not to write it.
		//
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
			// Best-effort. Promotion proceeds, but we must not then point the model
			// at a file that is not there: that costs it a wasted turn.
			spilled = false;
		}

		const spillNote = spilled
			? `Raw ${kind === "bash" ? "command" : kind} output (${files.length} files) saved to: ${spillPath}`
			: `${files.length} files matched. Raw output could not be saved to disk.`;

		return {
			content: [
				{ type: "text" as const, text: `${synthesize(results, ctx.cwd)}\n\n---\n\n${spillNote}` },
			],
			// This REPLACES the tool's usage rather than adding to it
			// (core/agent-session.js: `usage: hookResult?.usage`). Safe only because
			// none of grep, find and bash report usage of their own — all three
			// return `{ content, details }` and nothing else. Reporting it is not
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
	pi.on("session_start", (event, ctx) => {
		const { config, error } = loadConfigFrom(
			join(getAgentDir(), CONFIG_FILE_NAME),
			join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
			ctx.isProjectTrusted(),
			userConfig,
			cfg,
		);
		cfg = config;
		if (shouldResetExplorers(event.reason)) resetExplorers();
		bindExplorerUi(ctx.hasUI ? ctx.ui : undefined);
		refreshExplorerWidget();
		if (error) {
			ctx.ui.notify(`fast-explorer: ignoring invalid config — ${error}`, "warning");
		}
	});

	registerExplorerCommands(pi);

	pi.registerTool({
		name: "explore",
		label: "Explore",
		description: EXPLORE_DESCRIPTION,
		promptSnippet: "Explore code across many files in parallel, returning cited findings",
		promptGuidelines: EXPLORE_PROMPT_GUIDELINES,
		parameters: Type.Object({
			question: Type.String({ description: "What you need to find out" }),
			checklist: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Specific things to locate or answer, one per entry. Each comes back marked " +
						"resolved with file:line or unresolved; unresolved items are re-dispatched once " +
						"to fresh explorers told what the first one found. Prefer this over `questions`.",
				}),
			),
			questions: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Sub-questions, one per explorer. Not recommended: decomposition has no measured " +
						"benefit. It cost 3.6x a single explorer for identical recall on questions one " +
						"explorer already covered, and 2.3x for LOWER recall (0.80 against 1.00) on the one " +
						"question measured whose answer genuinely spanned four subsystems. Leave this out " +
						"and put the whole question in `question`.",
				}),
			),
			scope: Type.Optional(Type.String({ description: "Glob or directory to limit the search" })),
			fanout: Type.Optional(Type.Number({ description: "Override the number of explorers" })),
		}),

		renderCall(args, theme) {
			return renderExploreCall(args, theme);
		},

		renderResult(result, { expanded }, theme) {
			return renderExploreResult(result, { expanded }, theme);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input: ExploreInput = params;
			// A model-supplied fanout of 0 or a negative would dispatch nothing at
			// all, so the floor of 1 keeps a bad argument from silently no-opping.
			const maxFanout = Math.max(1, Math.min(input.fanout ?? cfg.maxFanout, cfg.maxFanout));
			const briefs = buildBriefs(input, maxFanout);
			const items = checklistItems(input);
			const model = resolveExplorerModel(cfg, ctx.model);
			if (ctx.hasUI) bindExplorerUi(ctx.ui);

			// Shared across waves: a second wave appends to all three.
			const live: ExplorerSnapshot[] = [];
			const allBriefs: string[] = [];
			const finished: ExplorerResult[] = [];
			let checklist: ChecklistStatus[] = [];

			// Partial updates carry `details` too — AgentToolResult requires it on
			// every emission, not just the final one.
			const report = () => {
				try {
					onUpdate?.({
						content: [
							{ type: "text", text: `${finished.length}/${allBriefs.length} explorers done` },
						],
						details: {
							briefs: [...allBriefs],
							results: [...finished],
							live: live.map((s) => ({ ...s })),
							checklist: [...checklist],
						},
					});
				} catch {
					// Same isolation as onActivity: a throwing renderer must not
					// fail the explore Promise.all after the money is spent.
				}
			};

			/** Runs one wave of explorers, registering each with the inspector. */
			const dispatch = async (
				wave: Array<{ brief: string; task: string }>,
			): Promise<ExplorerResult[]> => {
				const offset = live.length;
				for (const w of wave) {
					allBriefs.push(w.brief);
					live.push({ id: nextExplorerId(), brief: w.brief, status: "running", items: [], report: "" });
				}
				for (const snap of live.slice(offset)) upsertExplorer(snap);
				refreshExplorerWidget();
				report();

				const tasks = wave.map((w, i) => async () => {
					const index = offset + i;
					// The ceiling is shared with auto-promotion: both paths spawn the
					// same subprocesses, so neither may budget for itself alone.
					const result = await withExplorerSlot(cfg.concurrency, () =>
						runExplorer({
							command: "pi",
							args: buildExplorerArgs(cfg, model, PROMPT_PATH, w.task),
							brief: w.brief,
							cfg,
							cwd: ctx.cwd,
							signal,
							onActivity: (acc) => {
								live[index] = snapshotFromAcc(live[index]!.id, w.brief, acc);
								upsertExplorer(live[index]!);
								refreshExplorerWidget();
								report();
							},
						}),
					);
					live[index] = {
						id: live[index]!.id,
						brief: w.brief,
						status: result.ok ? "ok" : "failed",
						items: live[index]!.items,
						report: result.report,
						error: result.error,
					};
					upsertExplorer(live[index]!);
					finished.push(result);
					refreshExplorerWidget();
					report();
					return result;
				});
				return runWithConcurrency(tasks, cfg.concurrency);
			};

			const wave1 = await dispatch(
				briefs.map((brief) => ({ brief, task: buildTask(brief, items, input.scope) })),
			);
			let results = wave1;
			const asReports = (rs: ExplorerResult[]) => rs.map((r) => ({ brief: r.brief, report: r.report }));
			if (items.length > 0) {
				checklist = matchChecklist(items.map((i) => i.item), asReports(wave1));
				// One escalation wave, never a third: whatever the second wave leaves
				// unresolved is reported as unresolved.
				if (!signal?.aborted && shouldEscalate(cfg, checklist, wave1)) {
					const prior = wave1.filter((r) => r.report.trim().length > 0).map((r) => r.report);
					const escalations = buildEscalationBriefs(input.question, checklist, prior, maxFanout);
					const wave2 = await dispatch(
						escalations.map((task, i) => ({
							brief: escalationLabel(task, i + 1, escalations.length),
							task: buildTask(task, [], input.scope),
						})),
					);
					results = [...wave1, ...wave2];
					checklist = matchChecklist(items.map((i) => i.item), asReports(results));
				}
			}
			const usage = aggregateUsage(results);

			const details: ExploreDetails = {
				briefs: allBriefs,
				results,
				live: live.map((s) => ({ ...s })),
				checklist,
			};
			return {
				content: [
					{
						type: "text" as const,
						text: synthesize(results, ctx.cwd, {
							coverage: items.length > 0 ? formatChecklistCoverage(checklist) : undefined,
						}),
					},
				],
				details,
				usage,
			};
		},
	});

	// Path B: intercept sweeps the model did not know were sweeps. This matters
	// more in practice than the explore tool, because the common failure is the
	// model not anticipating that a grep would span the whole repository — and
	// that is also why the hook watches `bash`. A trigger set of grep and find
	// alone was measured missing the case it exists for, because the model
	// searched with the shell.
	//
	// `cfg` is read through a getter, not captured, so a session_start reload
	// takes effect without re-registering the handler.
	pi.on("tool_result", createSweepHandler(() => cfg));
}
