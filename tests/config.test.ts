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
	// already succeeded.
	//
	// Lowering it again HAS been tried against fresh measurement: 6 was benchmarked
	// on 2026-09-11 (sweep 08-29-29) and bought no latency back — ratio 1.35 at cap
	// 6 against 1.34 at cap 8 — while leaving bash-approval's median recall at 0.80.
	// The evidence lived in the harness's
	// FINDINGS["turn-budget-not-a-latency-lever"] block. The harness ran against a
	// private corpus and is not part of this repository, so the summary in
	// src/config.ts is the surviving copy; read it before spending another sweep.
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

describe("deadline defaults", () => {
	// 120 s was measured killing a healthy explorer mid-report: seven tool turns
	// in 43 s, then a 123 s report-writing turn. The hard cap is a backstop; the
	// idle window is what catches a stalled explorer, and pi streams a delta per
	// token so a live one is never silent for long.
	it("defaults the hard cap to 300s and the idle window to 60s", () => {
		expect(resolveConfig().timeoutMs).toBe(300000);
		expect(resolveConfig().idleTimeoutMs).toBe(60000);
	});

	it("accepts an idle window override", () => {
		expect(resolveConfig({ idleTimeoutMs: 5000 }).idleTimeoutMs).toBe(5000);
	});
});

describe("escalation", () => {
	it("escalates unresolved checklist items by default", () => {
		expect(resolveConfig().escalateUnresolved).toBe(true);
	});
});
