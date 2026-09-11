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
