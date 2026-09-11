import type { ExplorerResult } from "./explorer.js";

export function synthesize(results: ExplorerResult[]): string {
	if (results.length === 0) return "No explorers were dispatched.";

	const succeeded = results.filter((r) => r.ok && r.report.trim());
	const failed = results.filter((r) => !r.ok || !r.report.trim());

	const sections: string[] = [];

	if (succeeded.length === 0) {
		sections.push("Exploration produced no findings — every explorer failed.");
	} else {
		for (const r of succeeded) {
			sections.push(`# Explorer: ${r.brief}\n\n${r.report.trim()}`);
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
