# pi-fast-explorer

An extension for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that moves broad code-reading off the main agent's context and onto parallel read-only subagents.

## The problem

When a pi agent needs to understand code spanning many files, it reads them one at a time into its own context. A 40-file sweep can cost 300k tokens, and every one of those tokens is then dragged through every later turn of the session until compaction throws them away. The cost is not only the tokens: a context full of half-relevant file contents is also a context the model has to reason around.

pi's per-call truncation (50 KB / 2000 lines) bounds a single result but has no notion of how many results accumulate, and auto-compaction fires only near the end of the window, by which point the sweep has been paid for many times over.

fast-explorer fans that reading out to explorer subagents. Each explorer is a separate `pi` process with its own context window, restricted to `read`, `grep`, `find` and `ls`. The main agent gets back cited findings — `file:line`, plus verbatim excerpts of the code that matters — instead of the file contents.

Two entry paths:

- **The `explore` tool** — the model calls it when it knows a sweep is coming.
- **Auto-promotion** — a `tool_result` hook intercepts `grep`/`find` results that span many files and converts them into parallel exploration without being asked. This path matters more in practice, because the common failure is the model *not* knowing a sweep was coming.

## Requirements

- Node >= 22.19.0
- `pi` >= 0.85.0 on `PATH` (explorers are spawned as `pi` subprocesses)
- A working pi provider/model configuration — explorers make real model calls

## Install

```bash
npm install -g pi-fast-explorer
```

Then register it with pi. Add the installed entry point to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/opt/homebrew/lib/node_modules/pi-fast-explorer/dist/index.js"]
}
```

Replace the prefix with your own global root (`npm root -g`). To try it for a single session without editing settings:

```bash
pi -e "$(npm root -g)/pi-fast-explorer/dist/index.js"
```

**On the symlink convention.** pi also auto-discovers extensions from `~/.pi/agent/extensions/` — `*.ts`, `*.js`, or a subdirectory containing `index.ts`/`index.js` (see "Extension Locations" in pi's `docs/extensions.md`). That is the layout pi's own examples use, but it does not work for this package as published, and the failure is quiet rather than loud. A directory entry is discovered only if it contains `index.ts`/`index.js` at its top level or declares `pi.extensions` in its `package.json`; this package has neither, so symlinking the package root discovers nothing. Symlinking `dist/` instead *is* discovered — but pi loads the entry through the symlink path rather than its real path, so the extension resolves its explorer prompt to `~/.pi/agent/extensions/prompts/explorer.md`, which does not exist, and every explorer then runs without its output contract. Verified against pi 0.85.1. Use the settings entry above.

## The `explore` tool

```ts
explore({
  question: string,      // what you need to find out
  questions?: string[],  // pre-decomposed sub-questions, one per explorer
  scope?: string,        // glob or directory to limit the search
  fanout?: number,       // lower the number of explorers for this call
})
```

**Supply `questions` when you can.** It is the difference between one explorer and several. With `questions`, each entry becomes one explorer's brief and they run concurrently; without it, `question` becomes a single brief and exactly one explorer runs. There is no planner subagent that decomposes for you — that was in the original design and is not in the code — so a `question`-only call buys context isolation but no parallelism. Supplying `questions` also removes a round-trip: the main agent is already reasoning when it decides to explore, so it can decompose in the turn it already occupies instead of blocking on a separate planning call.

`questions` is truncated to `maxFanout` entries. `fanout` is clamped into `[1, maxFanout]`, so it can only narrow a call, never widen it past the configured ceiling.

`scope` is appended to each brief as "Limit your search to: …". It is an instruction to the explorer, not an enforced filter — an explorer that ignores it is not prevented from reading elsewhere in the repository.

The tool returns the concatenated explorer reports. Explorers that failed, timed out or produced nothing are listed by name under a `## Not Covered` heading rather than dropped, so the main agent can see which part of the tree is unverified. Explorer token usage and cost are reported back to pi, so they appear in session totals.

## Auto-promotion

The `tool_result` hook watches successful `grep` and `find` results. It promotes when the result looks like a sweep **and** there is enough material to be worth the overhead. Those are two separate gates:

**Is it a sweep?** (`shouldAutoPromote`, breadth *or* density — not a single threshold)

- `files >= autoPromote.minFiles` (default 15) — breadth, or
- `matches >= autoPromote.minMatches` (default 60) **and** `files >= 3` — density

The `files >= 3` floor on the density branch exists so that one file with a thousand matches is treated as the narrow search it is, not as a sweep.

**Is it worth it?** (`shouldExplore`) The matched files' sizes are summed — with an early exit as soon as the floor is cleared — and promotion is abandoned if the total is below `minTotalBytes` (default 50 KB). Below that floor, letting the main agent read the files directly is both faster and higher fidelity.

When both gates pass:

1. The raw grep/find text is written to a spill file in the per-user temp directory, mode `0600`.
2. The matched paths are re-anchored on the session cwd (grep and find emit paths relative to their own search root) and bucketed by directory into `clamp(ceil(files / 8), 2, maxFanout)` groups.
3. One explorer runs per bucket, with a brief naming the pattern, the scope, and the total file count.
4. The tool result the model sees is **replaced** by the synthesized findings, followed by the spill file path.

