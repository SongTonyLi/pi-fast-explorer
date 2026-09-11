import { describe, expect, it } from "vitest";
import { createAccumulator, extractDisplayItems, extractFinalText, processLine } from "../src/explorer.js";

function asstMsg(text: string, usage?: Record<string, unknown>) {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: usage ?? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			stopReason: "stop",
		},
	});
}

describe("processLine", () => {
	it("accumulates assistant messages and usage", () => {
		const acc = createAccumulator();
		processLine(asstMsg("first"), acc);
		processLine(asstMsg("second"), acc);
		expect(acc.usage.turns).toBe(2);
		expect(acc.usage.input).toBe(20);
		expect(acc.usage.cost).toBeCloseTo(0.02);
	});

	it("ignores malformed JSON without throwing", () => {
		const acc = createAccumulator();
		expect(() => processLine("{not json", acc)).not.toThrow();
		expect(acc.messages).toHaveLength(0);
	});

	it("ignores blank lines", () => {
		const acc = createAccumulator();
		processLine("   ", acc);
		expect(acc.messages).toHaveLength(0);
	});

	it("records tool_execution_start without counting a turn", () => {
		const acc = createAccumulator();
		processLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "grep",
				args: { pattern: "x" },
			}),
			acc,
		);
		expect(acc.usage.turns).toBe(0);
		expect(acc.pendingTools).toEqual([{ id: "t1", name: "grep", args: { pattern: "x" } }]);
		expect(extractDisplayItems(acc)).toEqual([{ type: "toolCall", name: "grep", args: { pattern: "x" } }]);
		processLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "grep" }), acc);
		expect(extractDisplayItems(acc)).toEqual([{ type: "toolCall", name: "grep", args: { pattern: "x" } }]);
	});

	it("records stopReason and errorMessage", () => {
		const acc = createAccumulator();
		processLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
			}),
			acc,
		);
		expect(acc.stopReason).toBe("error");
		expect(acc.errorMessage).toBe("boom");
	});
});

describe("extractFinalText", () => {
	it("returns the last non-empty assistant text", () => {
		const acc = createAccumulator();
		processLine(asstMsg("early"), acc);
		processLine(asstMsg("final report"), acc);
		expect(extractFinalText(acc)).toBe("final report");
	});

	it("skips trailing assistant messages with no text", () => {
		const acc = createAccumulator();
		processLine(asstMsg("real content"), acc);
		processLine(
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } }),
			acc,
		);
		expect(extractFinalText(acc)).toBe("real content");
	});

	it("returns empty string when nothing was produced", () => {
		expect(extractFinalText(createAccumulator())).toBe("");
	});
});
