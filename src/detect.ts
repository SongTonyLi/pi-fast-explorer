import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { GrepMatch } from "./parse.js";

/**
 * Fraction of distinct parsed paths that must exist on disk.
 *
 * Real search output resolves at 1.00 — every path came from a directory walk
 * moments earlier. Text that merely *looks* like `path:line:text` resolves at
 * roughly 0.00: a Node stack frame parses as `    at a (/tmp/crash.js`, a
 * vitest failure line as ` ❯ x.test.ts`, a syslog line as `2026-09-11 12`.
 * There is no middle ground to split, so the threshold only has to sit off 1.00
 * far enough to absorb the handful of ways a genuine sweep loses one path:
 * output the bash tool truncated mid-line (the surviving head of the first line
 * parses to a stump), a file deleted between the search and this hook, a
 * matched line whose own text contains `:<digits>: ` and so misparses.
 *
 * 0.9 allows exactly one such path in the smallest promotable sweep (15 files)
 * and stays four or five orders of magnitude away from what accidental shapes
 * achieve.
 */
export const MIN_RESOLVED_FRACTION = 0.9;

/**
 * How many `path:line:text` rows are read back off disk and compared.
 *
 * Bounded because this runs inside the host agent's turn and reads real files.
 * The sample strides across the match list rather than taking the first N, so
 * it spans files instead of exhausting the first one.
 */
export const VERIFY_SAMPLE_SIZE = 10;

/** Below this many readable samples there is not enough evidence to promote. */
export const MIN_VERIFY_SAMPLE = 3;

/** Fraction of the sample whose text must match the file's real line. */
export const MIN_VERIFIED_FRACTION = 0.8;

/**
 * Files larger than this are skipped rather than read into memory. A matched
 * 500 MB log would otherwise block the host agent's event loop for the length of
 * a synchronous read.
 */
export const MAX_VERIFY_FILE_BYTES = 4 * 1024 * 1024;

/** Distinct files named by a match list, in first-seen order. */
export function matchedFiles(matches: GrepMatch[]): string[] {
	const files = new Set<string>();
	for (const m of matches) files.add(m.file);
	return [...files];
}

export function resolvedFraction(files: string[], cwd: string): number {
	if (files.length === 0) return 0;
	let found = 0;
	for (const f of files) {
		try {
			// isFile, not existsSync: a directory that happens to share the name is
			// not a file a search could have matched a line inside.
			if (statSync(resolve(cwd, f)).isFile()) found++;
		} catch {
			// Unreadable or absent. Counts against the fraction, which is the point.
		}
	}
	return found / files.length;
}

export interface VerificationTally {
	/** Samples whose file could actually be read. */
	attempted: number;
	/** Of those, how many carried the file's real text at the cited line. */
	verified: number;
}

/**
 * Reads sampled matches back off disk and checks the text is the file's line.
 *
 * This is the gate that path resolution cannot cover, and the reason it exists
 * is measured rather than imagined. Diagnostics from compilers and linters are
 * emitted as `path:line:col: message` about real files in the repository, so
 * they clear a resolution check outright. mypy's default `path:line: error: msg`
 * parses to a path that resolves, at a line that exists. What it cannot do is
 * carry the file's actual source text at that line — because the text is a
 * message *about* the line, not the line.
 *
 * Search output is the opposite: `grep -n`, `rg` and `git grep -n` all print the
 * matched line verbatim, so it round-trips exactly.
 *
 * Comparison is on trimmed text, which absorbs the one-space separator pi's own
 * grep inserts, a trailing CR from a CRLF file, and nothing else.
 */
export function verifyMatchedLines(matches: GrepMatch[], cwd: string): VerificationTally {
	const cache = new Map<string, string[] | null>();

	const read = (file: string): string[] | null => {
		const cached = cache.get(file);
		// `null` is a cached miss and must not be re-read; only `undefined` means
		// this path has never been tried.
		if (cached !== undefined) return cached;
		let lines: string[] | null = null;
		try {
			const path = resolve(cwd, file);
			if (statSync(path).size <= MAX_VERIFY_FILE_BYTES) {
				lines = readFileSync(path, "utf8").split("\n");
			}
		} catch {
			lines = null;
		}
		cache.set(file, lines);
		return lines;
	};

	let attempted = 0;
	let verified = 0;
	const step = Math.max(1, Math.ceil(matches.length / VERIFY_SAMPLE_SIZE));

	for (let i = 0; i < matches.length && attempted < VERIFY_SAMPLE_SIZE; i += step) {
		const m = matches[i]!;
		const lines = read(m.file);
		// A file we could not read is no evidence either way, so it is not counted
		// as a failed sample. It still costs us: too few readable samples fails.
		if (!lines) continue;
		attempted++;
		if (lines[m.line - 1]?.trim() === m.text.trim()) verified++;
	}

	return { attempted, verified };
}

/**
 * True when a block of `path:line:text` rows really is a search of this tree.
 *
 * Only the bash path uses this. `grep` and `find` results are searches by
 * definition — the tool name is the proof — but a `bash` result is whatever the
 * model chose to run, so the shape has to be earned rather than assumed.
 *
 * Two gates, cheap one first: the paths must resolve, and a sample of the rows
 * must carry the text those files really hold at those lines. Both are
 * mechanical properties of the output. Neither enumerates a tool, a command or
 * a message format, so nothing here rots when clang changes its diagnostic
 * wording or someone reaches for a grep clone this file has never heard of.
 *
 * Paths are resolved against `cwd` with no re-anchoring, which is correct only
 * because bash runs in the session cwd and prints paths relative to it.
 */
export function looksLikeSearchOutput(matches: GrepMatch[], cwd: string): boolean {
	if (matches.length === 0) return false;
	if (resolvedFraction(matchedFiles(matches), cwd) < MIN_RESOLVED_FRACTION) return false;

	const { attempted, verified } = verifyMatchedLines(matches, cwd);
	if (attempted < MIN_VERIFY_SAMPLE) return false;
	return verified / attempted >= MIN_VERIFIED_FRACTION;
}
