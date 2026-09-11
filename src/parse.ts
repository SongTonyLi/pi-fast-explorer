export interface GrepParseResult {
	files: string[];
	matchCount: number;
}

// grep.js emits `${relativePath}:${lineNumber}: ${text}`. The non-greedy path
// group plus the required ": " after the line number keeps colons inside match
// text from being mistaken for the path separator.
const GREP_LINE = /^(.+?):(\d+): /;

function isNotice(line: string): boolean {
	const t = line.trim();
	return t.startsWith("[") && t.endsWith("]");
}

export function parseGrepOutput(output: string): GrepParseResult {
	const files = new Set<string>();
	let matchCount = 0;

	for (const line of output.split("\n")) {
		if (!line.trim() || isNotice(line)) continue;
		const m = GREP_LINE.exec(line);
		if (!m) continue;
		files.add(m[1]!);
		matchCount++;
	}

	return { files: [...files], matchCount };
}

const NO_RESULTS = "No files found matching pattern";

export function parseFindOutput(output: string): string[] {
	const files: string[] = [];
	for (const line of output.split("\n")) {
		const t = line.trim();
		if (!t || isNotice(t) || t === NO_RESULTS) continue;
		files.push(t);
	}
	return files;
}
