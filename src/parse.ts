export interface GrepParseResult {
	files: string[];
	matchCount: number;
}

/**
 * One `path:line:text` row, kept whole rather than collapsed to a file name.
 *
 * The line number and the text are what let a caller ask the question the file
 * list cannot answer: does this output actually describe *this* repository at
 * *these* lines? That check is the false-positive guard on the bash path — see
 * `detect.ts`.
 */
export interface GrepMatch {
	file: string;
	/** 1-based, as every grep-family tool reports it. */
	line: number;
	/** Everything after the line number, with the separator space removed. */
	text: string;
}

// pi's grep.js emits `${relativePath}:${lineNumber}: ${text}`. The non-greedy
// path group plus the required ": " after the line number keeps colons inside
// match text from being mistaken for the path separator.
const GREP_LINE = /^(.+?):(\d+): /;

// `grep -n`, `rg` and `git grep -n` emit `path:line:text` with no space, which
// GREP_LINE rejects outright. This form is tried only after GREP_LINE fails, so
// every line the strict form already parsed still parses identically: the
// fallback can add a match, never move one. The order is load-bearing rather
// than stylistic — on a path that itself contains `:<digits>:` the strict form
// is the one that gets the path right, and it must keep winning.
const BARE_GREP_LINE = /^(.+?):(\d+):/;

function isNotice(line: string): boolean {
	const t = line.trim();
	return t.startsWith("[") && t.endsWith("]");
}

export function parseGrepMatches(output: string): GrepMatch[] {
	const matches: GrepMatch[] = [];

	for (const line of output.split("\n")) {
		if (!line.trim() || isNotice(line)) continue;
		const m = GREP_LINE.exec(line) ?? BARE_GREP_LINE.exec(line);
		if (!m) continue;
		matches.push({ file: m[1]!, line: Number(m[2]), text: line.slice(m[0].length) });
	}

	return matches;
}

export function summarizeMatches(matches: GrepMatch[]): GrepParseResult {
	const files = new Set<string>();
	for (const m of matches) files.add(m.file);
	return { files: [...files], matchCount: matches.length };
}

export function parseGrepOutput(output: string): GrepParseResult {
	return summarizeMatches(parseGrepMatches(output));
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
