import { readFileSync, statSync } from "node:fs";
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

/**
 * The opening of a fenced block: a run of three or more backticks or tildes, an
 * info string, and the newline that ends the line.
 *
 * Tildes are here because CommonMark admits them and some models prefer them. A
 * `~~~` block used to be invisible to this parser — which did not mean its
 * excerpts went unverified and were flagged, it meant they went unverified and
 * were NOT flagged, because a quote nobody extracted is a quote nobody can
 * report on. Two shapes producing `quotes=0, fabricated=0, no marker` is the
 * failure this whole module exists to make impossible.
 */
const FENCE_OPEN = /(`{3,}|~{3,})[^\n]*\n/g;
/** Closing-run scanners, one per fence character. See `scanFences`. */
const BACKTICK_RUN = /`{3,}/g;
const TILDE_RUN = /~{3,}/g;

/**
 * An excerpt's anchor line, e.g. `// src/auth/session.ts:71`.
 *
 * Group 1 is the comment opener together with its spacing, kept so a rewritten
 * anchor keeps the block's own style. Group 4 is the closing marker of a
 * two-sided comment (an HTML `-->` or a C block-comment close), kept for the
 * same reason: an HTML excerpt is headed `<!-- page.html:12 -->`, and rewriting
 * that to `<!-- page.html:14` would hand the caller a broken comment.
 *
 * The opener set is `//`, `#`, `--`, `;`, `%`, `<!--` and `/*`. It was `//` and
 * `#` alone, which is every language whose line comment this project's own
 * corpus happens to use and no others: on a SQL, Lua, Haskell, HTML, CSS, Lisp,
 * assembly, MATLAB or LaTeX repository EVERY block was unparseable, so quote
 * verification was a no-op that reported 100% fidelity because it had checked
 * nothing.
 *
 * The set is a judgement, and the risk it trades against is splitting a block on
 * a line of prose that merely looks like a header — which costs a false
 * `fabricated` on the fragment below the split. Three things bound that risk.
 * The pattern is anchored at both ends and admits nothing but `path:number`, so
 * the way source actually cross-references a location (`-- see foo.sql:12 for
 * why`) does not match. Times do not match either: `-- 10:30:00` leaves `:00`
 * unconsumed. And it was measured — scanning 3.13M lines (551,564 of the
 * TypeScript reference corpus, 981,272 of five polyglot repositories and this
 * package's `node_modules`, and 1,599,778 across 10,349 `.sql`/`.lua`/`.hs`/
 * `.html`/`.css`/`.el`/`.tex`/`.m`/`.vim`/`.asm`/`.clj`/`.lisp`/`.scm`/`.erl`/
 * `.ex`/`.pl`/`.ini`/`.xml`/`.svg` files) found **zero** lines matching this
 * pattern that did not already match the narrow one.
 *
 * Three markers were deliberately left out, all of them one character wide and
 * all of them common as the first character of something that is not a comment:
 * `'` (VB — also a string opener), `!` (Fortran — also negation, and `#!`), and
 * a bare `*` (no language's line comment, only a block-comment continuation, and
 * ` * src/foo.ts:12` is a plausible line INSIDE a real JSDoc block). Their
 * languages are rare enough in a coding-agent corpus that admitting them buys
 * less than the splits they could cause. `/*` is in because C, CSS and Java
 * block comments are not rare, and it is two characters.
 */
const HEADER = /^(\s*(?:\/\/+|#+|-{2,}|;+|%+|<!--|\/\*+)\s*)([^\s:]+):(\d+)\s*(-->|\*\/|-{2,})?\s*$/;

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
const VERDICT_MARKER = / — (?:UNVERIFIED|PARTIAL|MISATTRIBUTED|UNCHECKED):[^\n]*$/;

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
	/** The closing marker of a two-sided comment, or "" — see `HEADER`. */
	suffix: string;
	code: string;
}

/**
 * One fenced block, with the delimiters it was actually written with.
 *
 * `close` is "" for a block whose fence is never closed. That case is kept
 * rather than dropped because dropping it is precisely how a truncated report
 * used to ship unverified excerpts with a clean bill of health: the parser saw
 * no block, so the checker had nothing to object to. Every consumer here has to
 * decide what to do about `close === ""`, and none of them may decide "nothing".
 */
interface FencedBlock {
	/** Offset of the first character after the opening line. */
	bodyStart: number;
	/** The text between the fences; for an unclosed fence, the rest of the report. */
	body: string;
	/** The closing delimiter verbatim, or "" when the block is never closed. */
	close: string;
	/** Offset just past the closing delimiter, or the end of the report. */
	end: number;
}

/**
 * Every fenced block in a report, in order, closed or not.
 *
 * A block is closed by the next run of three-or-more of its OWN fence character,
 * so a tilde block cannot be closed by backticks. Matching the run rather than
 * the exact opening string keeps the old regex's tolerance of a four-backtick
 * fence closed with three (and the reverse), and re-emitting `close` verbatim
 * means a rewrite puts back exactly what it took out.
 *
 * A fence with no closer swallows the rest of the report by definition, so the
 * scan stops there: anything after it is inside it.
 */
function scanFences(report: string): FencedBlock[] {
	const blocks: FencedBlock[] = [];
	FENCE_OPEN.lastIndex = 0;
	let open: RegExpExecArray | null;
	while ((open = FENCE_OPEN.exec(report)) !== null) {
		const bodyStart = open.index + open[0].length;
		const runs = open[1]!.startsWith("`") ? BACKTICK_RUN : TILDE_RUN;
		runs.lastIndex = bodyStart;
		const closer = runs.exec(report);
		const close = closer?.[0] ?? "";
		blocks.push({
			bodyStart,
			body: report.slice(bodyStart, closer?.index ?? report.length),
			close,
			end: closer === null ? report.length : closer.index + close.length,
		});
		if (closer === null) break;
		FENCE_OPEN.lastIndex = closer.index + close.length;
	}
	return blocks;
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
 * zero, and re-scanning 3.13M lines including 1.6M of the languages the widened
 * marker set added found zero more. Against that, grouping was 5 of 189 blocks
 * in one benchmark run and cost 4 false fabrications.
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
		suffix: match[4] ?? "",
		// Up to the next header, or the end of the block for the last excerpt. A
		// header with only blank lines under it yields an empty quote, which
		// `verifyQuote` rejects rather than counting as verified.
		code: bodyLines
			.slice(index + 1, heads[i + 1]?.index ?? bodyLines.length)
			.join("\n")
			.replace(/\n+$/, ""),
	}));
}

