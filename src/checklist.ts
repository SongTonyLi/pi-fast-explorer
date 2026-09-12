/**
 * The checklist is the main agent's list of specific things it needs located
 * or answered. It rides in every explorer's task text, comes back as a
 * `## Checklist` section of `[x]`/`[ ]` lines, and is matched here so the
 * caller gets a per-item verdict instead of prose it has to grade itself.
 *
 * Parsing is by shape, like citations.ts: no runtime coupling to the prompt,
 * so tests/prompt-contract.test.ts pins the worked example.
 */

export interface ChecklistItem {
	/** 1-based, as written into the task text. */
	index: number;
	item: string;
}

export interface ChecklistLine {
	index: number;
	/** Whether the explorer wrote the number, or it was assigned by position. */
	explicit: boolean;
	resolved: boolean;
	/** Everything after the checkbox, trimmed. */
	text: string;
}

export interface ChecklistStatus {
	index: number;
	item: string;
	resolved: boolean;
	/** The explorer's answer with the echoed item stripped, or why it is unresolved. */
	note: string;
	/** Brief of the explorer whose line this status came from, when any did. */
	source?: string;
}

/**
 * `1. [x] text`, `1) [ ] text`, `- [x] text`, `- 1. [X] text`. The number is
 * optional because an explorer handed a subset may renumber or bullet it;
 * unnumbered lines are numbered by position.
 */
const LINE = /^\s*(?:[-*]\s+)?(?:(\d+)[.)]\s*)?(?:[-*]\s+)?\[([ xX])\]\s*(.*?)\s*$/;

const HEADING = /^##\s+Checklist\b/i;
const ANY_HEADING = /^##\s+/;

export function parseChecklist(report: string): ChecklistLine[] {
	const lines = report.split("\n");
	const start = lines.findIndex((l) => HEADING.test(l.trim()));
	let body: string[];
	if (start === -1) {
		// No heading. The lines are the contract; the heading is only where
		// they are supposed to live. Nothing else in a report uses `[x]`.
		body = lines;
	} else {
		body = [];
		for (let i = start + 1; i < lines.length; i++) {
			if (ANY_HEADING.test(lines[i]!)) break;
			body.push(lines[i]!);
		}
	}
	const out: ChecklistLine[] = [];
	for (const raw of body) {
		const m = LINE.exec(raw);
		if (!m) continue;
		const index = m[1] ? Number(m[1]) : out.length + 1;
		out.push({ index, explicit: Boolean(m[1]), resolved: m[2] !== " ", text: m[3] ?? "" });
	}
	return out;
}

const NOT_REPORTED = "not reported by any explorer";

function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokens(s: string): string[] {
	return normalize(s)
		.split(" ")
		.filter((t) => t.length > 2);
}

/** Share of `head`'s words that also occur in `item`; 1.0 means head is made of the item's words. */
function overlap(head: string, item: string): number {
	const h = tokens(head);
	if (h.length < 2) return 0;
	const want = new Set(tokens(item));
	return h.filter((t) => want.has(t)).length / h.length;
}

/**
 * "find login — src/auth.ts:10 here" with item "find login" → "src/auth.ts:10 here".
 *
 * Explorers also restate the item in their own words before the answer —
 * measured: "File path where agent events are persisted on disk — src/…" for
 * the item "The file path where agent events are persisted on disk" — so a
 * leading clause made mostly of the item's words is treated as the item too.
 */
function stripEcho(text: string, item: string): string {
	const exact = text.replace(new RegExp(`^${escapeRegExp(item.trim())}\\s*(?:[—–:-]+\\s*)?`, "i"), "").trim();
	if (exact !== text.trim()) return exact || "no detail given";
	const m = /^(.+?)\s+[—–]\s+([\s\S]+)$/.exec(text);
	if (m && overlap(m[1]!, item) >= 0.6) return m[2]!.trim() || "no detail given";
	return text.trim() || "no detail given";
}

export interface ChecklistReport {
	brief: string;
	report: string;
	/**
	 * The item numbers this explorer's brief carried, when it was handed a
	 * subset. A subset report's positional lines restart at 1 and its explicit
	 * numbers may only name items it was given; without this an escalation
	 * answer lands on item 1.
	 */
	allowed?: number[];
}

/**
 * One status per item, in item order. A line is attributed to an item by its
 * echoed text first — the more reliable key, since an escalation explorer may
 * renumber the subset it was given — and by number otherwise. The text key is
 * anchored at the start of the line, where the contract puts the item: an
 * answer naturally mentions related items, and scanning it would let one
 * item's answer claim another. Across several reports any `[x]` wins, and the
 * winner's brief is recorded.
 */
export function matchChecklist(items: string[], reports: ChecklistReport[]): ChecklistStatus[] {
	if (items.length === 0) return [];
	const statuses: ChecklistStatus[] = items.map((item, i) => ({
		index: i + 1,
		item,
		resolved: false,
		note: NOT_REPORTED,
	}));
	// Longest first, so when one item's text contains another's the more
	// specific item claims the line.
	const byText = items
		.map((item, i) => ({ n: normalize(item), i }))
		.filter((x) => x.n.length > 0)
		.sort((a, b) => b.n.length - a.n.length);

	for (const { brief, report, allowed } of reports) {
		for (const line of parseChecklist(report)) {
			const nl = normalize(line.text);
			let idx = byText.find((x) => nl.startsWith(x.n))?.i;
			if (idx === undefined) {
				let number: number | undefined;
				if (allowed) {
					number = line.explicit ? (allowed.includes(line.index) ? line.index : undefined) : allowed[line.index - 1];
				} else {
					number = line.index;
				}
				if (number === undefined || number < 1 || number > items.length) continue;
				idx = number - 1;
			}
			const status = statuses[idx]!;
			const note = stripEcho(line.text, items[idx]!);
			if (line.resolved) {
				if (!status.resolved) {
					status.resolved = true;
					status.note = note;
					status.source = brief;
				}
			} else if (!status.resolved && status.source === undefined) {
				status.note = note;
				status.source = brief;
			}
		}
	}
	return statuses;
}

/** The section appended to the tool result so the caller sees coverage at a glance. */
export function formatChecklistCoverage(statuses: ChecklistStatus[]): string {
	const done = statuses.filter((s) => s.resolved).length;
	const lines = statuses.map((s) => `- [${s.resolved ? "x" : " "}] ${s.index}. ${s.item} — ${s.note}`);
	return `## Checklist coverage\n\n${done}/${statuses.length} resolved.\n\n${lines.join("\n")}`;
}
