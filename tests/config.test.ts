import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
	it("returns defaults when given nothing", () => {
		expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
	});

	// Pinned so the number is changed on purpose, never drifted into. It was 5,
	// and 5 was measured turning successful runs into failures: 7 of 60 benchmark
	// runs exceeded it, 5 of them at exactly 6 turns with full recall. Raising it
	// is not "allowing slower explorers" — prompts/explorer.md still asks for about
	// 3 turns — it is removing a bound that only ever fired on work that had
	// already succeeded. Lower it again only against fresh measurement.
	it("defaults the advisory turn budget to 8", () => {
		expect(resolveConfig().maxTurnsPerExplorer).toBe(8);
	});

	it("deep-merges autoPromote instead of replacing it", () => {
		const cfg = resolveConfig({ autoPromote: { minFiles: 5 } });
		expect(cfg.autoPromote.minFiles).toBe(5);
		expect(cfg.autoPromote.enabled).toBe(true);
		expect(cfg.autoPromote.minMatches).toBe(60);
	});

	it("rejects maxFanout greater than concurrency", () => {
		expect(() => resolveConfig({ maxFanout: 6, concurrency: 4 })).toThrow(/maxFanout/);
	});

	it("rejects maxFanout below 1", () => {
		expect(() => resolveConfig({ maxFanout: 0 })).toThrow(/maxFanout/);
	});

	it("accepts maxFanout equal to concurrency", () => {
		expect(resolveConfig({ maxFanout: 8, concurrency: 8 }).maxFanout).toBe(8);
	});
});