/**
 * Every quote in a report that this module can read.
 *
 * An unclosed fence yields nothing, deliberately. Parsing it to the end of the
 * report is the obvious alternative and it is worse: the body would then run on
 * through `## Architecture` and every other section the model wrote after the
 * fence it forgot to close, so the "quote" checked against the file would be
 * the report's own prose and the verdict would be `fabricated` — a false
 * accusation, on real code, manufactured by the parser. Truncation is the only
 * case where reading to the end is right, and nothing in the text distinguishes
 * a truncated report from a forgotten fence.
 *
 * So the block stays unparsed, and `findUnmarkedFailures` reports it as
 * unparsed instead. Silence was the bug; a false verdict would not be a fix.
 */
export function extractQuotes(report: string): Quote[] {
	const out: Quote[] = [];
	for (const block of scanFences(report)) {
		if (!block.close) continue;
		for (const { file, startLine, code } of splitExcerpts(block.body.split("\n"))) {
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
 *  - trivial        the content matched, and matching it proved nothing: a
 *                   closing brace, a comment marker, a fragment that occurs all
 *                   over the file. Not a pass and not a failure — see
 *                   `VerifyResult.checkable`
 *  - unread         the cited file exists and is over MAX_VERIFY_BYTES, so it
 *                   was never opened. Not a pass and not a failure either: we
 *                   did not look
 *
 * `unread` is its own verdict rather than a reuse of `trivial`, which is the
 * other verdict meaning "not checked". They are not the same claim. `trivial`
 * says the verifier read the file and found the quote carried no information;
 * `unread` says the verifier declined to read the file at all. Folding the
 * second into the first would print "content too slight to verify either way" on
 * a block whose content was never examined — a false explanation — and would
 * add these blocks to `ReanchorResult.trivial` and the benchmark's `trivial`
 * outcome, corrupting a published number with a different phenomenon.
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
	| "empty"
	| "trivial"
	| "unread";

/**
 * Verdicts under which every character the caller can read is real content of
 * the cited file. That is what `valid` has always meant here — "is this code
 * real?", not "did the explorer count lines right?" — so truncation, elision
 * and reflow join drift on the true side: they are incomplete quotes of real
 * code, and the caller reasoning from the text it can see is reasoning from the
 * file. Misattribution and fabrication are false because in both the cited file
 * does not contain what the report says it contains.
 *
 * `!valid` was once the whole release gate, with nothing to subtract. It is now
 * `!valid && checkable`, because two verdicts — `trivial` and `unread` — are a
 * refusal to judge rather than a judgement. See `VerifyResult.checkable`.
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
	 * Whether this quote belongs in a fidelity ratio at all — true for every
	 * verdict but `trivial` and `unread`.
	 *
	 * `valid` is a two-valued answer to a question that has three answers. A
	 * quote of `}` is not verified: the brace is in the file, but so is every
	 * other brace, and nothing about the report was confirmed by finding one. It
	 * is equally not fabricated: the model invented nothing. Scoring it either
	 * way corrupts the number. As `valid` it is a vacuous match inflating
	 * fidelity — the same defect as a gate that reads 100% because nothing
	 * parsed. As `!valid` it fires the release gate over a non-problem, and a
	 * gate that fires on non-problems is one people learn to override.
	 *
	 * So a trivial quote is dropped from BOTH sides of the ratio. Fidelity is
	 * `valid / checkable`, the gate is `!valid && checkable`, and the count of
	 * unchecked quotes is reported on its own — see `ReanchorResult.trivial` —
	 * because a report made of braces should look empty rather than perfect.
	 *
	 * A field rather than a rule to remember: every consumer that destructures a
	 * result sees it, and TypeScript makes it impossible to build a result here
	 * without deciding.
	 */
	checkable: boolean;
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

/**
 * Largest file this module will read into memory to verify a quote against.
 *
 * Verification runs synchronously inside the host agent's turn, so an unbounded
 * `readFileSync` is a block on the user's event loop whose length is chosen by
 * whatever the report cited — a matched 500 MB log, a vendored bundle, a
 * database dump.
 *
 * The number is `src/detect.ts`'s `MAX_VERIFY_FILE_BYTES`, which caps the
 * analogous read on the auto-promotion path for exactly this reason. The two are
 * deliberately equal and deliberately NOT shared through an import. The reason is
 * historical: the benchmark harness (not part of this repository — it ran against
 * a private corpus) was executed directly by `node --experimental-strip-types`,
 * which cannot resolve the `.js` specifiers `src/` compiles with, so it imported
 * `src/citations.ts` as a leaf and a value import of `./detect.js` here would have
 * failed with ERR_MODULE_NOT_FOUND. The constraint is gone with the harness; the
 * duplication is kept because nothing needs it merged and the guard is cheap.
 * `tests/citations-large-file.test.ts` asserts the two constants are the same
 * number so the duplication cannot drift.
 */
export const MAX_VERIFY_BYTES = 4 * 1024 * 1024;

/**
 * A cited file's lines, or the reason there are none.
 *
 * A union rather than `string[] | null` because the two ways of having no lines
 * demand opposite answers. "Not there" is evidence against the report and is
 * reported as `missing-file`; "too big to read" is evidence about nothing, and
 * calling it `missing-file` would accuse a model of citing a file that is
 * sitting right there. Making the caller destructure a tag is what stops the
 * second quietly inheriting the first's verdict.
 */
type FileLines =
	| {
			readonly kind: "read";
			readonly lines: string[];
			/** `anchoredLines(lines)`, derived once per file — see `cachedReader`. */
			readonly anchored: AnchoredLine[];
	  }
	| { readonly kind: "missing" }
	| { readonly kind: "too-large"; readonly bytes: number };

type LineReader = (file: string) => FileLines;

function readLines(file: string, cwd: string): FileLines {
	try {
		const path = resolve(cwd, file);
		const { size } = statSync(path);
		if (size > MAX_VERIFY_BYTES) return { kind: "too-large", bytes: size };
		const lines = readFileSync(path, "utf8").split("\n");
		return { kind: "read", lines, anchored: anchoredLines(lines) };
	} catch {
		return { kind: "missing" };
	}
}

/**
 * A reader that reads and anchors each path at most once.
 *
 * `reanchorReport` verifies every excerpt in a report against an overlapping
 * handful of files, and the misattribution search re-reads that same handful.
 * Without a cache the cost of the search would scale with quotes × files
 * instead of files, which is the difference between free and noticeable inside
 * a user's agent turn.
 *
 * The anchored form is cached with the lines, and that is the half that carries
 * the cost. The misattribution search used to call `anchoredLines` on every
 * candidate file for every failing quote — quotes × files allocations of an
 * object per non-blank line — so a report citing 40 large files with quotes that
 * do not verify paid for the same derivation 1,600 times. Deriving it with the
 * read makes it files, once. Measured on the audit's adversarial shape — 40
 * cited files of ~1.6 MB, every quote fabricated, so every cheap rule fails and
 * the misattribution search runs on all of them — **1,142 ms and 417 MB before,
 * 257 ms and 173 MB after**, on Node 22.22.2 / darwin.
 *
 * What remains is the reading and anchoring itself, which is inherent: the pass
 * is bounded by (cited files) × MAX_VERIFY_BYTES, and the per-file cap is the
 * only bound on it. That is a deliberate stopping point. An aggregate budget
 * would have to tell a caller its quote was "unchecked" for a reason that is
 * about the report's other quotes rather than about its own file, and no
 * measured case needs it.
 */
function cachedReader(cwd: string): LineReader {
	const cache = new Map<string, FileLines>();
	return (file) => {
		const cached = cache.get(file);
		if (cached !== undefined) return cached;
		const lines = readLines(file, cwd);
		cache.set(file, lines);
		return lines;
	};
}

/**
 * Whether a citation's line range exists in the file it names.
 *
 * A file over the size cap comes back valid with a reason saying it was not
 * checked. That is deliberate and it is the lesser of two distortions: a range
 * is a claim about a file's length, declining to read the file is not evidence
 * that the claim is wrong, and reporting `false` would fire the citation-validity
 * number and the benchmark's `problems` list on a file nobody looked at. The
 * cost is that such an entry counts as valid in a ratio it was never checked for
 * — real, bounded by how rare a cited 4 MB+ file is, and visible in the reason.
 */
export function verifyCitation(c: Citation, cwd: string): CitationResult {
	const file = readLines(c.file, cwd);
	if (file.kind === "missing") return { valid: false, reason: `file not found: ${c.file}` };
	if (file.kind === "too-large") {
		return {
			valid: true,
			reason: `not checked: ${c.file} is ${file.bytes} bytes, over the ${MAX_VERIFY_BYTES}-byte verification cap`,
		};
	}
	const lines = file.lines;
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
 * Matched content short enough that it may not be evidence, and why.
 *
 *  - short   under the floor no content clears, however well it matched
 *  - common  over that floor but under MIN_DISTINCT_CHARS, and matching in more
 *            than one place, so it identifies nothing
 */
type Triviality =
	| { kind: "short"; chars: number }
	| { kind: "common"; chars: number; occurrences: number };

/**
 * Shortest matched content that can be evidence of anything on its own.
 *
 * The same eight as MIN_PREFIX_CHARS, for the same reason and from the same
 * measurement, but kept as its own constant: these are two independent
 * decisions that happen to coincide, and sharing one name would mean moving the
 * prefix rule silently moved this one.
 *
 * Set from the corpus. Taking every distinct line of the 2,096 reference files
 * and asking which ones are the ONLY copy of themselves in their own file, the
 * unique lines under eight characters are — in descending order of how many
 * files they appear in — `*/`, `/**`, `const {`, `} = t0;`, `let t2;`, `*`,
 * `try {`, `})`, `) {`, `if (`, `return`, `}`. Not one of them is evidence of
 * anything, and their uniqueness is an accident of file size rather than a
 * property of the content. That is why this floor is unconditional while the
 * one below is not: under eight characters, distinctiveness is measuring the
 * file, not the quote.
 *
 * It has to be unconditional. `}` is a whole line 44,543 times across the
 * corpus, a mean of 25 times in each of the 1,764 files that contain one — but
 * in 135 of those files (7.7%) it occurs exactly once. A rule that asked only
 * "does this pin down one place?" would hand a clean `exact` to a quote of `}`
 * in one file in thirteen.
 */
const MIN_EVIDENCE_CHARS = 8;

/**
 * Above this many matched characters, content is evidence whatever else is true
 * of it; below it, content must also pin down one place in the file.
 *
 * This is the number that keeps the rule from being a blunt length floor.
 * `const x = 1;` is twelve characters and is real evidence; `.optional()` is
 * eleven and is not. Length cannot separate them and repetition can: across the
 * corpus's 8-to-23-character lines, 77,383 distinct ones occur exactly once in
 * their file and 7,657 repeat, and the repeating ones are `} else {` (5,244
 * occurrences), `return {` (2,278), `logForDebugging(` (1,531), `import {`
 * (1,011), `return false` (768), `.optional()` (297), `throw new Error(` (177).
 * Those are the shape a model reaches for when it has nothing to show. Quoting
 * one of them is not a claim a reader can check.
 *
 * It is set at the number MIN_MATCHED_CHARS already uses, which is where this
 * codebase previously decided a fragment starts carrying enough to be worth
 * crediting, and the agreement is deliberate: a fragment too thin to excuse a
 * truncation is too thin to stand as evidence unaided.
 *
 * The corpus says this must be a gate on the scan and not a verdict on its own.
 * Of the 1,265 quotes in the stored reports, exactly three fall below it, and
 * all three are real evidence a reader would want:
 *
 *   // GET /api/sessions              20 chars, once in src/server/dashboard.ts
 *   // GET /api/events/sse            22 chars, once in src/server/dashboard.ts
 *   clearedToolResults, / }           20 chars, once in microCompact.ts
 *
 * A blunt 24-character floor would have called all three trivial. Each occurs
 * exactly once in its file, so the occurrence test spares all three, and the
 * measured misclassification of this rule on the corpus is zero. That is the
 * whole reason the second clause is a conjunction rather than a length cutoff.
 */
const MIN_DISTINCT_CHARS = 24;

/** How many places in the file the needle matches. */
function countOccurrences(needle: readonly string[], haystack: readonly AnchoredLine[]): number {
	let found = 0;
	for (let i = 0; i + needle.length <= haystack.length; i++) {
		let matched = true;
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j]!.text !== needle[j]) {
				matched = false;
				break;
			}
		}
		if (matched) found++;
	}
	return found;
}

/**
 * Why a quote that DID match is nonetheless not evidence, or null if it is.
 *
 * Only ever consulted on a successful verbatim match — see `verifyQuoteWith`.
 *
 * The length test runs first and costs nothing, which is what bounds the cost of
 * the occurrence scan: it runs only for content under MIN_DISTINCT_CHARS, and
 * that is 3 of the 1,265 quotes in the stored reports. Scanning every quote
 * instead — the distinctiveness-first design — measures at 4.1us per quote, so
 * the saving is real but small; what the gate mostly buys is not having to give
 * up `locateQuote`'s early return on the stated line for every quote in every
 * report to decide something a length comparison already settled. End to end,
 * `reanchorReport` over the 140 stored reports is 0.65ms per report with this
 * rule and 0.65ms without it.
 */
function triviality(needle: readonly string[], haystack: readonly AnchoredLine[]): Triviality | null {
	let chars = 0;
	for (const line of needle) chars += line.length;
	if (chars >= MIN_DISTINCT_CHARS) return null;
	if (chars < MIN_EVIDENCE_CHARS) return { kind: "short", chars };
	const occurrences = countOccurrences(needle, haystack);
	return occurrences > 1 ? { kind: "common", chars, occurrences } : null;
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
	const file = read(q.file);
	if (file.kind === "missing") {
		return {
			valid: false,
			checkable: true,
			verdict: "missing-file",
			reason: `file not found: ${q.file}`,
		};
	}
	// Over the cap the file is never opened, so there is nothing to compare and
	// nothing to conclude. `checkable: false` keeps it out of both sides of the
	// fidelity ratio and out of the release gate — a gate that fired because we
	// declined to read a 40 MB bundle is a gate people learn to override — and
	// `verdictMarker` still annotates the block, because a caller must never read
	// "we did not look" as "we looked and it was fine".
	if (file.kind === "too-large") {
		return {
			valid: false,
			checkable: false,
			verdict: "unread",
			reason: `unread: ${q.file} is ${file.bytes} bytes, over the ${MAX_VERIFY_BYTES}-byte verification cap, so this quote was never checked`,
		};
	}

	const quoted = normalizeQuote(q.code);
	// A header with no code body is a malformed citation, not a verified one.
	if (quoted.length === 0) {
		return {
			valid: false,
			checkable: true,
			verdict: "empty",
			reason: `empty quote for ${q.file}:${q.startLine}`,
		};
	}

	const haystack = file.anchored;
	const found = (verdict: QuoteVerdict, actualLine: number, reason?: string): VerifyResult => ({
		valid: CONTENT_IS_REAL.has(verdict),
		checkable: true,
		verdict,
		actualLine,
		drift: actualLine - q.startLine,
		...(reason === undefined ? {} : { reason }),
	});

	const exact = locateQuote(quoted, haystack, q.startLine);
	if (exact !== null) {
		// Triviality is a demotion of a match that SUCCEEDED, and it is reachable
		// from nowhere else in this function. That placement is the whole safety
		// argument: `trivial` can only ever be returned instead of `exact` or
		// `drifted`, so no quote that would have been called fabricated,
		// misattributed or missing-file can be relabelled unjudged by it. A short
		// invented line still appears nowhere in the file, still falls through
		// every rule below, and still comes back `fabricated` — laundering an
		// invention into "unverifiable" would be strictly worse than crediting a
		// brace, and the only way to be sure it cannot happen is for the failure
		// paths never to consult this rule at all.
		//
		// The weaker verdicts below need no such test and get none: truncation and
		// elision already require MIN_MATCHED_CHARS (24) of matched text and
		// reflow MIN_PROSE_CHARS (40), every one of which is at or above
		// MIN_DISTINCT_CHARS, so no quote reaching them could be trivial anyway.
		const why = triviality(quoted, haystack);
		if (why !== null) {
			return {
				valid: false,
				checkable: false,
				verdict: "trivial",
				reason:
					why.kind === "short"
						? `trivial: ${why.chars} character${why.chars === 1 ? "" : "s"} of content is not evidence about ${q.file}, so this is neither verified nor fabricated`
						: `trivial: this content occurs ${why.occurrences} times in ${q.file}, so quoting it identifies nothing; neither verified nor fabricated`,
			};
		}
		return found(exact === q.startLine ? "exact" : "drifted", exact);
	}

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
		// A candidate we did not read is not a candidate. Both "absent" and "over
		// the cap" mean the same thing here: no evidence that this is where the
		// code lives, so the quote stays fabricated rather than being relocated on
		// a guess.
		if (other.kind !== "read") continue;
		const at = locateQuote(quoted, other.anchored, q.startLine);
		if (at === null) continue;
		return {
			valid: false,
			checkable: true,
			verdict: "misattributed",
			actualFile: candidate,
			actualLine: at,
			reason: `misattributed: this code is not in ${q.file}; it is in ${candidate}:${at}`,
		};
	}

	return {
		valid: false,
		checkable: true,
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
	/**
	 * Blocks whose quoted content was too slight to check either way — a brace, a
	 * comment marker, a fragment the file repeats.
	 *
	 * Reported on its own and counted in neither `fabricated` nor the verified
	 * total, because it is neither. The number exists so a report made of
	 * punctuation reads as empty instead of perfect: eleven blocks of which nine
	 * are trivial is a bad report, and every ratio that hides this count makes it
	 * look like a good one.
	 */
	trivial: number;
	/**
	 * Blocks marked UNCHECKED because the file they cite is over
	 * MAX_VERIFY_BYTES, so it was never read.
	 *
	 * Its own number for the same reason `trivial` is: counted as verified it
	 * would be a claim nobody checked, counted as fabricated it would be an
	 * accusation nobody checked, and folded into `trivial` it would be a true
	 * number under a false name.
	 */
	unread: number;
	/**
	 * Fenced blocks this pass could not read at all — today, exactly the blocks
	 * whose fence is never closed.
	 *
	 * This is the count that makes the difference between "there was nothing
	 * wrong" and "we could not see". A report whose last fence is unterminated
	 * used to produce zeros everywhere — no quotes, no fabrications, no markers —
	 * and read as a clean run. One number saying "there were N blocks in here I
	 * did not parse" is what turns that silence back into a finding.
	 */
	unparsed: number;
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
 * Its own keyword, not a fourth flavour of UNVERIFIED.
 *
 * UNVERIFIED tells the caller the block may be fiction. This block is not
 * fiction and is not fact either — the verifier looked and there was nothing in
 * it to look at. Saying UNVERIFIED would send a reader to re-derive a closing
 * brace; saying nothing would let the reader assume the block was checked, which
 * is the one thing that must not happen to an unchecked block.
 */
const UNCHECKED_TRIVIAL = " — UNCHECKED: content too slight to verify either way";
/**
 * A header with no code under it.
 *
 * This block used to ship bare, on the reasoning that an excerpt with no content
 * has no content to mislead anyone with. That was true about the code and wrong
 * about the header. The header is itself a claim — it says there is something at
 * this line worth quoting — and a bare header is one a reader takes for checked,
 * which is the single thing that must never happen to a block nobody checked.
 *
 * It also left the one hole `findUnmarkedFailures` exists to rule out. `empty`
 * is `!valid && checkable`, so it is inside the release gate's own predicate:
 * the benchmark already counted it as a failure while this function returned
 * null for it, which is exactly the shape of "fails the gate, ships unlabelled".
 * Marking it is what makes the invariant total rather than total-except-one.
 *
 * UNCHECKED rather than UNVERIFIED, for the same reason as the trivial case
 * above: nothing here is fiction, there was simply nothing to look at. And the
 * line number is still not corrected — there is no content to locate, so any
 * anchor we moved it to would be a guess.
 */
const UNCHECKED_EMPTY = " — UNCHECKED: no code under this header";
/**
 * A file too large to read. UNCHECKED, not UNVERIFIED, because nothing about the
 * block was doubted — the verifier refused to spend the user's turn reading a
 * multi-megabyte file, and says so rather than letting the block pass as
 * confirmed.
 */
const UNCHECKED_TOO_LARGE = " — UNCHECKED: cited file is too large to verify";
/**
 * A block inside a fence that is never closed.
 *
 * This is the marker for the shape that has no verdict, because no quote was
 * ever extracted from it: the parser cannot tell where the block ends, so it
 * cannot tell what was quoted. What it CAN do is refuse to let the block look
 * checked. Without this, a truncated report shipped its excerpts bare and
 * `findUnmarkedFailures` agreed there was nothing to report — a clean run
 * because nothing was visible, which is the failure mode this package has hit
 * before and the one that must not recur.
 */
const UNCHECKED_UNTERMINATED = " — UNCHECKED: unterminated code fence; this block was not verified";

/**
 * The note for a verdict, or null when the block needs no note.
 *
 * Misattribution names the file the code is really in, because that is the one
 * thing the caller needs and cannot recover from the block. The header's own
 * path is left as the model wrote it: rewriting a path would be inventing a
 * finding on the model's behalf, which is a worse habit than the error it fixes.
 *
 * Returning null is reserved for the verdicts where the block is TRUE as it
 * stands — where a marker would be telling the caller to doubt something
 * correct. Every other verdict must return a string, and
 * `findUnmarkedFailures` is what proves that in the delivered text rather than
 * here. Two things guard the mapping itself: the switch has no `default`, so a
 * verdict added to the union without a case is a compile error, and the
 * exhaustive test over `QuoteVerdict` catches the subtler version of the same
 * mistake — a new verdict given a case that returns null.
 */
function verdictMarker(result: VerifyResult): string | null {
	switch (result.verdict) {
		case "exact":
		case "drifted":
			return null;
		case "empty":
			return UNCHECKED_EMPTY;
		case "truncated":
			return PARTIAL_TRUNCATED;
		case "elided":
			return PARTIAL_ELIDED;
		case "reflowed":
			return PARTIAL_REFLOWED;
		case "trivial":
			return UNCHECKED_TRIVIAL;
		case "unread":
			return UNCHECKED_TOO_LARGE;
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
		const target = read(file);
		const limit = target.kind === "read" ? target.lines.length : end + delta;
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
 * so a second pass still reports blocks that are still unverifiable. Stripping
 * first is also what stops a model FORGING a marker: a warning the explorer
 * wrote itself is removed and then re-derived from the file, so the note on a
 * delivered block is always this function's finding and never the model's claim.
 *
 * The property that makes any of this worth doing is that the marking is
 * COMPLETE — that no failure reaches the caller looking like a verified one.
 * That is not asserted here; `findUnmarkedFailures` checks it against the
 * delivered text.
 */
export function reanchorReport(report: string, cwd: string): ReanchorResult {
	const verified = new Map<string, number | null>();
	const read = cachedReader(cwd);
	const searchFiles = citedFiles(report);
	let corrected = 0;
	let fabricated = 0;
	let misattributed = 0;
	let partial = 0;
	let trivial = 0;
	let unread = 0;
	let unparsed = 0;
	let out = "";
	let cursor = 0;

	for (const block of scanFences(report)) {
		const bodyLines = block.body.split("\n");

		// A fence that is never closed. Its excerpts are not verified — see
		// `extractQuotes` for why reading to the end of the report would be worse
		// than not reading at all — so the one thing left to do is stop the block
		// looking verified. Only the header line is touched, and only when there is
		// one: a block that never claimed a `path:line` is not claiming to be a
		// checked excerpt, exactly as a headerless closed fence is not.
		if (!block.close) {
			unparsed++;
			const headerLine = bodyLines[0];
			if (headerLine === undefined || parseHeader(headerLine) === null) continue;
			const marked =
				headerLine.replace(VERDICT_MARKER, "").replace(/\s+$/, "") + UNCHECKED_UNTERMINATED;
			out += report.slice(cursor, block.bodyStart) + marked;
			cursor = block.bodyStart + headerLine.length;
			continue;
		}

		// Not a cited block. Leave it byte-for-byte alone.
		const excerpts = splitExcerpts(bodyLines);
		if (excerpts.length === 0) continue;

		// Each excerpt is judged on its own and only its own header line is
		// touched, so one unverifiable excerpt cannot mark the honest ones beside
		// it and every other byte of the block survives unchanged.
		const rewritten = [...bodyLines];
		let changed = false;
		for (const { headerIndex, prefix, file, startLine, suffix, code } of excerpts) {
			const result = verifyQuoteWith({ file, startLine, code }, read, searchFiles);
			const key = `${file}:${startLine}`;
			// An anchor is only recorded when the content is in the file the header
			// names. Misattribution has a real line number attached and it belongs
			// to another file, so feeding it to the citation rewriter would move a
			// `Files Retrieved` range onto a line of a file nobody verified.
			//
			// `trivial` abstains entirely, as `empty` does, rather than poisoning the
			// entry. A brace matches in eighty places, so the line it "found" is not a
			// location and must never move a range; equally it is not a contradiction,
			// so it has no business overruling a real quote that states the same
			// anchor. Silence is the only honest thing an unchecked block can say
			// about a citation entry.
			//
			// `unread` abstains for the same reason and one more: it is the verdict
			// for a file we did not open, so it knows nothing about any line of it.
			const anchored = CONTENT_IS_REAL.has(result.verdict) ? result.actualLine : undefined;
			const abstains =
				result.verdict === "empty" || result.verdict === "trivial" || result.verdict === "unread";
			if (anchored !== undefined) recordAnchor(verified, key, anchored);
			else if (!abstains) recordAnchor(verified, key, null);

			let header = bodyLines[headerIndex]!.replace(VERDICT_MARKER, "").replace(/\s+$/, "");
			if (anchored !== undefined && result.drift !== 0) {
				// The closing marker of a two-sided comment rides along, so an HTML or
				// C-style header comes back out as a comment rather than an unclosed one.
				header = `${prefix}${file}:${anchored}${suffix ? ` ${suffix}` : ""}`;
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
				case "trivial":
					trivial++;
					break;
				case "unread":
					unread++;
					break;
				case "exact":
				case "drifted":
				case "empty":
					break;
			}
		}
		if (!changed) continue;

		// Everything up to the body is the opening fence with its language tag, and
		// the closing delimiter goes back exactly as it was found — four backticks
		// stay four, a tilde fence stays a tilde fence.
		out += report.slice(cursor, block.bodyStart);
		out += `${rewritten.join("\n")}${block.close}`;
		cursor = block.end;
	}
	out += report.slice(cursor);

	const entries = reanchorCitations(out, read, verified);
	return {
		report: entries.report,
		corrected: corrected + entries.corrected,
		fabricated,
		misattributed,
		partial,
		trivial,
		unread,
		unparsed,
	};
}

/**
 * A quote the caller was handed as fact, that is not fact, with nothing on it
 * saying so.
 *
 * `header` is the delivered line verbatim rather than a reconstruction, because
 * the whole point of this check is what the text SAYS about the block, not what
 * the verifier privately concluded about it. When one of these turns up, that
 * string is the evidence.
 */
export interface UnmarkedFailure {
	file: string;
	startLine: number;
	/**
	 * The verdict that failed, or `"unparsed"` for a block that produced no
	 * verdict because it could not be read at all.
	 *
	 * `"unparsed"` lives here rather than in `QuoteVerdict` because it is not a
	 * finding about a quote — no quote was extracted — it is a finding about this
	 * function's own reach. Putting it in the verdict union would hand it a row in
	 * the benchmark's outcome table and a case in `verdictMarker`, as though the
	 * verifier had looked at something and formed a view.
	 */
	verdict: QuoteVerdict | "unparsed";
	/** The fence header exactly as it appears in the delivered report. */
	header: string;
	/** Why the quote failed, from `verifyQuote`. */
	reason?: string;
}

/**
 * Every failure in a DELIVERED report that carries no marker. Empty is the
 * safety property.
 *
 * We cannot stop a model quoting code that is not there. The release gate that
 * asked us to — "any non-zero hallucination rate is a release blocker" — was
 * unreachable by construction, measured 2.9% on the reference corpus, and was
 * therefore shipped around. A gate that can never pass protects nothing.
 *
 * This is the property that can be held instead, and it is the one that
 * actually matters: a fabrication never reaches the main agent UNLABELLED. A
 * marked block is a block the caller knows not to trust, and a caller that knows
 * has lost nothing but a little time. An unmarked one is the real harm — it is
 * read as verified, reasoned from as fact, and nothing about it looks wrong.
 * Unlike "zero fabrication" this is deterministic, checkable on demand, and
 * already true; what was missing was the proof.
 *
 * Three details carry that proof, and weakening any of them would prove
 * something weaker than it appears to:
 *
 *  - It reads the delivered TEXT, re-parsing and re-verifying from scratch,
 *    rather than inspecting anything `reanchorReport` recorded on the way past.
 *    Internal bookkeeping can only show that the marking code believed it marked
 *    the block; the guarantee is about what the main agent receives, so the
 *    delivered bytes are the only admissible evidence. Anything lost between the
 *    verdict and the page — a rewritten block that no longer parses, a fence
 *    assembled wrong, a marker clobbered by a later pass — is invisible to the
 *    former and caught by the latter.
 *  - "Carries a marker" is decided by the same `VERDICT_MARKER` that
 *    `parseHeader` strips. That coupling is deliberate: a marker only counts as
 *    marking if it also round-trips, so the one kind of marker this must never
 *    accept — one that annotates a block and thereby deletes it from the
 *    verifier's denominator, turning an admission of failure into a rise in the
 *    fidelity score — cannot be counted as protection here either.
 *  - The failure set is `!valid && checkable`, the release gate's own predicate,
 *    rather than a hand-written list of verdicts to skip. Today that is exactly
 *    "not valid, and not `trivial` or `unread`". Tomorrow it is whatever the gate
 *    means, with no second opinion kept here to drift out of step with it.
 *
 * A fourth detail was added after an audit found the first three were being held
 * over a parser with blind spots. This function re-parses with the SAME parser
 * `reanchorReport` used, which is what makes it a proof about marking — and
 * exactly why it could not see a parsing failure: an unterminated fence, a `~~~`
 * fence and every comment marker but `//` and `#` all produced "no quotes, no
 * failures, clean run". Three of those four shapes are now parsed. The one that
 * cannot be — a fence with no closer, where the block's own extent is unknown —
 * is REPORTED instead, as an `"unparsed"` entry, so the answer to "was anything
 * invisible?" is a number rather than a silence. A checker that cannot see a
 * block must say so; saying nothing is indistinguishable from finding nothing,
 * and that is the bug this project keeps rediscovering.
 *
 * The residual boundary, stated rather than left to be found later: an
 * unterminated fence whose first line is NOT a `path:line` header is not
 * reported. Such a block makes no claim to be a checked excerpt — it is the same
 * uncited code block a closed headerless fence is, and those have always been
 * outside this guarantee — so flagging it would fire on `~~~sh` shell snippets
 * and train people to ignore the number.
 */
export function findUnmarkedFailures(report: string, cwd: string): UnmarkedFailure[] {
	const read = cachedReader(cwd);
	// The same search scope `reanchorReport` used, so the two agree on which
	// quotes are misattributed rather than fabricated. Both are marked, so the
	// distinction cannot change the verdict of this function — but a checker that
	// classified differently from the marker would be a second opinion about the
	// thing it is auditing, which is how audits stop meaning anything.
	const searchFiles = citedFiles(report);
	const out: UnmarkedFailure[] = [];

	for (const block of scanFences(report)) {
		const bodyLines = block.body.split("\n");

		if (!block.close) {
			const header = bodyLines[0];
			if (header === undefined) continue;
			const claim = parseHeader(header);
			if (claim === null) continue;
			if (VERDICT_MARKER.test(header)) continue;
			out.push({
				file: claim[2]!,
				startLine: Number(claim[3]),
				verdict: "unparsed",
				header,
				reason: `unparsed: the fence opening this block is never closed, so its excerpt was never extracted or verified`,
			});
			continue;
		}

		for (const { headerIndex, file, startLine, code } of splitExcerpts(bodyLines)) {
			const result = verifyQuoteWith({ file, startLine, code }, read, searchFiles);
			if (result.valid || !result.checkable) continue;
			const header = bodyLines[headerIndex]!;
			if (VERDICT_MARKER.test(header)) continue;
			out.push({
				file,
				startLine,
				verdict: result.verdict,
				header,
				...(result.reason === undefined ? {} : { reason: result.reason }),
			});
		}
	}
	return out;
}
