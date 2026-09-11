import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Citation {
	file: string;
	startLine: number;
	endLine: number;
}

export interface Quote {
	file: string;
	startLine: number;
	code: string;
}

// "1. `path` (lines 40-96) - desc" or "1. path (line 5) - desc"
const CITATION = /^\s*\d+\.\s+`?([^\s`]+)`?\s+\(lines?\s+(\d+)(?:\s*-\s*(\d+))?\)/gm;

/**
 * The `(lines A-B)` span of a citation entry on its own, so a rewrite can
 * replace the numbers without touching the index, the path, or the trailing
 * description the explorer wrote.
 */
const CITATION_RANGE = /\(lines?\s+\d+(?:\s*-\s*\d+)?\)/;

export function extractCitations(report: string): Citation[] {
	const out: Citation[] = [];
	CITATION.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CITATION.exec(report)) !== null) {
		const start = Number(m[2]);
		out.push({ file: m[1]!, startLine: start, endLine: m[3] ? Number(m[3]) : start });
	}
	return out;
}

const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
// An excerpt's anchor line, e.g. "// src/auth/session.ts:71". Group 1 is the
// comment prefix, kept so a rewritten anchor keeps the block's own style.
const HEADER = /^(\s*(?:\/\/|#)\s*)([^\s:]+):(\d+)\s*$/;

/**
 * A marker `reanchorReport` appended, stripped before the header is parsed.
 *
 * This has to be stripped rather than treated as "not a header". A marked block
 * that stops parsing as a quote disappears from the verifier's denominator, so
 * annotating a fabrication would raise the fidelity score by deleting the
 * evidence for it — the gate would report a clean run because we hid the
 * failures, which is worse than the failures.
 */
const UNVERIFIED_MARKER = / — UNVERIFIED:[^\n]*$/;

function parseHeader(line: string | undefined): RegExpExecArray | null {
	return HEADER.exec((line ?? "").replace(UNVERIFIED_MARKER, ""));
}

/**
 * One `// path:line` header inside a fenced block, with the code beneath it.
 *
 * `headerIndex` is the header's position in the block body, so `reanchorReport`
 * can rewrite that one line and leave every other byte of the block alone.
 */
interface Excerpt {
	headerIndex: number;
	prefix: string;
	file: string;
	startLine: number;
	code: string;
}

/**
 * Splits a fenced block's body into one excerpt per `// path:line` header.
 *
 * Models routinely group several related excerpts into ONE fence, each under its
 * own header. Reading only the first header made every later line — including
 * the literal text of the second header — part of a single quote, and that quote
 * can never match the file. An honest grouped excerpt was therefore scored as
 * fabricated: 5 of the 20 fabrications on the reference corpus were this.
 *
 * Every header-shaped line splits, with no attempt to tell our format apart from
 * a source comment that happens to look like one. The cost of guessing wrong is
 * real — a quote cut at a line that was genuinely part of the code loses that
 * line from verification, and if the comment names some other file the fragment
 * below it is checked against that file and reported as fabricated. The reason
 * to accept that risk is how rare the shape is. `HEADER` is anchored at both
 * ends and admits nothing but `path:number`, so the way code actually
 * cross-references a location — `// see src/foo.ts:12 for why` — does not match.
 * Scanning the 3.4M lines of the reference corpus for lines that do match found
 * zero. Against that, grouping was 5 of 189 blocks in one benchmark run and cost
 * 4 false fabrications.
 *
 * Nor is there a safe heuristic to reach for. Every rule that would suppress a
 * split — same file as the block header, ascending line numbers, must follow a
 * blank line — is one that real grouping also breaks, so it would reintroduce
 * the bug in exactly the cases it claimed to protect.
 */
function splitExcerpts(bodyLines: readonly string[]): Excerpt[] {
	const heads: { index: number; match: RegExpExecArray }[] = [];
	for (const [index, line] of bodyLines.entries()) {
		const match = parseHeader(line);
		if (match) heads.push({ index, match });
	}
	// A block that does not open with a header is not a cited block at all, and a
	// header found further down does not make it one.
	if (heads[0]?.index !== 0) return [];

	return heads.map(({ index, match }, i) => ({
		headerIndex: index,
		prefix: match[1]!,
		file: match[2]!,
		startLine: Number(match[3]),
		// Up to the next header, or the end of the block for the last excerpt. A
		// header with only blank lines under it yields an empty quote, which
		// `verifyQuote` rejects rather than counting as verified.
		code: bodyLines
			.slice(index + 1, heads[i + 1]?.index ?? bodyLines.length)
			.join("\n")
			.replace(/\n+$/, ""),
	}));
}

export function extractQuotes(report: string): Quote[] {
	const out: Quote[] = [];
	FENCE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FENCE.exec(report)) !== null) {
		for (const { file, startLine, code } of splitExcerpts(m[1]!.split("\n"))) {
			out.push({ file, startLine, code });
		}
	}
	return out;
}

