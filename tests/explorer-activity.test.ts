import { afterEach, describe, expect, it } from "vitest";
import {
	formatExplorerChoices,
	formatExplorerTranscript,
	formatToolCall,
	formatWidgetLines,
	listExplorers,
	resetExplorers,
	upsertExplorer,
} from "../src/activity.js";
import { createAccumulator, extractDisplayItems, processLine } from "../src/explorer.js";
import { renderExploreCall, renderExploreResult } from "../src/ui.js";

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

	it("drops a pending tool when its execution ends", () => {
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
		expect(extractDisplayItems(acc)).toEqual([]);
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
});
