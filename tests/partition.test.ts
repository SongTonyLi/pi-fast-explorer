import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { bucketByDirectory, computeFanout, shouldExplore } from "../src/partition.js";

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

describe("bucketByDirectory", () => {
	it("keeps a directory's files together", () => {
		const files = ["a/1.ts", "a/2.ts", "a/3.ts", "b/1.ts", "b/2.ts", "c/1.ts"];
		const buckets = bucketByDirectory(files, 3);
		const bucketOf = (f: string) => buckets.findIndex((b) => b.includes(f));
		expect(bucketOf("a/1.ts")).toBe(bucketOf("a/2.ts"));
		expect(bucketOf("a/1.ts")).toBe(bucketOf("a/3.ts"));
		expect(bucketOf("b/1.ts")).toBe(bucketOf("b/2.ts"));
	});

	it("places every file exactly once", () => {
		const files = ["a/1.ts", "a/2.ts", "b/1.ts", "c/1.ts", "d/1.ts"];
		const flat = bucketByDirectory(files, 3).flat().sort();
		expect(flat).toEqual([...files].sort());
	});

	it("drops empty buckets", () => {
		expect(bucketByDirectory(["a/1.ts"], 4)).toEqual([["a/1.ts"]]);
	});

	it("returns empty for no files", () => {
		expect(bucketByDirectory([], 3)).toEqual([]);
	});
});

describe("shouldExplore", () => {
	const cfg = resolveConfig();

	it("skips when total bytes are below the floor", () => {
		const d = shouldExplore(1024, cfg);
		expect(d.explore).toBe(false);
		expect(d.reason).toMatch(/bytes/);
	});

	it("explores once the byte floor is cleared", () => {
		expect(shouldExplore(500_000, cfg).explore).toBe(true);
	});

	it("treats the floor as inclusive", () => {
		expect(shouldExplore(cfg.minTotalBytes, cfg).explore).toBe(true);
	});

	// Regression, and the reason the signature is what it is. This gate used to
	// take a fileCount and re-apply `autoPromote.minFiles`, which made the
	// match-density trigger unreachable: a dense result is by definition below
	// that floor, so shouldAutoPromote promoted it and shouldExplore instantly
	// rejected it, leaving `autoPromote.minMatches` as dead config. Breadth
	// belongs to shouldAutoPromote; this is a byte question only. Arity is
	// asserted so that reintroducing a file-count parameter fails here loudly.
	it("takes only bytes and config, never a file count", () => {
		expect(shouldExplore.length).toBe(2);
	});
});
