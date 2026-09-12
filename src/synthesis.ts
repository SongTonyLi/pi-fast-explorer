import { extractCitations, extractQuotes, reanchorReport } from "./citations.js";
import type { ExplorerResult } from "./explorer.js";

/**
 * Whether an explorer came back with something worth reading.
 *
 * `ok` alone is not enough: an explorer can exit cleanly having produced no
 * report, and a report of whitespace is a report of nothing.
 */
/**
 * A partial report counts only if it got as far as something checkable — a
 * citation entry or a quote. A bare heading is a report that says nothing,
 * and on the auto-promotion path counting it would replace a real grep result
 * with an empty section.
 */
function hasSubstance(report: string): boolean {
	return extractCitations(report).length > 0 || extractQuotes(report).length > 0;
}

/**
 * Whether one explorer came back with something worth reading. Exported so the
 * checklist is computed from exactly the reports the caller receives.
 */
export function producedFindings(r: ExplorerResult): boolean {
	if (r.report.trim().length === 0) return false;
	if (r.ok) return true;
	return r.partial === true && hasSubstance(r.report);
}

/**
 * What the main agent is told after a failure. Measured: told "every explorer
 * failed — timed out", its next move was to issue the identical call again,
 * which timed out again at the same cost. A failure notice that names no
 * alternative is read as an invitation to retry.
 */
export const RETRY_GUIDANCE =
	"Do not repeat this explore call unchanged — the failure is not transient. Narrow `scope`, " +
	"split the brief into a shorter `checklist`, or read the files named above directly.";

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
export interface SynthesizeOptions {
	/** A section placed after the reports and before `## Not Covered`. */
	coverage?: string;
	/**
	 * Append RETRY_GUIDANCE after `## Not Covered`. Only the explore tool asks
	 * for it: the guidance names `scope` and `checklist`, and on the
	 * auto-promotion path the model called grep or bash and has no explore call
	 * to repeat.
	 */
	retryGuidance?: boolean;
}

export function synthesize(results: ExplorerResult[], cwd: string, options: SynthesizeOptions = {}): string {
	if (results.length === 0) return "No explorers were dispatched.";

	const succeeded = results.filter(producedFindings);
	const failed = results.filter((r) => !producedFindings(r));
	// A partial report is delivered as findings AND listed as not fully covered:
	// its citations are verified like any other's, but the explorer was killed
	// before it finished, so the area it covers is only partly examined.
	const partial = succeeded.filter((r) => r.partial === true);

	const sections: string[] = [];

	if (succeeded.length === 0) {
		sections.push("Exploration produced no findings — every explorer failed.");
	} else {
		for (const r of succeeded) {
			const { report } = reanchorReport(r.report.trim(), cwd);
			const title = r.partial
				? `# Explorer: ${r.brief} — PARTIAL (killed while writing; incomplete)`
				: `# Explorer: ${r.brief}`;
			sections.push(`${title}\n\n${report}`);
		}
	}

	if (options.coverage) sections.push(options.coverage);

	if (failed.length > 0 || partial.length > 0) {
		const lines = [
			...failed.map((r) => `- ${r.brief} — ${r.error ?? "no report produced"}`),
			...partial.map((r) => `- ${r.brief} — partially covered: ${r.error ?? "report incomplete"}`),
		];
		const guidance = options.retryGuidance ? `\n\n${RETRY_GUIDANCE}` : "";
		sections.push(
			`## Not Covered\n\nThese areas were NOT fully examined. Treat them as unverified:\n\n${lines.join("\n")}${guidance}`,
		);
	}

	return sections.join("\n\n---\n\n");
}
