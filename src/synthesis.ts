import { reanchorReport } from "./citations.js";
import type { ExplorerResult } from "./explorer.js";

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
 */
export function synthesize(results: ExplorerResult[], cwd: string): string {
	if (results.length === 0) return "No explorers were dispatched.";

	const succeeded = results.filter((r) => r.ok && r.report.trim());
	const failed = results.filter((r) => !r.ok || !r.report.trim());

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
