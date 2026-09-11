import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	type ExplorerSnapshot,
	formatExplorerChoices,
	formatExplorerTranscript,
	formatToolCall,
	formatWidgetLines,
	getExplorer,
	lastActivity,
	listExplorers,
	onExplorerChange,
	oneLineBrief,
	statusGlyph,
} from "./activity.js";

const WIDGET_KEY = "fast-explorer";

export interface ExplorerUiHandle {
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

let ui: ExplorerUiHandle | undefined;

export function bindExplorerUi(next: ExplorerUiHandle | undefined): void {
	ui = next;
}

export function refreshExplorerWidget(): void {
	if (!ui) return;
	const snapshots = listExplorers();
	if (!snapshots.some((s) => s.status === "running")) {
		ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	ui.setWidget(WIDGET_KEY, formatWidgetLines(snapshots), { placement: "belowEditor" });
}

interface TextComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
}

function textComponent(text: string): TextComponent {
	return {
		render: (width: number) => wrapLines(text.split("\n"), width),
		invalidate: () => {},
	};
}

function wrapLines(lines: string[], width: number): string[] {
	const w = Math.max(20, width);
	const out: string[] = [];
	for (const line of lines) {
		if (line.length <= w) {
			out.push(line);
			continue;
		}
		for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w));
	}
	return out;
}

export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ExploreRenderArgs {
	question?: string;
	questions?: string[];
	scope?: string;
	fanout?: number;
}

function fg(theme: RenderTheme, color: string, text: string): string {
	return theme.fg(color, text);
}

export function renderExploreCall(args: ExploreRenderArgs, theme: RenderTheme): TextComponent {
	const questions = (args.questions ?? []).map((q) => q.trim()).filter(Boolean);
	const title = fg(theme, "toolTitle", theme.bold("explore"));
	if (questions.length > 1) {
		const lines = [`${title} ${fg(theme, "accent", `${questions.length} explorers`)}`];
		for (const q of questions.slice(0, 3)) {
			lines.push(`  ${fg(theme, "dim", oneLineBrief(q, 56))}`);
		}
		if (questions.length > 3) lines.push(`  ${fg(theme, "muted", `… +${questions.length - 3} more`)}`);
		return textComponent(lines.join("\n"));
	}
	const label = oneLineBrief(args.question ?? questions[0] ?? "…", 64);
	return textComponent(`${title} ${fg(theme, "accent", label)}`);
}

function renderSnapshot(snapshot: ExplorerSnapshot, theme: RenderTheme, expanded: boolean): string {
	const icon = fg(
		theme,
		snapshot.status === "failed" ? "error" : snapshot.status === "running" ? "warning" : "success",
		statusGlyph(snapshot.status),
	);
	const header = `${icon} ${fg(theme, "accent", oneLineBrief(snapshot.brief, expanded ? 80 : 48))}`;
	const lines = [header];
	if (snapshot.error) lines.push(`  ${fg(theme, "error", snapshot.error)}`);
	if (snapshot.items.length === 0) {
		const empty = snapshot.status === "running" ? "starting…" : "no activity";
		lines.push(`  ${fg(theme, "muted", empty)}`);
		return lines.join("\n");
	}

	const shown = expanded ? snapshot.items : snapshot.items.slice(-6);
	const skipped = snapshot.items.length - shown.length;
	if (skipped > 0) lines.push(`  ${fg(theme, "muted", `… ${skipped} earlier items`)}`);
	for (const item of shown) {
		if (item.type === "toolCall") {
			lines.push(`  ${fg(theme, "muted", "→")} ${fg(theme, "toolOutput", formatToolCall(item.name, item.args))}`);
		} else if (expanded) {
			for (const line of item.text.split("\n").slice(0, 40)) {
				lines.push(`  ${fg(theme, "toolOutput", line)}`);
			}
		} else {
			lines.push(`  ${fg(theme, "dim", lastActivity({ ...snapshot, items: [item] }))}`);
		}
	}
	return lines.join("\n");
}

