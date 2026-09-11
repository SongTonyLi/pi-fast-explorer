import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
	it("returns defaults when given nothing", () => {
		expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
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
