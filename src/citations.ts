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
// First line of the block, e.g. "// src/auth/session.ts:71"
const HEADER = /^\s*(?:\/\/|#)\s*([^\s:]+):(\d+)\s*$/;

export function extractQuotes(report: string): Quote[] {
	const out: Quote[] = [];
	FENCE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FENCE.exec(report)) !== null) {
		const lines = m[1]!.split("\n");
		const header = HEADER.exec(lines[0] ?? "");
		if (!header) continue;
		const code = lines.slice(1).join("\n").replace(/\n+$/, "");
		out.push({ file: header[1]!, startLine: Number(header[2]), code });
	}
	return out;
}

export interface VerifyResult {
	valid: boolean;
	reason?: string;
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

export function verifyQuote(q: Quote, cwd: string): VerifyResult {
	const lines = readLines(q.file, cwd);
	if (!lines) return { valid: false, reason: `file not found: ${q.file}` };

	const quoted = q.code
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	// A header with no code body is a malformed citation, not a verified one.
	if (quoted.length === 0) {
		return { valid: false, reason: `empty quote for ${q.file}:${q.startLine}` };
	}

	const start = q.startLine - 1;
	if (start < 0 || start >= lines.length) {
		return { valid: false, reason: `line ${q.startLine} out of bounds for ${q.file}` };
	}

	// Scan forward collecting non-blank lines. Slicing a fixed span would run
	// short whenever the cited range contains blank lines, since the quote's
	// line count is measured after blanks are dropped.
	const actual: string[] = [];
	for (let i = start; i < lines.length && actual.length < quoted.length; i++) {
		const t = lines[i]!.trim();
		if (t.length > 0) actual.push(t);
	}

	if (actual.length < quoted.length) {
		return { valid: false, reason: `quote extends past end of ${q.file}` };
	}
	if (actual.join("\n") !== quoted.join("\n")) {
		return { valid: false, reason: `quote does not match ${q.file}:${q.startLine}` };
	}
	return { valid: true };
}