export interface VerifyResult {
	valid: boolean;
	reason?: string;
	/** Line where the quoted content actually starts, when found. 1-based. */
	actualLine?: number;
	/** actualLine - startLine when the content was found elsewhere. */
	drift?: number;
}

function readLines(file: string, cwd: string): string[] | null {
	try {
		return readFileSync(resolve(cwd, file), "utf8").split("\n");
	} catch {
		return null;
	}
}

export function verifyCitation(c: Citation, cwd: string): VerifyResult {
	const lines = readLines(c.file, cwd);
	if (!lines) return { valid: false, reason: `file not found: ${c.file}` };
	if (c.startLine < 1 || c.endLine > lines.length || c.startLine > c.endLine) {
		return {
			valid: false,
			reason: `lines ${c.startLine}-${c.endLine} out of bounds for ${c.file} (${lines.length} lines)`,
		};
	}
	return { valid: true };
}

/** A non-blank line of a file, carrying the 1-based number it came from. */
interface AnchoredLine {
	text: string;
	line: number;
}

/**
 * Blank lines are dropped and the rest trimmed on both sides of the comparison.
 * Models reflow indentation and insert or drop blank lines when they copy;
 * penalising that reports a hallucination where none happened.
 */
function anchoredLines(lines: string[]): AnchoredLine[] {
	const out: AnchoredLine[] = [];
	for (const [index, line] of lines.entries()) {
		const text = line.trim();
		if (text.length > 0) out.push({ text, line: index + 1 });
	}
	return out;
}

function normalizeQuote(code: string): string[] {
	return code
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Finds where `needle` really starts, or null if it is nowhere in the file.
 *
 * Two rules, in order:
 *  1. If an occurrence begins exactly at `statedLine`, that one wins. A quote of
 *     something that repeats in the file (a common import, a closing brace) must
 *     not be "corrected" backwards onto an earlier copy when the anchor it gave
 *     was right all along.
 *  2. Otherwise the FIRST occurrence in the file is the answer. With the stated
 *     anchor already known to be wrong there is nothing to prefer a later copy
 *     by, and a fixed rule keeps re-anchoring deterministic and reproducible.
 */
function locateQuote(needle: string[], haystack: AnchoredLine[], statedLine: number): number | null {
	let first: number | null = null;
	for (let i = 0; i + needle.length <= haystack.length; i++) {
		let matched = true;
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j]!.text !== needle[j]) {
				matched = false;
				break;
			}
		}
		if (!matched) continue;
		const line = haystack[i]!.line;
		if (line === statedLine) return line;
		if (first === null) first = line;
	}
	return first;
}

/**
 * Answers "is this code real?" — deliberately not "did the explorer count lines
 * right?".
 *
 * Those are different defects with very different stakes. Invented code is a
 * serious harm: the caller reasons from fiction. A line anchor that is off by
 * six costs the caller one extra read. Conflating them produced a 31% fidelity
 * score on the reference corpus that said nothing about how much of the output
 * could be trusted: of the 131 failures, 111 were drift and 20 were invention.
 *
 * So the whole file is searched, not just the stated line. Content found
 * anywhere is valid, with `drift` reporting how far off the anchor was;
 * `reanchorReport` is what turns that drift into a corrected citation.
 */
export function verifyQuote(q: Quote, cwd: string): VerifyResult {
	const lines = readLines(q.file, cwd);
	if (!lines) return { valid: false, reason: `file not found: ${q.file}` };

	const quoted = normalizeQuote(q.code);
	// A header with no code body is a malformed citation, not a verified one.
	if (quoted.length === 0) {
		return { valid: false, reason: `empty quote for ${q.file}:${q.startLine}` };
	}

	const actualLine = locateQuote(quoted, anchoredLines(lines), q.startLine);
	if (actualLine === null) {
		return {
			valid: false,
			reason: `fabricated: quoted code appears nowhere in ${q.file} (header said line ${q.startLine})`,
		};
	}
	return { valid: true, actualLine, drift: actualLine - q.startLine };
}

export interface ReanchorResult {
	report: string;
	/**
	 * Anchors rewritten to their verified line — fence headers, plus the
	 * `## Files Retrieved` entries those headers pinned down.
	 */
	corrected: number;
	/** Quote blocks marked UNVERIFIED because the code was not found on disk. */
	fabricated: number;
}

/**
 * Appended to a fence header we could not confirm. It has to sit on the header
 * line itself: the caller decides whether to trust a block while looking at that
 * block, so a warning collected somewhere else is a warning it will not read.
 */
const UNVERIFIED_NOT_FOUND = " — UNVERIFIED: not found in file";
const UNVERIFIED_NO_FILE = " — UNVERIFIED: file not found";

/**
 * Records the verified start line for a stated `file:line` anchor.
 *
 * Two blocks that state the same anchor but resolve to different lines make the
 * truth unknowable for any citation entry keyed on it, so the entry is poisoned
 * with null rather than resolved by arbitrary precedence.
 */
