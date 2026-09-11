import { dirname } from "node:path";
import type { FastExplorerConfig } from "./config.js";

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

export interface ExploreDecision {
	explore: boolean;
	reason: string;
}

/**
 * The byte half of the promotion decision: is there enough material here that
 * spawning LLM subprocesses beats just handing the matches to the main agent?
 *
 * Breadth is deliberately NOT re-checked here. `shouldAutoPromote` owns the
 * question "is this a sweep worth promoting", on breadth or on density;
 * `shouldExplore` owns only "is it big enough to be worth the overhead".
 *
 * The seam used to be drawn differently and the two gates contradicted each
 * other: this function also required `fileCount >= autoPromote.minFiles`, the
 * very same threshold `shouldAutoPromote`'s density branch fires *below*. Every
 * match-dense result was promoted by one gate and then immediately rejected by
 * the other, which made `autoPromote.minMatches` dead config. Keep the
 * responsibilities split; do not reintroduce a file count here.
 */
export function shouldExplore(totalBytes: number, cfg: FastExplorerConfig): ExploreDecision {
	if (totalBytes < cfg.minTotalBytes) {
		return {
			explore: false,
			reason: `${totalBytes} bytes is below the ${cfg.minTotalBytes} byte threshold`,
		};
	}
	return { explore: true, reason: "" };
}
