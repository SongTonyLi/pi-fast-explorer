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
