import { afterEach, describe, expect, it } from "vitest";
import {
	formatExplorerChoices,
	formatExplorerTranscript,
	formatToolCall,
	formatWidgetLines,
	listExplorers,
	onExplorerChange,
	resetExplorers,
	shouldResetExplorers,
	upsertExplorer,
} from "../src/activity.js";
import { createAccumulator, extractDisplayItems, processLine } from "../src/explorer.js";
import { isInspectorCloseKey, liveTranscript, renderExploreCall, renderExploreResult } from "../src/ui.js";

afterEach(() => {
	resetExplorers();
});

function asstMsg(content: unknown[], extra?: Record<string, unknown>) {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			stopReason: "stop",
			...extra,
		},
	});
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("extractDisplayItems", () => {
	it("keeps tool calls from assistant messages", () => {
		const acc = createAccumulator();
		processLine(
			asstMsg([
				{ type: "toolCall", name: "grep", arguments: { pattern: "token", path: "src" } },
				{ type: "toolCall", name: "read", arguments: { path: "src/auth.ts" } },
			]),
			acc,
		);
		expect(extractDisplayItems(acc)).toEqual([
			{ type: "toolCall", name: "grep", args: { pattern: "token", path: "src" } },
			{ type: "toolCall", name: "read", args: { path: "src/auth.ts" } },
		]);
	});

	it("shows tool_execution_start before the assistant message lists the call", () => {
		const acc = createAccumulator();
		processLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "find",
				args: { pattern: "*.ts", path: "src" },
			}),
			acc,
		);
		expect(extractDisplayItems(acc)).toEqual([
			{ type: "toolCall", name: "find", args: { pattern: "*.ts", path: "src" } },
		]);
	});

	it("does not duplicate a pending execution once message_end already listed it", () => {
		const acc = createAccumulator();
		processLine(
			asstMsg([{ type: "toolCall", name: "ls", arguments: { path: "src" } }]),
			acc,
		);
		processLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "ls",
				args: { path: "src" },
			}),
			acc,
		);
		expect(extractDisplayItems(acc)).toEqual([{ type: "toolCall", name: "ls", args: { path: "src" } }]);
	});

	it("keeps a started tool after it ends so the inspector does not go blank", () => {
		const acc = createAccumulator();
		processLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "read",
				args: { path: "a.ts" },
			}),
			acc,
		);
		processLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "read" }), acc);
		expect(extractDisplayItems(acc)).toEqual([{ type: "toolCall", name: "read", args: { path: "a.ts" } }]);
	});

	it("shows the next turn's starts while the last assistant message still lists the previous tools", () => {
		const acc = createAccumulator();
		processLine(asstMsg([{ type: "toolCall", name: "grep", arguments: { pattern: "one" } }]), acc);
		processLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "c2",
				toolName: "read",
				args: { path: "src/two.ts" },
			}),
			acc,
		);
		expect(extractDisplayItems(acc)).toEqual([
			{ type: "toolCall", name: "grep", args: { pattern: "one" } },
			{ type: "toolCall", name: "read", args: { path: "src/two.ts" } },
		]);
	});

	it("does not re-append leftover pending after a text-only final message", () => {
		const acc = createAccumulator();
		processLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "grep",
				args: { pattern: "token", path: "src" },
			}),
			acc,
		);
		processLine(
			asstMsg([{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "token", path: "src" } }]),
			acc,
		);
		processLine(asstMsg([{ type: "text", text: "## Files Retrieved" }]), acc);
		expect(extractDisplayItems(acc)).toEqual([
			{ type: "toolCall", name: "grep", args: { pattern: "token", path: "src" } },
			{ type: "text", text: "## Files Retrieved" },
		]);
	});
});

describe("formatToolCall", () => {
	it("formats the read-only explorer tools", () => {
		expect(formatToolCall("read", { path: "src/auth.ts", offset: 10, limit: 20 })).toBe(
			"read src/auth.ts:10-29",
		);
		expect(formatToolCall("grep", { pattern: "token", path: "src" })).toBe("grep /token/ in src");
		expect(formatToolCall("find", { pattern: "*.ts", path: "lib" })).toBe("find *.ts in lib");
		expect(formatToolCall("ls", { path: "src" })).toBe("ls src");
	});
});

