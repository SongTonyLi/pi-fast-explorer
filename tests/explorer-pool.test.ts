import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../src/explorer.js";

describe("runWithConcurrency", () => {
	it("never exceeds the concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		const tasks = Array.from({ length: 10 }, (_, i) => async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 20));
			active--;
			return i;
		});
		const out = await runWithConcurrency(tasks, 3);
		// Exactly 3, not "at most 3": a serial pool would satisfy <= and defeat
		// the entire point of fanning out.
		expect(peak).toBe(3);
		expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("preserves input order in the output", async () => {
		const tasks = [
			async () => {
				await new Promise((r) => setTimeout(r, 40));
				return "slow";
			},
			async () => "fast",
		];
		expect(await runWithConcurrency(tasks, 2)).toEqual(["slow", "fast"]);
	});

	it("returns empty for no tasks", async () => {
		expect(await runWithConcurrency([], 4)).toEqual([]);
	});
});
