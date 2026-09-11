import { dirname } from "node:path";

const FILES_PER_EXPLORER = 8;

/**
 * clamp(ceil(files / 8), 2, maxFanout).
 *
 * The final Math.min against maxFanout is applied last so a maxFanout of 1
 * wins over the floor of 2 — config is authoritative over the heuristic.
 */
export function computeFanout(fileCount: number, maxFanout: number): number {
	const scaled = Math.ceil(fileCount / FILES_PER_EXPLORER);
	return Math.min(maxFanout, Math.max(2, scaled));
}

/**
 * Greedy bin-packing: group files by directory, then place the largest group
 * into the currently smallest bucket. Keeps modules intact while staying
 * roughly balanced, which matters because wall-clock is set by the slowest
 * explorer, not the average one.
 */
export function bucketByDirectory(files: string[], n: number): string[][] {
	if (files.length === 0 || n < 1) return [];

	const groups = new Map<string, string[]>();
	for (const f of files) {
		const dir = dirname(f);
		const existing = groups.get(dir);
		if (existing) existing.push(f);
		else groups.set(dir, [f]);
	}

	const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
	const buckets: string[][] = Array.from({ length: n }, () => []);

	for (const group of ordered) {
		let smallest = 0;
		for (let i = 1; i < n; i++) {
			if (buckets[i]!.length < buckets[smallest]!.length) smallest = i;
		}
		buckets[smallest]!.push(...group);
	}

	return buckets.filter((b) => b.length > 0);
}