describe("explorer registry", () => {
	it("lists explorers in insert order and keeps them inspectable after they finish", () => {
		upsertExplorer({ id: "fx-1", brief: "auth", status: "running", items: [], report: "" });
		upsertExplorer({
			id: "fx-2",
			brief: "tokens",
			status: "ok",
			items: [{ type: "toolCall", name: "grep", args: { pattern: "refresh" } }],
			report: "## Files",
		});
		expect(listExplorers().map((s) => s.id)).toEqual(["fx-1", "fx-2"]);
		const choices = formatExplorerChoices(listExplorers());
		expect(choices[0]).toContain("auth");
		expect(choices[1]).toContain("grep /refresh/");
		expect(formatWidgetLines(listExplorers())[0]).toMatch(/1 running/);
		expect(formatWidgetLines(listExplorers()).join("\n")).toContain("/explorers to inspect");
		expect(formatWidgetLines(listExplorers()).join("\n")).not.toMatch(/\[[ x]\]/);
	});

	it("never evicts a running explorer when the retain cap is exceeded", () => {
		for (let i = 1; i <= 20; i++) {
			upsertExplorer({ id: `fx-${i}`, brief: `b${i}`, status: "running", items: [], report: "" });
		}
		expect(listExplorers()).toHaveLength(20);
		expect(listExplorers().every((s) => s.status === "running")).toBe(true);
		upsertExplorer({ id: "fx-done", brief: "settled", status: "ok", items: [], report: "" });
		expect(listExplorers().filter((s) => s.status === "running")).toHaveLength(20);
		expect(listExplorers().some((s) => s.id === "fx-done")).toBe(false);
	});

	it("resets on a new session but not on reload", () => {
		expect(shouldResetExplorers("startup")).toBe(true);
		expect(shouldResetExplorers("new")).toBe(true);
		expect(shouldResetExplorers("resume")).toBe(true);
		expect(shouldResetExplorers("fork")).toBe(true);
		expect(shouldResetExplorers("reload")).toBe(false);
	});

	it("rebuilds a live transcript from the registry after later upserts", () => {
		const initial = { id: "fx-1", brief: "auth", status: "running" as const, items: [], report: "" };
		upsertExplorer(initial);
		expect(liveTranscript("fx-1", initial).join("\n")).toContain("starting");
		upsertExplorer({
			id: "fx-1",
			brief: "auth",
			status: "running",
			items: [{ type: "toolCall", name: "grep", args: { pattern: "session" } }],
			report: "",
		});
		expect(liveTranscript("fx-1", initial).join("\n")).toContain("grep /session/");
	});

	it("notifies inspectors when an explorer changes", () => {
		let ticks = 0;
		const stop = onExplorerChange(() => {
			ticks++;
		});
		upsertExplorer({ id: "fx-1", brief: "a", status: "running", items: [], report: "" });
		stop();
		upsertExplorer({ id: "fx-1", brief: "a", status: "ok", items: [], report: "" });
		expect(ticks).toBe(1);
	});

	it("builds a transcript of tool calls, not a checklist", () => {
		const lines = formatExplorerTranscript({
			id: "fx-1",
			brief: "how does auth work",
			status: "running",
			items: [
				{ type: "toolCall", name: "grep", args: { pattern: "session" } },
				{ type: "text", text: "## Files Retrieved" },
			],
			report: "## Files Retrieved",
		});
		expect(lines.some((l) => l.startsWith("→ grep"))).toBe(true);
		expect(lines.join("\n")).not.toMatch(/\[ \]|\[x\]|TODO|checklist/i);
	});
});

describe("explore TUI renderers", () => {
	it("names the question on the call row", () => {
		const view = renderExploreCall({ question: "how does auth work" }, theme);
		expect(view.render(80).join("\n")).toContain("how does auth work");
	});

	it("shows live tool calls so a running explorer is inspectable", () => {
		const view = renderExploreResult(
			{
				content: [{ type: "text", text: "0/1 explorers done" }],
				details: {
					live: [
						{
							id: "fx-1",
							brief: "how does auth work",
							status: "running",
							items: [{ type: "toolCall", name: "grep", args: { pattern: "session", path: "src" } }],
							report: "",
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);
		const text = view.render(80).join("\n");
		expect(text).toContain("grep /session/ in src");
		expect(text).toContain("/explorers to inspect");
		expect(text).not.toMatch(/\[ \]|checklist/i);
	});

	it("wraps tool-row lines to the given width", () => {
		const view = renderExploreCall({ question: "how does authentication token refresh work across files" }, theme);
		expect(view.render(24).every((line) => line.length <= 24)).toBe(true);
	});

	it("prints a failed explorer's error on the tool row", () => {
		const view = renderExploreResult(
			{
				content: [{ type: "text", text: "failed" }],
				details: {
					live: [
						{
							id: "fx-1",
							brief: "auth",
							status: "failed",
							items: [],
							report: "",
							error: "Explorer timed out after 120000ms",
						},
					],
				},
			},
			{ expanded: false },
			theme,
		);
		expect(view.render(80).join("\n")).toContain("Explorer timed out after 120000ms");
	});

	it("closes the inspector on escape sequences and Ctrl+C", () => {
		expect(isInspectorCloseKey("\x1b")).toBe(true);
		expect(isInspectorCloseKey("\x1b[27u")).toBe(true);
		expect(isInspectorCloseKey("\x03")).toBe(true);
		expect(isInspectorCloseKey("q")).toBe(true);
		expect(isInspectorCloseKey("x")).toBe(false);
	});
});