Nothing is destroyed: the full match list is on disk and its path is in the result. The model can read it if the findings are not enough.

Grep and find briefs are phrased differently on purpose. A grep pattern carries real intent, so the brief leans on it. A glob carries none — `**/*.ts` says only "these are TypeScript files" — so that brief asks what the files *are* rather than inviting the explorer to invent a purpose.

Auto-promotion is a trade, not a free win. A grep the model intended as a quick existence check becomes several seconds of exploration and a model call per bucket. Set `autoPromote.enabled` to `false` to keep only the explicit `explore` tool.

## Configuration

Defaults:

```json
{
  "model": null,
  "thinking": "off",
  "maxFanout": 4,
  "concurrency": 4,
  "maxTurnsPerExplorer": 5,
  "minTotalBytes": 51200,
  "autoPromote": { "enabled": true, "minFiles": 15, "minMatches": 60 },
  "timeoutMs": 120000
}
```

| Key | Meaning |
|---|---|
| `model` | Model id for explorers. `null` inherits the dispatching session's model, which is the default because a weaker model deciding what matters in unfamiliar code is the largest quality risk here. Setting it to a cheaper model is where the cost saving lives. |
| `thinking` | Thinking level passed to each explorer (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Off by default even when the model is inherited: retrieval is not reasoning, and per-turn latency dominates wall-clock. |
| `maxFanout` | Maximum explorers per call. Must not exceed `concurrency`. |
| `concurrency` | Ceiling on explorers running at once, extension-wide (see limitations). |
| `maxTurnsPerExplorer` | Turn budget written into each explorer's task text. pi has no turn-limit flag, so this is a prompt-level bound, not an enforced one. |
| `minTotalBytes` | Byte floor below which exploration is skipped and the original result is left alone. |
| `autoPromote.enabled` | Turns the `grep`/`find` hook off without affecting the `explore` tool. |
| `autoPromote.minFiles` | Breadth threshold — distinct matched files. |
| `autoPromote.minMatches` | Density threshold — total matches, requires at least 3 files. |
| `timeoutMs` | Per-explorer wall-clock limit. On expiry the child gets `SIGTERM`, then `SIGKILL` after a 5-second grace period, and its bucket is reported as not covered. |

`maxFanout > concurrency` is rejected: fanning wider than the concurrency limit produces two waves and roughly doubles wall-clock for no benefit.

### How config is loaded

Config is read at every `session_start`, from two files, both optional, both containing the keys above at the top level (no wrapper key):

| Layer | Path | Read when |
|---|---|---|
| Defaults | — | always |
| User | `~/.pi/agent/fast-explorer.json` | always |
| Project | `<project>/.pi/fast-explorer.json` | **only when the project is trusted** |

Project overrides user; both override defaults. `autoPromote` merges key by key, so setting only `minFiles` in one layer leaves `enabled` and `minMatches` from the layer below. (If you load this extension from a wrapper extension that passes a config object to the factory, that object is applied last, above both files.)

**Why the project file is trust-gated.** `<project>/.pi/fast-explorer.json` lives inside the repository, so in a freshly cloned, untrusted checkout it is attacker-controlled content. `model` would redirect every explorer to a model of the repository's choosing, and `timeoutMs` could stall the session — neither with any prompt to the user. A repository does not get to make those choices on your behalf, so the project layer is skipped entirely until you trust the project. The user file is always read.

**Invalid config is reported and ignored, not silently replaced.** Unknown keys, wrong types and out-of-range values all fail the whole load with a message naming the file and the key; the previously resolved config stays in effect and a warning goes to `ctx.ui.notify`. A typo does not end the session, and it does not quietly reset your settings to the defaults either. The one gap is headless mode — see limitations.

## Read-only guarantee

Explorers are spawned with `--tools read,grep,find,ls`. `bash` is absent, as are `edit` and `write`. This is structural, not prompt-level: an explorer cannot modify the repository or run a command regardless of what its briefing says, what a file it reads tells it to do, or how it is prompt-injected. The capability cost is low, because pi's `grep` is ripgrep-backed and needs no shell.

Full explorer invocation:

```
pi --mode json -p --no-session --no-extensions \
   [--model <configured or inherited>] \
   --thinking <thinking> \
   --tools read,grep,find,ls \
   --append-system-prompt <package>/prompts/explorer.md \
   "Task: <brief>

Complete this in at most <maxTurnsPerExplorer> turns."
```

## Why explorers run with `--no-extensions`

This flag is load-bearing. Do not remove it.

Without it, pi's extension discovery runs inside every explorer, which means every explorer loads *this extension*. The explorer prompt instructs explorers to issue every independent search in a single message, so each explorer fires many greps — and each of those grep results hits the auto-promotion hook, which spawns another wave of explorers, each of which does the same. The branching factor is per grep, not per explorer: measured at roughly 40 per level, one level is 40 processes, two is ~1,600, three is ~64,000.

Verified against pi 0.85.1: neither print mode (`-p`) nor `--no-session` stops extension discovery. `--no-extensions` is what stops it.

There is a second layer, because `--no-extensions` cannot cover everything: explicit `-e <path>` loads still work with that flag set, and discovery is never consulted for them. So every explorer is spawned with `PI_FAST_EXPLORER_NESTED=1` in its environment (inherited by the whole subtree), and the auto-promotion hook's very first action is to return early when it sees that variable. Either layer alone would hold today; both are cheap and the failure mode is a fork bomb.

## When not to use it

- **Fewer than a handful of files.** The `explore` tool's own guidance is "more than ~5 files"; auto-promotion needs 15 files, or 60 matches across at least 3. Each explorer pays a fixed cost — process spawn, system prompt, tool definitions, `AGENTS.md` — and over-fanning a small job is pure loss.
- **Under the byte floor.** Below `minTotalBytes` (50 KB of candidate files), reading directly is faster and loses nothing.
- **You already know the exact file and line.** Read it.
- **Edit-heavy work.** Explorers cannot edit. Exploration that only precedes a one-line change was probably not worth a subprocess.
- **Interactive debugging.** When you need to iterate against real output, a summarized index of the code is the wrong shape and explorers have no `bash` to reproduce anything with.

## Known limitations

These were found while building it. They are trades, not bugs to be surprised by later.

1. **Partition blindness.** Splitting the work by file cuts cross-file relationships. One explorer sees the caller, another sees the callee, and neither notices that they disagree. Directory-grouped bucketing keeps modules together and reduces this; no partition scheme eliminates it. The `## Architecture` and `## Not Covered` sections of each report are the mitigation, not a fix.

2. **`concurrency` is an extension-wide ceiling, not a per-call one.** Both entry paths draw on the same budget. This is deliberate — a model can issue ten greps in one message, and a per-call limit would let ten hooks each land `concurrency` explorers on the machine at once — but the consequence is that a batch of ten promotable greps serializes at four explorers at a time rather than running wide.

3. **Signals reach only the direct child.** Timeout and abort send `SIGTERM`/`SIGKILL` to the `pi` process that was spawned. If that process has spawned its own children, they are not signalled. `detached: true` plus `kill(-pid)` would cover them, but it changes stdio and signal semantics and has no Windows equivalent, so it was rejected; the grandchildren here are short-lived search processes that exit on their own.

4. **Quote verification is indentation-insensitive, not byte-exact.** The verifier trims each line and skips blank ones before comparing a quoted block against the file on disk. Models reflow indentation when quoting, and counting that as a hallucination would make the detector cry wolf on correct citations. Fabricated or paraphrased content still fails, and so does a quote whose line number is wrong. Note also that this verifier is a test and benchmark helper — reports returned to the main agent are **not** verified at runtime.

5. **Spill files are never deleted.** Auto-promotion writes the raw grep/find text to the per-user temp directory with mode `0600` and leaves it there, because the model may still want to read it at any later point in the session. The OS reaps the temp directory eventually, but a long session leaves a trail of `fx-matches-*.txt`.

6. **In headless mode, config warnings are invisible.** `ctx.ui.notify` is a no-op stub when there is no UI (`--mode json`, `-p`), so an invalid `fast-explorer.json` is ignored *silently* in exactly the contexts — scripts, CI — where nobody is watching the terminal anyway. The config still fails safe (previous values are kept); you just will not be told.

7. **Per-category cost fields are zero.** Only `cost.total` is available per explorer, so the aggregated usage reports a total but leaves the input/output/cache cost split at zero. Token counts are broken out correctly; cost breakdowns attribute all explorer spend to the total.

8. **Live end-to-end promotion has not been exercised against a real model.** Every gate, every helper and the subprocess runner are unit-tested (131 tests, including a stub subprocess emitting recorded pi JSON events, and a test that keeps `prompts/explorer.md` in sync with the citation parsers). No test has yet watched a real `grep` promote into real explorers and return synthesized findings.

9. **Brief file lists are capped at 40 paths per explorer.** A `find` sweep can return up to 1000 paths, and pasting hundreds of them into a prompt recreates inside the subprocess exactly the context bloat this extension exists to remove. When the cap bites, the explorer is told how many paths were withheld, so it reports on a sample knowingly rather than mistaking its slice for the whole set.

10. **Only true match lines count toward the density threshold.** In `grep`'s context-lines mode (`context > 0`), matched lines are emitted as `path:12: text` and surrounding context as `path-11- text`. The parser reads the former and skips the latter, so promotion still fires normally on a context-mode result — but `minMatches` is measured against matches, not against the much larger number of printed lines. A context-heavy result is smaller, for threshold purposes, than it looks on screen.

11. **Explorers do not know what they do not know.** The main agent holds the whole conversation; an explorer gets one brief. It will miss adjacent-but-relevant code. Related: every explorer re-reads the shared `types.ts`, which wastes tokens and can produce inconsistent descriptions of the same entity across reports.

12. **Non-determinism.** Parallel LLM calls give different answers across runs. This makes behaviour harder to test and harder to trust than a mechanical index would be.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest
npm run typecheck:tests
```

## License

MIT
