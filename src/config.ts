export interface AutoPromoteConfig {
	enabled: boolean;
	minFiles: number;
	minMatches: number;
}

export interface FastExplorerConfig {
	/** null means inherit the dispatching session's model. */
	model: string | null;
	thinking: string;
	maxFanout: number;
	concurrency: number;
	maxTurnsPerExplorer: number;
	minTotalBytes: number;
	autoPromote: AutoPromoteConfig;
	timeoutMs: number;
}

export const DEFAULT_CONFIG: FastExplorerConfig = {
	model: null,
	thinking: "off",
	maxFanout: 4,
	concurrency: 4,
	maxTurnsPerExplorer: 5,
	minTotalBytes: 51200,
	autoPromote: { enabled: true, minFiles: 15, minMatches: 60 },
	timeoutMs: 120000,
};

export type PartialConfig = Partial<Omit<FastExplorerConfig, "autoPromote">> & {
	autoPromote?: Partial<AutoPromoteConfig>;
};

export function resolveConfig(partial?: PartialConfig): FastExplorerConfig {
	const merged: FastExplorerConfig = {
		...DEFAULT_CONFIG,
		...partial,
		autoPromote: { ...DEFAULT_CONFIG.autoPromote, ...partial?.autoPromote },
	};

	if (merged.maxFanout < 1) {
		throw new Error(`fastExplorer.maxFanout must be at least 1, got ${merged.maxFanout}`);
	}
	// Fanning out wider than the concurrency limit produces multiple waves and
	// doubles wall-clock for no benefit. See spec, "Performance".
	if (merged.maxFanout > merged.concurrency) {
		throw new Error(
			`fastExplorer.maxFanout (${merged.maxFanout}) must not exceed concurrency (${merged.concurrency})`,
		);
	}
	return merged;
}
