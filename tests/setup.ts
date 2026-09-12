import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Every spill file the auto-promotion tests write, and every fixture the
 * others create, lands in `os.tmpdir()`. Left at the real temp directory that
 * was 334 `fx-matches-*.txt` files after a few days of `npm test`, because
 * spill files are never deleted by design (README: the model may still want to
 * read one). Node re-reads TMPDIR on every `os.tmpdir()` call, so pointing it
 * at a per-worker directory here isolates the whole suite, and the directory is
 * removed when the worker's files are done.
 */
const root = mkdtempSync(join(tmpdir(), "fx-tests-"));
process.env.TMPDIR = root;

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});
