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
 *
 * Every keyword the marker can open with is listed here, so adding a verdict
 * without extending this alternation is the exact regression described above.
 */
const VERDICT_MARKER = / — (?:UNVERIFIED|PARTIAL|MISATTRIBUTED):[^\n]*$/;

function parseHeader(line: string | undefined): RegExpExecArray | null {
	return HEADER.exec((line ?? "").replace(VERDICT_MARKER, ""));
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

/**
 * What actually happened to a quote, in descending order of trust.
 *
 * Everything except `exact` and `drifted` used to be one bucket called
 * "fabricated". On the reference corpus that bucket was 16 of 202 quotes (7.9%)
 * and only 2 of those 16 were invention: the rest were a model clipping a
 * comment, skipping a line, re-wrapping prose, or naming the wrong file. A gate
 * at 7.9% that fires overwhelmingly on benign truncation is a gate everybody
 * learns to override, and then it stops protecting anything. These verdicts
 * exist so the gate can be set on the failures that actually mean the caller is
 * being told something untrue.
 *
 *  - exact          verbatim, at the line the header claimed
 *  - drifted        verbatim, somewhere else in the cited file
 *  - truncated      each quoted line is a PREFIX of the corresponding file
 *                   line, in sequence. The model stopped mid-line; every
 *                   character it did show is real
 *  - elided         each quoted line is present in order within one region of
 *                   the file, but file lines in between were silently dropped
 *  - reflowed       an all-comment quote whose prose is a contiguous substring
 *                   of one comment block's prose, re-wrapped across different
 *                   line breaks. Same words, different line endings
 *  - misattributed  absent from the cited file, found verbatim in another file
 *                   the same report cites
 *  - fabricated     found nowhere. The model wrote it
 *  - missing-file   the cited path does not exist
 *  - empty          a header with no code under it; malformed, not verified
 */
export type QuoteVerdict =
	| "exact"
	| "drifted"
	| "truncated"
	| "elided"
	| "reflowed"
	| "misattributed"
	| "fabricated"
	| "missing-file"
	| "empty";

/**
 * Verdicts under which every character the caller can read is real content of
 * the cited file. That is what `valid` has always meant here — "is this code
 * real?", not "did the explorer count lines right?" — so truncation, elision
 * and reflow join drift on the true side: they are incomplete quotes of real
 * code, and the caller reasoning from the text it can see is reasoning from the
 * file. Misattribution and fabrication are false because in both the cited file
 * does not contain what the report says it contains. Keeping the boundary there
 * means `!valid` IS the release gate, with nothing further to subtract.
 */
const CONTENT_IS_REAL: ReadonlySet<QuoteVerdict> = new Set<QuoteVerdict>([
	"exact",
	"drifted",
	"truncated",
	"elided",
	"reflowed",
]);

/**
 * A citation entry names a line RANGE, not content, so the only thing that can
 * be checked is whether the range exists. There is no verdict to report because
 * there is no quoted text to classify.
 */
export interface CitationResult {
	valid: boolean;
	reason?: string;
}

export interface VerifyResult extends CitationResult {
	verdict: QuoteVerdict;
	/**
	 * Line where the quoted content actually starts, when found. 1-based, and in
	 * `actualFile` whenever that is set rather than in the file the quote named.
	 */
	actualLine?: number;
	/** actualLine - startLine when the content was found elsewhere. */
	drift?: number;
	/** The file the content really lives in. Only set for `misattributed`. */
	actualFile?: string;
}

/** Reads a file's lines, or null if it cannot be read. */
type LineReader = (file: string) => string[] | null;

function readLines(file: string, cwd: string): string[] | null {
	try {
		return readFileSync(resolve(cwd, file), "utf8").split("\n");
	} catch {
		return null;
	}
}

/**
 * A reader that reads each path at most once.
 *
 * `reanchorReport` verifies every excerpt in a report against an overlapping
 * handful of files, and the misattribution search re-reads that same handful.
 * Without a cache the cost of the search would scale with quotes × files
 * instead of files, which is the difference between free and noticeable inside
 * a user's agent turn.
 */
function cachedReader(cwd: string): LineReader {
	const cache = new Map<string, string[] | null>();
	return (file) => {
		// `null` is a cached miss and must not be re-read; only `undefined` means
		// this path has never been tried.
		const cached = cache.get(file);
		if (cached !== undefined) return cached;
		const lines = readLines(file, cwd);
		cache.set(file, lines);
		return lines;
	};
}

export function verifyCitation(c: Citation, cwd: string): CitationResult {
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
 * Shortest quoted line that may be admitted as a STRICT prefix of a file line.
 *
 * This is the number that decides whether the prefix rule stays a truncation
 * detector or degrades into a fuzzy matcher, so it is set from the corpus
 * rather than by taste. The shortest genuine truncation on the reference corpus
 * is `// cleanly.` — 11 characters, where the file continues `// cleanly.
 * No-ops when contentReplacementState is undefined (feature off).` The shortest
 * thing that must NEVER match is the punctuation every file is full of: a lone
 * `//`, a lone asterisk, a block-comment close, `}`, `});`, `return`. Eight
 * sits above all of those and below the real case with room to spare, and
 * unlike a proportional rule it does not care that `// cleanly.` is only 15% of
 * the line it came from.
 *
 * This bound is per line. It is not sufficient on its own — see
 * MIN_MATCHED_CHARS — because eight characters repeated over a few lines is
 * still not evidence of anything.
 */
const MIN_PREFIX_CHARS = 8;

/**
 * Total quoted characters that must match before a partial match counts at all.
 *
 * The per-line bound stops `//` matching every comment; this one stops a quote
 * BUILT from short lines doing the same. A quote of `// cleanly.` on its own is
 * 11 characters and gets no benefit of the doubt — it is only ever read as
 * truncation when it arrives as the tail of lines that matched in full.
 */
const MIN_MATCHED_CHARS = 24;

/** How a single quoted line lines up against a single file line. */
type LineMatch = "exact" | "prefix" | null;

function matchLine(quoted: string, actual: string): LineMatch {
	if (quoted === actual) return "exact";
	if (actual.startsWith(quoted) && quoted.length >= MIN_PREFIX_CHARS) return "prefix";
	return null;
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
 * Finds a run of consecutive file lines that `needle` is a line-by-line prefix
 * of, with at least one line strictly shorter than the file's.
 *
 * Consecutive is the whole point. Every quoted line has to sit against the file
 * line directly under the previous one, so this cannot wander: it reads exactly
 * like `locateQuote` except that a quoted line is allowed to stop early. That is
 * what a model clipping a re-wrapped comment produces, and it is nothing like
 * what invention produces — a renamed identifier or a flipped operator breaks
 * the prefix on that line and the run dies there.
 */
function locateTruncated(
	needle: string[],
	haystack: AnchoredLine[],
	statedLine: number,
): number | null {
	let first: number | null = null;
	for (let i = 0; i + needle.length <= haystack.length; i++) {
		let chars = 0;
		let clipped = false;
		let ok = true;
		for (let j = 0; j < needle.length; j++) {
			const kind = matchLine(needle[j]!, haystack[i + j]!.text);
			if (kind === null) {
				ok = false;
				break;
			}
			if (kind === "prefix") clipped = true;
			chars += needle[j]!.length;
		}
		// No clipped line at all means this is an exact match, which `locateQuote`
		// already had its chance at; reporting it here would relabel a clean quote.
		if (!ok || !clipped || chars < MIN_MATCHED_CHARS) continue;
		const line = haystack[i]!.line;
		if (line === statedLine) return line;
		if (first === null) first = line;
	}
	return first;
}

/**
 * Finds a region of the file whose lines the quote reproduces in order, having
 * dropped some of them.
 *
 * Bounded two ways, and both bounds matter. The search window is twice the
 * quote's length, so at most half the region may be missing — a quote that
 * skipped more than it kept is not a model omitting a line, it is a model
 * assembling an excerpt out of scattered fragments, which misleads a reader far
 * more than it informs one and belongs in the untrusted bucket. And every line
 * still has to match under `matchLine`, so the omitted lines are the only
 * liberty taken: nothing inserted, nothing reordered, nothing reworded.
 *
 * Quotes under three lines are refused outright. Two lines cannot demonstrate
 * an omission — there is no middle — so admitting them would only widen the
 * rule for no gain.
 */
function locateElided(
	needle: string[],
	haystack: AnchoredLine[],
	statedLine: number,
): number | null {
	if (needle.length < 3) return null;
	let first: number | null = null;
	for (let i = 0; i < haystack.length; i++) {
		if (matchLine(needle[0]!, haystack[i]!.text) === null) continue;
		const windowEnd = Math.min(haystack.length, i + needle.length * 2);
		let cursor = i;
		let chars = 0;
		let skipped = false;
		let ok = true;
		for (const quoted of needle) {
			let found = -1;
			for (let k = cursor; k < windowEnd; k++) {
				if (matchLine(quoted, haystack[k]!.text) !== null) {
					found = k;
					break;
				}
			}
			if (found < 0) {
				ok = false;
				break;
			}
			if (found > cursor) skipped = true;
			chars += quoted.length;
			cursor = found + 1;
		}
		// Without a skip this is the contiguous case the two rules above own.
		if (!ok || !skipped || chars < MIN_MATCHED_CHARS) continue;
		const line = haystack[i]!.line;
		if (line === statedLine) return line;
		if (first === null) first = line;
	}
	return first;
}

/**
 * The comment opener a line begins with, if it begins with one at all.
 *
 * Deliberately covers only line starts. A `//` in the middle of a string
 * literal is not a comment and must not be treated as one, because the reflow
 * rule below compares prose and would then be comparing code.
 */
const COMMENT_OPENER = /^(?:\/\/+|\/\*+|\*+\/|\*+|#+)\s?/;

/** The prose of a comment line with its marker removed, or null if not one. */
function commentProse(line: string): string | null {
	if (!COMMENT_OPENER.test(line)) return null;
	return line
		.replace(COMMENT_OPENER, "")
		.replace(/\*+\/\s*$/, "")
		.trim()
		.replace(/\s+/g, " ");
}

/**
 * Shortest prose that may be matched across re-wrapped lines.
 *
 * Forty characters is six to eight words — long enough that the sentence is
 * specific to one comment block, where a fragment like `returns the result`
 * would match a dozen. The real reflows on the corpus run 150 to 300
 * characters, so this is not a threshold they sit near.
 */
const MIN_PROSE_CHARS = 40;

/**
 * Finds an all-comment quote whose wording is a contiguous run of one comment
 * block's wording, laid out over different line breaks.
 *
 * This is the one rule that stops comparing line to line, so it is fenced in
 * hard. Every quoted line must be a comment — a single line of code and the
 * rule declines — and the file side is only ever a MAXIMAL RUN of consecutive
 * comment lines, never the file's comments as a whole, so wording cannot be
 * stitched together out of two comments that happen to sit in the same file.
 * What remains admissible is exactly: the same words, in the same order, with
 * the line breaks somewhere else.
 *
 * Matching ignores case, and only here. A model that clips a comment mid-way
 * capitalises the fragment it kept into a sentence — the corpus has `the budget
 * must group` where the file reads `The budget must group` — and prose whose
 * only difference from the file is a capital letter is not something a caller
 * can be misled by. At forty-plus characters case adds no discriminating power
 * worth the false accusation.
 */
function locateReflow(needle: string[], haystack: AnchoredLine[]): number | null {
	const parts: string[] = [];
	for (const line of needle) {
		const prose = commentProse(line);
		if (prose === null) return null;
		if (prose) parts.push(prose);
	}
	const quoted = parts.join(" ").toLowerCase();
	if (quoted.length < MIN_PROSE_CHARS) return null;

	for (let i = 0; i < haystack.length; ) {
		if (commentProse(haystack[i]!.text) === null) {
			i++;
			continue;
		}
		// One maximal run of consecutive comment lines, joined, remembering where
		// in the joined text each contributing line began so a hit can be reported
		// as a line number.
		let joined = "";
		const starts: { at: number; line: number }[] = [];
		let end = i;
		for (; end < haystack.length; end++) {
			const prose = commentProse(haystack[end]!.text);
			if (prose === null) break;
			if (!prose) continue;
			if (joined) joined += " ";
			starts.push({ at: joined.length, line: haystack[end]!.line });
			joined += prose;
		}
		const at = joined.toLowerCase().indexOf(quoted);
		if (at >= 0) {
			let line = starts[0]?.line;
			for (const start of starts) if (start.at <= at) line = start.line;
			if (line !== undefined) return line;
		}
		i = end + 1;
	}
	return null;
}

export interface VerifyOptions {
	/**
	 * Repo-relative paths to search when the quote is absent from the file it
	 * named. Empty by default, so misattribution is never looked for unless a
	 * caller supplies the candidates.
	 *
	 * `reanchorReport` passes the other files the same report cites, which is the
	 * scope this was measured against: it found both misattributions on the
	 * reference corpus for 0.7ms per report, indistinguishable from not searching
	 * at all, where sweeping the whole 2,167-file repo cost 28ms per report — 40x
	 * more — and found exactly the same two. The scope is not a compromise to
	 * save time, it is where the error comes from: an explorer misattributes
	 * between two files it had open at once, and it cites both.
	 */
	readonly searchFiles?: readonly string[];
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
 *
 * The same argument then applies a second time, one level down. "Not verbatim
 * anywhere in the file" was itself three defects wearing one name: a quote
 * clipped mid-line, a quote missing a line, and a quote of code that does not
 * exist. `verdict` separates them, and the rules are tried strongest evidence
 * first so a quote is always described by the best thing true of it — in
 * particular a quote present in the cited file, in any form, can never come
 * back as `misattributed`, which is only ever reached once the cited file has
 * been ruled out entirely.
 */
export function verifyQuote(q: Quote, cwd: string, options?: VerifyOptions): VerifyResult {
	return verifyQuoteWith(q, cachedReader(cwd), options?.searchFiles ?? []);
}

function verifyQuoteWith(
	q: Quote,
	read: LineReader,
	searchFiles: readonly string[],
): VerifyResult {
	const lines = read(q.file);
	if (!lines) {
		return { valid: false, verdict: "missing-file", reason: `file not found: ${q.file}` };
	}

	const quoted = normalizeQuote(q.code);
	// A header with no code body is a malformed citation, not a verified one.
	if (quoted.length === 0) {
		return {
			valid: false,
			verdict: "empty",
			reason: `empty quote for ${q.file}:${q.startLine}`,
		};
	}

	const haystack = anchoredLines(lines);
	const found = (verdict: QuoteVerdict, actualLine: number, reason?: string): VerifyResult => ({
		valid: CONTENT_IS_REAL.has(verdict),
		verdict,
		actualLine,
		drift: actualLine - q.startLine,
		...(reason === undefined ? {} : { reason }),
	});

	const exact = locateQuote(quoted, haystack, q.startLine);
	if (exact !== null) return found(exact === q.startLine ? "exact" : "drifted", exact);

	const truncated = locateTruncated(quoted, haystack, q.startLine);
	if (truncated !== null) {
		return found(
			"truncated",
			truncated,
			`truncated: every quoted line is a prefix of ${q.file}:${truncated} onward, at least one cut short`,
		);
	}

	const elided = locateElided(quoted, haystack, q.startLine);
	if (elided !== null) {
		return found(
			"elided",
			elided,
			`elided: quoted lines appear in order from ${q.file}:${elided}, with file lines skipped between them`,
		);
	}

	const reflowed = locateReflow(quoted, haystack);
	if (reflowed !== null) {
		return found(
			"reflowed",
			reflowed,
			`reflowed: the comment at ${q.file}:${reflowed} has this wording, re-wrapped across different lines`,
		);
	}

	// Only exact, contiguous matches count here. Misattribution is an accusation
	// about a specific other file, and the weaker rules above exist to excuse a
	// quote, not to relocate one; a quote that merely resembles something in a
	// sibling tells us nothing and stays fabricated.
	//
	// `q.startLine` is still passed through because the stated line is often the
	// one thing the model got right — both misattributions on the reference
	// corpus named the correct line of the wrong file — so an occurrence sitting
	// exactly there is preferred over an earlier one.
	for (const candidate of searchFiles) {
		if (candidate === q.file) continue;
		const other = read(candidate);
		if (!other) continue;
		const at = locateQuote(quoted, anchoredLines(other), q.startLine);
		if (at === null) continue;
		return {
			valid: false,
			verdict: "misattributed",
			actualFile: candidate,
			actualLine: at,
			reason: `misattributed: this code is not in ${q.file}; it is in ${candidate}:${at}`,
		};
	}

	return {
		valid: false,
		verdict: "fabricated",
		reason: `fabricated: quoted code appears nowhere in ${q.file} (header said line ${q.startLine})`,
	};
}

export interface ReanchorResult {
	report: string;
	/**
	 * Anchors rewritten to their verified line — fence headers, plus the
	 * `## Files Retrieved` entries those headers pinned down.
	 */
	corrected: number;
	/**
	 * Quote blocks marked UNVERIFIED because the code was not found on disk:
	 * invented, or a file that is not there. This is the release gate, and it no
	 * longer includes truncation, elision, reflow or misattribution — the first
	 * three because the content is real, the fourth because it is counted
	 * separately below and demands a different response.
	 */
	fabricated: number;
	/**
	 * Blocks whose code was found verbatim in a DIFFERENT file the report cites.
	 *
	 * Counted apart from `fabricated` because it is a different failure with a
	 * worse shape. Invented code often reads as invented. Misattributed code is
	 * real, compiles, and matches the surrounding discussion, so nothing about it
	 * looks wrong — and it still sends the caller to a file that does not contain
	 * it. Folding it into `fabricated` would hide the more dangerous number
	 * inside the less dangerous one.
	 */
	misattributed: number;
	/** Blocks marked PARTIAL: clipped, elided or re-wrapped. Real, incomplete. */
	partial: number;
}

/**
 * Appended to a fence header we could not confirm. It has to sit on the header
 * line itself: the caller decides whether to trust a block while looking at that
 * block, so a warning collected somewhere else is a warning it will not read.
 *
 * One marker per verdict rather than one marker for everything. The caller's
 * correct response differs: PARTIAL means read the block and then go read the
 * rest of the lines, UNVERIFIED means do not believe the block, MISATTRIBUTED
 * means believe the code and disbelieve the path. A single UNVERIFIED across all
 * of them tells a caller to throw away twelve good excerpts to catch one bad
 * one, which is how a warning trains people to ignore it.
 */
const UNVERIFIED_NOT_FOUND = " — UNVERIFIED: not found in file";
const UNVERIFIED_NO_FILE = " — UNVERIFIED: file not found";
const PARTIAL_TRUNCATED = " — PARTIAL: lines clipped; the text shown is verbatim";
const PARTIAL_ELIDED = " — PARTIAL: lines omitted; the text shown is verbatim";
const PARTIAL_REFLOWED = " — PARTIAL: comment re-wrapped; the wording is verbatim";

/**
 * The note for a verdict, or null when the block needs no note.
 *
 * Misattribution names the file the code is really in, because that is the one
 * thing the caller needs and cannot recover from the block. The header's own
 * path is left as the model wrote it: rewriting a path would be inventing a
 * finding on the model's behalf, which is a worse habit than the error it fixes.
 */
function verdictMarker(result: VerifyResult): string | null {
	switch (result.verdict) {
		case "exact":
		case "drifted":
		// A header with no body: nothing to verify, and nothing for the caller to
		// be misled by either. Marking it would be noise, correcting it a guess.
		case "empty":
			return null;
		case "truncated":
			return PARTIAL_TRUNCATED;
		case "elided":
			return PARTIAL_ELIDED;
		case "reflowed":
			return PARTIAL_REFLOWED;
		case "misattributed":
			return ` — MISATTRIBUTED: this code is in ${result.actualFile}:${result.actualLine}, not here`;
		case "missing-file":
			return UNVERIFIED_NO_FILE;
		case "fabricated":
			return UNVERIFIED_NOT_FOUND;
	}
}

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

/**
 * Every file the report names, as a quote header or a `## Files Retrieved`
 * entry — the search scope for misattribution. See `VerifyOptions.searchFiles`
 * for why this scope and not the repo.
 */
function citedFiles(report: string): string[] {
	const files = new Set<string>();
	for (const c of extractCitations(report)) files.add(c.file);
	for (const q of extractQuotes(report)) files.add(q.file);
	return [...files];
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
	read: LineReader,
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
		const limit = read(file)?.length ?? end + delta;
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
 * and notes on each block what verifying it actually found.
 *
 * This runs at request time, not only in the benchmark, because the caller acts
 * on these anchors — it reads the lines they name. Shipping a drifted anchor is
 * not a missed opportunity to help, it is an instruction to look in the wrong
 * place. Correcting drift silently is right: the content is verbatim and the
 * corrected anchor is verified, so there is nothing for the caller to second
 * guess. Anything less than verbatim is not silent, and the note says which
 * kind of "less" it was, because those call for different things from a reader.
 * A clipped or re-wrapped excerpt can be reasoned from — every character in it
 * is the file's — it just is not the whole line; a fabricated one cannot be.
 * Code is never discarded in either case, since the caller may still recognise
 * it; what changes is what the header claims about it.
 *
 * Re-running this on its own output is stable: an existing marker is stripped
 * before the header is re-read, so a block is re-marked with the same text
 * rather than accumulating markers, and a header already corrected re-verifies
 * at zero drift. The counts describe what the pass found, not what it changed,
 * so a second pass still reports blocks that are still unverifiable.
 */
export function reanchorReport(report: string, cwd: string): ReanchorResult {
	const verified = new Map<string, number | null>();
	const read = cachedReader(cwd);
	const searchFiles = citedFiles(report);
	let corrected = 0;
	let fabricated = 0;
	let misattributed = 0;
	let partial = 0;
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
			const result = verifyQuoteWith({ file, startLine, code }, read, searchFiles);
			const key = `${file}:${startLine}`;
			// An anchor is only recorded when the content is in the file the header
			// names. Misattribution has a real line number attached and it belongs
			// to another file, so feeding it to the citation rewriter would move a
			// `Files Retrieved` range onto a line of a file nobody verified.
			const anchored = CONTENT_IS_REAL.has(result.verdict) ? result.actualLine : undefined;
			if (anchored !== undefined) recordAnchor(verified, key, anchored);
			else if (result.verdict !== "empty") recordAnchor(verified, key, null);

			let header = bodyLines[headerIndex]!.replace(VERDICT_MARKER, "").replace(/\s+$/, "");
			if (anchored !== undefined && result.drift !== 0) {
				header = `${prefix}${file}:${anchored}`;
				corrected++;
			}
			header += verdictMarker(result) ?? "";
			if (header !== bodyLines[headerIndex]) {
				rewritten[headerIndex] = header;
				changed = true;
			}

			switch (result.verdict) {
				case "misattributed":
					misattributed++;
					break;
				case "fabricated":
				case "missing-file":
					fabricated++;
					break;
				case "truncated":
				case "elided":
				case "reflowed":
					partial++;
					break;
				case "exact":
				case "drifted":
				case "empty":
					break;
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

	const entries = reanchorCitations(out, read, verified);
	return {
		report: entries.report,
		corrected: corrected + entries.corrected,
		fabricated,
		misattributed,
		partial,
	};
}
