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
