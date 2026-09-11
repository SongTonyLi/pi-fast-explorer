import { readFileSync } from "node:fs";

export interface AutoPromoteConfig {
	enabled: boolean;
	/**
	 * Whether `bash` results that parse as search output are promoted too.
	 *
	 * Separate from `enabled` because the risk profile is different, not because
	 * the feature is. A `grep` result is a search by construction; a `bash` result
	 * is whatever the model ran, so promoting it rests on gates that infer intent
	 * from output shape (see detect.ts). Anyone who trusts the first and not the
	 * second needs a switch that says exactly that.
	 */
	bash: boolean;
	minFiles: number;
	minMatches: number;
}

export interface FastExplorerConfig {
	/** null means inherit the dispatching session's model. */
	model: string | null;
	thinking: string;
	maxFanout: number;
	concurrency: number;
	/** Advisory only — see DEFAULT_CONFIG. pi has no turn-limit flag to enforce it. */
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
	/**
	 * A budget we ask explorers to come in under, NOT a guarantee. pi exposes no
	 * turn-limit flag, so this rides in the task text as a request the model is
	 * free to exceed; nothing in this package can stop it. Do not build anything
	 * that depends on turn count or per-explorer cost being bounded by this — the
	 * only hard stops are `timeoutMs` and the model's own context limit.
	 *
	 * 8, not 5, because 5 was measured failing runs that had already succeeded:
	 * across 60 benchmark runs, 7 exceeded the 5-turn budget, 5 of those landing
	 * on exactly 6 turns with recall 1.00. A bound that only converts successes
	 * into failures is doing harm without doing good. The pressure toward finishing
	 * fast lives in prompts/explorer.md ("aim for about 3 turns"), which is where it
	 * works; this number is the outer edge, set above the observed overrun rather
	 * than through it.
	 */
	maxTurnsPerExplorer: 8,
	minTotalBytes: 51200,
	autoPromote: { enabled: true, bash: true, minFiles: 15, minMatches: 60 },
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

const NUMBER_KEYS = [
	"maxFanout",
	"concurrency",
	"maxTurnsPerExplorer",
	"minTotalBytes",
	"timeoutMs",
] as const;

function typeError(source: string, key: string, expected: string, got: unknown): Error {
	return new Error(`${source}: "${key}" must be ${expected}, got ${JSON.stringify(got) ?? typeof got}`);
}

function validateAutoPromote(source: string, value: unknown): Partial<AutoPromoteConfig> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw typeError(source, "autoPromote", "an object", value);
	}
	const out: Partial<AutoPromoteConfig> = {};
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (v === undefined) continue;
		if (key === "enabled") {
			if (typeof v !== "boolean") throw typeError(source, "autoPromote.enabled", "a boolean", v);
			out.enabled = v;
		} else if (key === "bash") {
			if (typeof v !== "boolean") throw typeError(source, "autoPromote.bash", "a boolean", v);
			out.bash = v;
		} else if (key === "minFiles" || key === "minMatches") {
			if (typeof v !== "number" || !Number.isFinite(v)) {
				throw typeError(source, `autoPromote.${key}`, "a finite number", v);
			}
			out[key] = v;
		} else {
			throw new Error(`${source}: unknown key "autoPromote.${key}"`);
		}
	}
	return out;
}

/**
 * Validates parsed JSON into a PartialConfig.
 *
 * `resolveConfig` only range-checks, so without this a `"maxFanout": "four"`
 * would slip through every comparison and surface later as a NaN fanout. A
 * misspelled or mistyped key has to be an error the user sees, not a setting
 * that silently does nothing.
 */
export function validatePartialConfig(source: string, value: unknown): PartialConfig {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${source}: expected a JSON object`);
	}
	const out: PartialConfig = {};
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (v === undefined) continue;
		if (key === "model") {
			if (v !== null && typeof v !== "string") throw typeError(source, key, "a string or null", v);
			out.model = v;
		} else if (key === "thinking") {
			if (typeof v !== "string") throw typeError(source, key, "a string", v);
			out.thinking = v;
		} else if ((NUMBER_KEYS as readonly string[]).includes(key)) {
			if (typeof v !== "number" || !Number.isFinite(v)) {
				throw typeError(source, key, "a finite number", v);
			}
			out[key as (typeof NUMBER_KEYS)[number]] = v;
		} else if (key === "autoPromote") {
			out.autoPromote = validateAutoPromote(source, v);
		} else {
			throw new Error(`${source}: unknown key "${key}"`);
		}
	}
	return out;
}

/** Later layers win. `autoPromote` merges key-by-key rather than replacing. */
function mergePartials(layers: PartialConfig[]): PartialConfig {
	const out: PartialConfig = {};
	for (const layer of layers) {
		const { autoPromote, ...rest } = layer;
		Object.assign(out, rest);
		if (autoPromote) out.autoPromote = { ...out.autoPromote, ...autoPromote };
	}
	return out;
}

/** Returns undefined when the file is absent; throws when it is unreadable garbage. */
function readConfigFile(path: string): PartialConfig | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// A missing config file is the normal case, not a problem to report.
		return undefined;
	}
	return validatePartialConfig(path, JSON.parse(raw) as unknown);
}

export interface ConfigLoadResult {
	config: FastExplorerConfig;
	/** Set when the load failed. `config` is then the unchanged previous config. */
	error?: string;
}

/**
 * Merges the config layers, lowest precedence first: defaults, the user file,
 * the project file, then the argument a wrapper extension passed in.
 *
 * Takes plain paths rather than a pi context so it stays testable against
 * fixture files. Never throws: a broken config keeps `previous` and reports
 * why, because a typo must not be able to end a session.
 */
export function loadConfigFrom(
	userFilePath: string,
	projectFilePath: string,
	projectTrusted: boolean,
	userConfig?: PartialConfig,
	previous: FastExplorerConfig = DEFAULT_CONFIG,
): ConfigLoadResult {
	try {
		const layers: PartialConfig[] = [];

		const fromUser = readConfigFile(userFilePath);
		if (fromUser) layers.push(fromUser);

		// The project file lives in the repository, so in an untrusted checkout
		// it is attacker-supplied content. `model` would redirect exploration to
		// a model of the repo's choosing and `timeoutMs` could stall the session,
		// both without the user ever seeing a prompt. Do not drop this gate.
		if (projectTrusted) {
			const fromProject = readConfigFile(projectFilePath);
			if (fromProject) layers.push(fromProject);
		}

		if (userConfig) layers.push(userConfig);

		return { config: resolveConfig(mergePartials(layers)) };
	} catch (error) {
		return { config: previous, error: error instanceof Error ? error.message : String(error) };
	}
}
