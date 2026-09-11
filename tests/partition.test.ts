import { describe, expect, it } from "vitest";
import { computeFanout } from "../src/partition.js";

describe("computeFanout", () => {
	it("floors at 2", () => {
		expect(computeFanout(3, 4)).toBe(2);
	});

	it("scales with one explorer per 8 files", () => {
		expect(computeFanout(24, 6)).toBe(3);
	});

	it("caps at maxFanout", () => {
		expect(computeFanout(400, 4)).toBe(4);
	});

	it("never exceeds maxFanout even when maxFanout is below the floor", () => {
		expect(computeFanout(100, 1)).toBe(1);
	});
});
