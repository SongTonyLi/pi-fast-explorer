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

/** Normalizes indentation so reflowed quotes are not counted as hallucinations. */
function normalize(text: string): string {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.join("\n");
}

export function verifyQuote(q: Quote, cwd: string): VerifyResult {
	const lines = readLines(q.file, cwd);
	if (!lines) return { valid: false, reason: `file not found: ${q.file}` };

	const quoted = normalize(q.code);
	if (!quoted) return { valid: true };

	const span = quoted.split("\n").length;
	const start = q.startLine - 1;
	const actual = normalize(lines.slice(start, start + span).join("\n"));

	if (actual !== quoted) {
		return { valid: false, reason: `quote does not match ${q.file}:${q.startLine}` };
	}
	return { valid: true };
}
