import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type FastExplorerConfig, loadConfigFrom } from "../src/config.js";

let dir: string;
let userPath: string;
let projectPath: string;

/** A recognisable non-default config, to prove failures preserve it. */
const PREVIOUS: FastExplorerConfig = { ...DEFAULT_CONFIG, maxTurnsPerExplorer: 99 };

function writeUser(json: string) {
	writeFileSync(userPath, json, "utf8");
}

function writeProject(json: string) {
	writeFileSync(projectPath, json, "utf8");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fast-explorer-config-"));
	userPath = join(dir, "user.json");
	projectPath = join(dir, "project.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadConfigFrom", () => {
	it("returns defaults when neither file is present", () => {
		const result = loadConfigFrom(userPath, projectPath, true);
		expect(result.error).toBeUndefined();
		expect(result.config).toEqual(DEFAULT_CONFIG);
	});

	it("applies the user file when it is the only source", () => {
		writeUser(JSON.stringify({ maxTurnsPerExplorer: 9, thinking: "low" }));
		const result = loadConfigFrom(userPath, projectPath, true);
		expect(result.error).toBeUndefined();
		expect(result.config.maxTurnsPerExplorer).toBe(9);
		expect(result.config.thinking).toBe("low");
		expect(result.config.maxFanout).toBe(DEFAULT_CONFIG.maxFanout);
	});

	it("lets the project file win on overlapping keys while user-only keys survive", () => {
		writeUser(JSON.stringify({ maxTurnsPerExplorer: 9, timeoutMs: 1000 }));
		writeProject(JSON.stringify({ timeoutMs: 2000 }));
		const result = loadConfigFrom(userPath, projectPath, true);
		expect(result.error).toBeUndefined();
		expect(result.config.timeoutMs).toBe(2000);
		expect(result.config.maxTurnsPerExplorer).toBe(9);
	});

	it("ignores the project file entirely when the project is untrusted", () => {
		writeUser(JSON.stringify({ timeoutMs: 1000 }));
		writeProject(JSON.stringify({ timeoutMs: 2000, model: "attacker/model" }));
		const result = loadConfigFrom(userPath, projectPath, false);
		expect(result.error).toBeUndefined();
		expect(result.config.timeoutMs).toBe(1000);
		expect(result.config.model).toBeNull();
	});

	it("does not even report a malformed project file when untrusted", () => {
		writeProject("{ not json");
		const result = loadConfigFrom(userPath, projectPath, false);
		expect(result.error).toBeUndefined();
		expect(result.config).toEqual(DEFAULT_CONFIG);
	});

	it("lets the wrapper-supplied userConfig outrank both files", () => {
		writeUser(JSON.stringify({ timeoutMs: 1000 }));
		writeProject(JSON.stringify({ timeoutMs: 2000 }));
		const result = loadConfigFrom(userPath, projectPath, true, { timeoutMs: 3000 });
		expect(result.config.timeoutMs).toBe(3000);
	});

	it("deep-merges autoPromote across layers instead of replacing it", () => {
		writeUser(JSON.stringify({ autoPromote: { minFiles: 5 } }));
		writeProject(JSON.stringify({ autoPromote: { minMatches: 7 } }));
		const result = loadConfigFrom(userPath, projectPath, true);
		expect(result.error).toBeUndefined();
		expect(result.config.autoPromote).toEqual({ enabled: true, bash: true, minFiles: 5, minMatches: 7 });
	});

	it("preserves the previous config and reports malformed JSON rather than throwing", () => {
		writeUser("{ definitely not json ");
		const result = loadConfigFrom(userPath, projectPath, true, undefined, PREVIOUS);
		expect(result.config).toEqual(PREVIOUS);
		expect(result.error).toBeTruthy();
	});

	it("preserves the previous config when a value violates maxFanout <= concurrency", () => {
		writeUser(JSON.stringify({ maxFanout: 6, concurrency: 4 }));
		const result = loadConfigFrom(userPath, projectPath, true, undefined, PREVIOUS);
		expect(result.config).toEqual(PREVIOUS);
		expect(result.error).toMatch(/maxFanout/);
	});

	it("rejects a value of the wrong type instead of letting it become NaN", () => {
		writeUser(JSON.stringify({ maxFanout: "four" }));
		const result = loadConfigFrom(userPath, projectPath, true, undefined, PREVIOUS);
		expect(result.config).toEqual(PREVIOUS);
		expect(result.error).toMatch(/maxFanout/);
	});

	it("rejects an unknown key so a misspelling is visible", () => {
		writeUser(JSON.stringify({ maxFanOut: 2 }));
		const result = loadConfigFrom(userPath, projectPath, true, undefined, PREVIOUS);
		expect(result.config).toEqual(PREVIOUS);
		expect(result.error).toMatch(/unknown key/);
	});

	it("rejects a JSON file whose top level is not an object", () => {
		writeUser(JSON.stringify([1, 2, 3]));
		const result = loadConfigFrom(userPath, projectPath, true, undefined, PREVIOUS);
		expect(result.config).toEqual(PREVIOUS);
		expect(result.error).toMatch(/expected a JSON object/);
	});

	it("names the offending file in the error", () => {
		writeProject(JSON.stringify({ thinking: 5 }));
		const result = loadConfigFrom(userPath, projectPath, true, undefined, PREVIOUS);
		expect(result.error).toContain(projectPath);
	});
});
