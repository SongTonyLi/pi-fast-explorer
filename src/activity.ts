import type { DisplayItem } from "./explorer.js";

export type ExplorerStatus = "running" | "ok" | "failed";

export interface ExplorerSnapshot {
	id: string;
	brief: string;
	status: ExplorerStatus;
	items: DisplayItem[];
	report: string;
	error?: string;
}

/** How many finished explorers stay inspectable after they settle. */
const MAX_RETAINED = 16;

const explorers = new Map<string, ExplorerSnapshot>();
const order: string[] = [];
let nextId = 0;

export function nextExplorerId(): string {
	nextId += 1;
	return `fx-${nextId}`;
}

/** Exposed for tests, which must not inherit each other's live explorers. */
export function resetExplorers(): void {
	explorers.clear();
	order.length = 0;
	nextId = 0;
}

export function upsertExplorer(snapshot: ExplorerSnapshot): ExplorerSnapshot {
	if (!explorers.has(snapshot.id)) order.push(snapshot.id);
	explorers.set(snapshot.id, snapshot);
	trimRetained();
	return snapshot;
}

export function listExplorers(): ExplorerSnapshot[] {
	return order.map((id) => explorers.get(id)).filter((s): s is ExplorerSnapshot => s !== undefined);
}

export function getExplorer(id: string): ExplorerSnapshot | undefined {
	return explorers.get(id);
}

function trimRetained(): void {
	while (order.length > MAX_RETAINED) {
		const drop = order.find((id) => explorers.get(id)?.status !== "running") ?? order[0];
		if (!drop) return;
		const idx = order.indexOf(drop);
		if (idx >= 0) order.splice(idx, 1);
		explorers.delete(drop);
	}
}

function shortenPath(value: string): string {
	return value.length > 48 ? `…${value.slice(-47)}` : value;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

/**
 * One-line label for a tool call. Explorers only have read, grep, find and ls;
 * anything else is shown by name so a future tool does not render as blank.
 */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "read": {
			const path = asString(args.path) ?? asString(args.file_path) ?? "…";
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let loc = shortenPath(path);
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				loc += limit !== undefined ? `:${start}-${start + limit - 1}` : `:${start}`;
			}
			return `read ${loc}`;
		}
		case "grep": {
			const pattern = asString(args.pattern) ?? "";
			const path = asString(args.path);
			return path ? `grep /${pattern}/ in ${shortenPath(path)}` : `grep /${pattern}/`;
		}
		case "find": {
			const pattern = asString(args.pattern) ?? "*";
			const path = asString(args.path);
			return path ? `find ${pattern} in ${shortenPath(path)}` : `find ${pattern}`;
		}
		case "ls": {
			const path = asString(args.path) ?? ".";
			return `ls ${shortenPath(path)}`;
		}
		default: {
			const raw = JSON.stringify(args);
			const preview = raw.length > 48 ? `${raw.slice(0, 48)}…` : raw;
			return `${name} ${preview}`;
		}
	}
}

export function lastActivity(snapshot: ExplorerSnapshot): string {
	const last = snapshot.items.at(-1);
	if (!last) return snapshot.status === "running" ? "starting…" : "no activity";
	if (last.type === "toolCall") return formatToolCall(last.name, last.args);
	const line = last.text.split("\n").find((l) => l.trim()) ?? "";
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

export function statusGlyph(status: ExplorerStatus): string {
	if (status === "running") return "⏳";
	if (status === "ok") return "✓";
	return "✗";
}

export function oneLineBrief(brief: string, max = 48): string {
	const flat = brief.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Labels for `ctx.ui.select` — one string per explorer, newest last. */
export function formatExplorerChoices(snapshots: ExplorerSnapshot[]): string[] {
	return snapshots.map((s) => `${statusGlyph(s.status)} ${s.id}  ${oneLineBrief(s.brief)}  ${lastActivity(s)}`);
}

export function formatWidgetLines(snapshots: ExplorerSnapshot[]): string[] {
	const running = snapshots.filter((s) => s.status === "running");
	const header =
		running.length === 1
			? "explorer  1 running · /explorers to inspect"
			: `explorers  ${running.length} running · /explorers to inspect`;
	const rows = running.slice(0, 4).map((s) => `  ${statusGlyph(s.status)} ${oneLineBrief(s.brief, 36)}  ${lastActivity(s)}`);
	if (running.length > 4) rows.push(`  … +${running.length - 4} more`);
	return [header, ...rows];
}

export function formatExplorerTranscript(snapshot: ExplorerSnapshot): string[] {
	const lines = [
		`${statusGlyph(snapshot.status)} ${snapshot.brief.replace(/\s+/g, " ").trim()}`,
	];
	if (snapshot.error) lines.push(`Error: ${snapshot.error}`);
	if (snapshot.items.length === 0) {
		lines.push(snapshot.status === "running" ? "(starting…)" : "(no activity)");
	}
	for (const item of snapshot.items) {
		if (item.type === "toolCall") {
			lines.push(`→ ${formatToolCall(item.name, item.args)}`);
		} else {
			for (const line of item.text.split("\n")) lines.push(line);
		}
	}
	if (snapshot.report && !snapshot.items.some((i) => i.type === "text" && i.text.includes(snapshot.report))) {
		lines.push("", snapshot.report);
	}
	return lines;
}