function isExploreDetails(value: unknown): value is { briefs?: string[]; live?: ExplorerSnapshot[] } {
	return typeof value === "object" && value !== null;
}

export function renderExploreResult(
	result: { content: Array<{ type?: string; text?: string }>; details?: unknown },
	options: { expanded?: boolean },
	theme: RenderTheme,
): TextComponent {
	const details = isExploreDetails(result.details) ? result.details : undefined;
	const live = details?.live ?? [];
	if (live.length === 0) {
		const text = result.content.find((c) => c.type === "text")?.text ?? "(no output)";
		return textComponent(text);
	}

	const running = live.filter((s) => s.status === "running").length;
	const failed = live.filter((s) => s.status === "failed").length;
	const done = live.length - running;
	const icon = fg(
		theme,
		running > 0 ? "warning" : failed > 0 ? "error" : "success",
		running > 0 ? "⏳" : failed > 0 ? "✗" : "✓",
	);
	const status =
		running > 0
			? `${done}/${live.length} done, ${running} running`
			: `${done}/${live.length} explorer${live.length === 1 ? "" : "s"}`;
	const blocks = live.map((s) => renderSnapshot(s, theme, Boolean(options.expanded)));
	const hint = options.expanded
		? ""
		: `\n${fg(theme, "muted", "Ctrl+O to expand · /explorers to inspect")}`;
	return textComponent(`${icon} ${fg(theme, "toolTitle", theme.bold("explore"))} ${fg(theme, "accent", status)}\n\n${blocks.join("\n\n")}${hint}`);
}

interface SelectUi {
	hasUI: boolean;
	mode?: string;
	ui: Pick<ExtensionUIContext, "select" | "notify" | "custom">;
}

/** Escape, CSI-u escape/enter, q, enter, and Ctrl+C all close the inspector. */
export function isInspectorCloseKey(data: string): boolean {
	if (data === "\x1b" || data === "q" || data === "Q" || data === "\r" || data === "\n" || data === "\x03") {
		return true;
	}
	return data === "\x1b[27u" || data === "\x1b[27;1u" || data === "\x1b[13u" || data === "\x1b[13;1u";
}

export function liveTranscript(id: string, fallback: ExplorerSnapshot): string[] {
	return formatExplorerTranscript(getExplorer(id) ?? fallback);
}

async function showInspector(ctx: SelectUi, snapshot: ExplorerSnapshot): Promise<void> {
	const notifyFallback = () => {
		ctx.ui.notify(liveTranscript(snapshot.id, snapshot).slice(0, 12).join(" · "), "info");
	};
	// RPC hasUI is true but custom() is a no-op that returns undefined.
	if (ctx.mode && ctx.mode !== "tui") {
		notifyFallback();
		return;
	}
	try {
		await ctx.ui.custom((tui, _theme, _kb, done) => {
			const unsubscribe = onExplorerChange(() => tui.requestRender());
			return {
				render: (width: number) => {
					const body = wrapLines(liveTranscript(snapshot.id, snapshot), width);
					body.push("");
					body.push("esc / q to close");
					return body;
				},
				invalidate: () => {},
				dispose: unsubscribe,
				handleInput: (data: string) => {
					if (isInspectorCloseKey(data)) done(undefined as never);
				},
			};
		}, { overlay: true });
	} catch {
		notifyFallback();
	}
}

/**
 * `/explorers` opens a terminal selector over this session's live and recent
 * explorer agents. There is no checklist: the only interaction is pick one
 * explorer and read what it is doing.
 */
export function registerExplorerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("explorers", {
		description: "Inspect a running or recent explorer agent",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			const snapshots = listExplorers();
			if (snapshots.length === 0) {
				ctx.ui.notify("No explorers this session", "info");
				return;
			}
			const choices = formatExplorerChoices(snapshots);
			const picked = await ctx.ui.select("Inspect explorer", choices);
			if (!picked) return;
			const snapshot = snapshots[choices.indexOf(picked)];
			if (!snapshot) return;
			await showInspector(ctx, snapshot);
		},
	});
}