function recordAnchor(into: Map<string, number | null>, key: string, line: number | null): void {
	if (into.has(key) && into.get(key) !== line) into.set(key, null);
	else into.set(key, line);
}

function countLines(file: string, cwd: string): number | null {
	return readLines(file, cwd)?.length ?? null;
}

/**
 * Shifts `## Files Retrieved` ranges whose start line a quote block pinned down.
 *
 * An entry is only touched when a verified quote stated the same `file:line`.
 * Anything else — no quote for that anchor, or two quotes that disagreed — is
 * left exactly as written. Guessing the range is the behaviour this whole change
 * exists to stop.
 */
function reanchorCitations(
	report: string,
	cwd: string,
	verified: ReadonlyMap<string, number | null>,
): { report: string; corrected: number } {
	let out = "";
	let cursor = 0;
	let corrected = 0;
	CITATION.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CITATION.exec(report)) !== null) {
		const file = m[1]!;
		const start = Number(m[2]);
		const end = m[3] ? Number(m[3]) : start;
		const trueStart = verified.get(`${file}:${start}`);
		if (typeof trueStart !== "number" || trueStart === start) continue;

		const delta = trueStart - start;
		const limit = countLines(file, cwd) ?? end + delta;
		// The end line is not independently verified. It rides the same delta so
		// the span keeps its length, clamped so a shift cannot push a citation
		// that was in bounds past the end of the file.
		const trueEnd = Math.max(trueStart, Math.min(end + delta, limit));
		const range = m[3] ? `(lines ${trueStart}-${trueEnd})` : `(line ${trueStart})`;

		out += report.slice(cursor, m.index) + m[0].replace(CITATION_RANGE, range);
		cursor = m.index + m[0].length;
		corrected++;
	}
	return { report: out + report.slice(cursor), corrected };
}

/**
 * Rewrites a report's anchors to the lines its quoted code actually occupies,
 * and marks the blocks whose code is not on disk at all.
 *
 * This runs at request time, not only in the benchmark, because the caller acts
 * on these anchors — it reads the lines they name. Shipping a drifted anchor is
 * not a missed opportunity to help, it is an instruction to look in the wrong
 * place. Correcting drift silently is right: the content is verbatim and the
 * corrected anchor is verified, so there is nothing for the caller to second
 * guess. Fabrication is the opposite and must stay visible, so the code is left
 * intact — the caller may still recognise it — under a header that says plainly
 * we could not find it.
 *
 * Re-running this on its own output is stable: an existing marker is stripped
 * before the header is re-read, so a block is re-marked with the same text
 * rather than accumulating markers. The counts describe what the pass found,
 * not what it changed, so a second pass still reports blocks that are still
 * unverifiable.
 */
export function reanchorReport(report: string, cwd: string): ReanchorResult {
	const verified = new Map<string, number | null>();
	let corrected = 0;
	let fabricated = 0;
	let out = "";
	let cursor = 0;

	FENCE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FENCE.exec(report)) !== null) {
		const body = m[1]!;
		const bodyLines = body.split("\n");
		// Not a cited block. Leave it byte-for-byte alone.
		const excerpts = splitExcerpts(bodyLines);
		if (excerpts.length === 0) continue;

		// Each excerpt is judged on its own and only its own header line is
		// touched, so one unverifiable excerpt cannot mark the honest ones beside
		// it and every other byte of the block survives unchanged.
		const rewritten = [...bodyLines];
		let changed = false;
		for (const { headerIndex, prefix, file, startLine, code } of excerpts) {
			const result = verifyQuote({ file, startLine, code }, cwd);
			const key = `${file}:${startLine}`;

			if (result.valid && result.actualLine !== undefined) {
				recordAnchor(verified, key, result.actualLine);
				if (result.drift !== 0) {
					rewritten[headerIndex] = `${prefix}${file}:${result.actualLine}`;
					corrected++;
					changed = true;
				}
			} else if (result.reason?.startsWith("empty quote")) {
				// A header with no body: nothing to verify, and nothing for the
				// caller to be misled by either. Marking it would be noise,
				// correcting it would be a guess.
			} else {
				recordAnchor(verified, key, null);
				const marker = result.reason?.startsWith("file not found")
					? UNVERIFIED_NO_FILE
					: UNVERIFIED_NOT_FOUND;
				rewritten[headerIndex] =
					bodyLines[headerIndex]!.replace(UNVERIFIED_MARKER, "").replace(/\s+$/, "") + marker;
				fabricated++;
				changed = true;
			}
		}
		if (!changed) continue;

		// m[0] is `opening fence line + body + "```"`, so this recovers the
		// opening fence with its language tag intact.
		const openLine = m[0].slice(0, m[0].length - body.length - 3);
		out += report.slice(cursor, m.index);
		out += `${openLine}${rewritten.join("\n")}\`\`\``;
		cursor = m.index + m[0].length;
	}
	out += report.slice(cursor);

	const entries = reanchorCitations(out, cwd, verified);
	return { report: entries.report, corrected: corrected + entries.corrected, fabricated };
}
