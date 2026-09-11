import { reanchorReport } from "./citations.js";
import type { ExplorerResult } from "./explorer.js";

/**
 * Whether an explorer came back with something worth reading.
 *
 * `ok` alone is not enough: an explorer can exit cleanly having produced no
 * report, and a report of whitespace is a report of nothing.
 */
function producedFindings(r: ExplorerResult): boolean {
	return r.ok && r.report.trim().length > 0;
}

/**
 * Whether a whole sweep produced anything at all.
 *
 * Exported because `createSweepHandler` has to answer exactly this question
 * before it decides whether to replace the model's search result, and the two
 * answers must be the same one. Re-deriving it there — or worse, matching on
 * the "no findings" sentence `synthesize` writes — would be a second opinion
 * that can drift from the first, and the cost of drift is destroying a real
 * grep result on the strength of a string comparison.
 */
export function hasFindings(results: readonly ExplorerResult[]): boolean {
	return results.some(producedFindings);
}

/**
 * Turns explorer output into the text the main agent reads — and re-anchors it
 * on the way through.
 *
 * Re-anchoring lives here because this is the one function both entry points
 * (the explore tool and the auto-promotion hook) must call to produce that text.
 * Doing it at each call site would work today and rot the first time a third
 * path is added; doing it here makes an unverified anchor impossible to ship by
 * omission. That is also why it takes `cwd`: verification needs a root to
 * resolve cited paths against, and both call sites already hold one.
 *
 * Each report is re-anchored on its own rather than after joining. Per-report
 * keeps one explorer's quotes from re-anchoring another's citation entries, and
 * keeps the section headers this function adds out of the parsers' way.
 *
 * The return value is the text the guarantee is about: every quote in it that
 * the cited file does not contain carries a note saying so. We cannot stop an
 * explorer inventing a line — that gate was set at zero, was unreachable, and
 * was therefore ignored — but an invention that arrives labelled is one the main
 * agent knows not to build on, and an unlabelled one is the whole harm.
 * `findUnmarkedFailures` checks that property against this string; the test
 * beside it runs the check on real output of this function.
 *
 * The "every explorer failed" branch below is the text for the `explore` tool
 * path, where a caller asked for exploration and has to be told it produced
 * nothing. Auto-promotion does NOT deliver it: that path has an original search
 * result to keep, and `createSweepHandler` checks `hasFindings` and keeps it.
 */
export function synthesize(results: ExplorerResult[], cwd: string): string {
	if (results.length === 0) return "No explorers were dispatched.";

	const succeeded = results.filter(producedFindings);
	const failed = results.filter((r) => !producedFindings(r));

	const sections: string[] = [];

	if (succeeded.length === 0) {
		sections.push("Exploration produced no findings — every explorer failed.");
	} else {
		for (const r of succeeded) {
			const { report } = reanchorReport(r.report.trim(), cwd);
			sections.push(`# Explorer: ${r.brief}\n\n${report}`);
		}
	}

	if (failed.length > 0) {
		const lines = failed.map((r) => `- ${r.brief} — ${r.error ?? "no report produced"}`);
		sections.push(
			`## Not Covered\n\nThese areas were NOT examined. Treat them as unverified:\n\n${lines.join("\n")}`,
		);
	}

	return sections.join("\n\n---\n\n");
}
