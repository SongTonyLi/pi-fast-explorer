import { describe, expect, it } from "vitest";
import { buildBriefs } from "../src/index.js";

describe("buildBriefs", () => {
	it("uses caller-supplied questions verbatim, avoiding a planner call", () => {
		expect(buildBriefs({ question: "how does auth work", questions: ["find login", "find tokens"] }, 4))
			.toEqual(["find login", "find tokens"]);
	});

	it("caps supplied questions at maxFanout", () => {
		const qs = ["a", "b", "c", "d", "e", "f"];
		expect(buildBriefs({ question: "q", questions: qs }, 3)).toEqual(["a", "b", "c"]);
	});

	it("falls back to the single question when none are supplied", () => {
		expect(buildBriefs({ question: "how does auth work" }, 4)).toEqual(["how does auth work"]);
	});

	it("ignores an empty questions array", () => {
		expect(buildBriefs({ question: "q", questions: [] }, 4)).toEqual(["q"]);
	});

	it("drops blank questions", () => {
		expect(buildBriefs({ question: "q", questions: ["a", "  ", "b"] }, 4)).toEqual(["a", "b"]);
	});
});

describe("resolveExplorerModel", () => {
	it("inherits the session model together with its provider", async () => {
		const { resolveExplorerModel } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(
			resolveExplorerModel(resolveConfig(), { id: "deepseek/deepseek-v4.1-flash", provider: "openrouter" }),
		).toEqual({ id: "deepseek/deepseek-v4.1-flash", provider: "openrouter" });
	});

	it("uses a configured model string without inventing a provider", async () => {
		const { resolveExplorerModel } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(
			resolveExplorerModel(resolveConfig({ model: "openai/gpt-5.6" }), { id: "x", provider: "anthropic" }),
		).toEqual({ id: "openai/gpt-5.6" });
	});

	it("is null when neither config nor session names a model", async () => {
		const { resolveExplorerModel } = await import("../src/index.js");
		const { resolveConfig } = await import("../src/config.js");
		expect(resolveExplorerModel(resolveConfig(), undefined)).toBeNull();
	});
});
