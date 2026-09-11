# Limitations audit — pi-fast-explorer

**Date:** 2026-09-11 · **Branch:** `feat/v1-implementation` @ `af1bb37` · **pi:** 0.85.1 · **Node:** v22.22.2 (darwin 25.6.0)
**State at audit:** 345 tests passing across 19 files (`npx vitest --run`, re-run during this audit), both typechecks clean.

This is an audit, not a fix pass. Nothing under `src/`, `prompts/` or `bench/` was changed. Every
probe was run from `/tmp` against a build of `src/` placed in `/tmp/fx-dist`.

> **Since this audit, three of its findings have been fixed** — [2.1](#21-the-headline-a-stopreason-change-in-pi-turns-every-sweep-into-a-paid-no-op)/[2.2](#22-auto-promotion-replaces-the-tool-result-even-when-every-explorer-failed) (the `stopReason` inversion and the missing fallback),
> [2.4](#24-the-unmarked-failure-guarantee-is-vacuous-for-three-shapes-the-parser-cannot-see) (the parser's blind spots), and the size-cap half of [2.8](#28-quote-verification-reads-whole-files-with-no-size-cap-and-is-not-confined-to-the-repository).
> Each section below carries a **Status** line saying what changed. Everything else in this document
> still describes the code as it stands, and the measurements are all as taken at `af1bb37`.

**How to read the evidence tags.**

| Tag | Meaning |
|---|---|
| **Measured** | A number or an observation produced by running something — a benchmark artifact, or a probe run during this audit and reproduced here. |
| **Reasoned** | The mechanism is read out of code we can cite (ours or pi's) and follows necessarily, but nobody has executed the failing case. |
| **Suspected** | Plausible, mechanism partly understood, not verified. |

**Sourcing rule.** Every figure names the file and field it came from. Where a figure in the shipped
docs does not match its source, or has no source at all, that is recorded as a finding in
[§4](#4-numbers-that-do-not-match-their-source).

---

## 0. Headlines

1. **README limitation 15 is false, and the brief that commissioned this audit repeats the error.**
   pi does *not* swap `bash` for `powershell` on Windows. It uses Git Bash by default and `powershell`
   is opt-in. Shell searches promote normally on a default Windows install. See [1.15](#115-on-windows-shell-searches-are-not-promoted).
2. **The most important undocumented limitation is a two-part failure that a pi release can trigger
   on its own**: the extension treats any `stopReason` other than the literal string `"stop"` as an
   explorer failure, and auto-promotion replaces the model's tool result *even when every explorer
   failed*. Together, a change to pi's `stopReason` vocabulary silently converts every sweep into
   "Exploration produced no findings" — after paying for it. See [2.1](#21-the-headline-a-stopreason-change-in-pi-turns-every-sweep-into-a-paid-no-op).
3. **The "no failure reaches the caller unmarked" guarantee is scoped to blocks the parser can see**,
   and three ordinary markdown/comment shapes are invisible to it *and* to the checker that is
   supposed to prove the guarantee. See [2.4](#24-the-unmarked-failure-guarantee-is-vacuous-for-three-shapes-the-parser-cannot-see).
4. **The context table's numbers are correct but misattributed**, and the headline range `20–36x` is
   artifact-selection-dependent — an equally valid artifact taken at the same settings gives `20–32x`.
   See [4.1](#41-the-context-table-is-sourced-from-an-artifact-the-readme-never-cites).
5. **`bench/results/` is gitignored.** Both artifacts the README cites by filename are absent from
   the repository. Nobody who clones this can check a single number in it. See [2.15](#215-the-benchmark-artifacts-are-not-in-the-repository).

**Counts.** 38 documented claims examined — 16 README "Known limitations", 12 README prose claims,
10 spec claims:

| verdict | n | where |
|---|---|---|
| still true | 18 | README limitations 1, 2, 3, 6, 8, 10, 11, 12, 13, 14, 16; six prose claims; spec `:265` |
| imprecise | 9 | README limitations 4, 5, 7, 9; the `50 KB / 2000 lines`, `rg --column` and context-provenance prose; spec `:162`, `:721` |
| stale | 6 | spec `:196`, `:249`, `:521`, `:523`, `:636`, `:639` |
| **false** | **3** | README limitation 15; README "Nothing is destroyed"; spec `:238` |
| true but unsourced | 2 | fork-bomb branching factor; "a 40-file sweep can cost 300k tokens" |

**22 undocumented limitations found** (17 substantive in §2.1–2.17, 5 minor in §2.18). A further 13
things were checked and found sound — recorded in [§5](#5-things-this-audit-checked-and-found-fine) so
nobody re-investigates them.

---

## 1. Part 1 — verification of documented limitations

### README "Known limitations" 1–16

#### 1.1 Partition blindness

**Claim.** Four explorers missed `interactiveHandler.ts` in 4 of 5 runs on `bash-approval`; one
explorer never missed it.

**Verdict: still true. Measured.**

`bench/results/2026-09-11T05-44-05.json` — the `fanout` arm's records for `bash-approval` runs 2, 3, 4
and 5 each carry `missed: ["src/hooks/toolPermission/handlers/interactiveHandler.ts"]`. The `explorer`
arm missed a ground-truth file in exactly one run (run 3, `permissions.ts`) and never that file; the
`baseline` arm missed one in run 5 (`bashPermissions.ts`). The "4 of 5", the identity of the file, and
the "never missed that one" clause all reproduce.

#### 1.2 `concurrency` is an extension-wide ceiling

**Verdict: still true. Measured.**

Probe: 40 tasks submitted through `withExplorerSlot(4, …)` (`src/index.ts:198-205`), each sleeping
20 ms. Peak observed concurrency **4**, wall clock **220 ms** (11 waves), residual `running` **0**.
A task that throws still releases its slot. The queue is FIFO and unbounded, which is the documented
serialization behaviour and not a leak.

One unstated wrinkle, too small to promote: `releaseSlot` hands its slot to the next waiter without
re-checking the limit, so if a `session_start` reload *lowers* `concurrency` mid-flight the old ceiling
persists until the queue drains. Probe confirmed peak 4 after lowering to 1. Self-correcting; not worth
documenting.

#### 1.3 Signals reach only the direct child

**Verdict: still true — and upgraded from reasoned to measured.**

Probe: `sh -c "trap '' TERM; (sleep 20; touch marker) & wait"` run through `runExplorer` with
`timeoutMs: 500`, `sigkillGraceMs: 200`. Result: `Explorer timed out after 500ms`, and **2 `sleep 20`
grandchildren were still running** after the direct child was SIGKILLed.

Second-order effect the README does not mention: those grandchildren inherit the stdio pipes, so
`close` never fires and the promise settles on the `DRAIN_MS` backstop (`src/explorer.ts:172`) instead.
Measured settle time **1,710 ms** for a 500 ms timeout with a 200 ms grace — roughly one extra second
on every timeout that leaves a live grandchild.

#### 1.4 Quote verification is indentation-insensitive, looser on comments

**Verdict: mechanism still true; the mutation-testing figures are unsourced.**

Mechanism verified in code: `anchoredLines` and `normalizeQuote` (`src/citations.ts:304-318`) trim and
drop blanks on both sides; `locateReflow` (`:643-681`) is the only rule that leaves line-by-line
comparison, is gated to all-comment quotes, is bounded to one maximal run of consecutive comment lines,
and matches case-insensitively.

The figures — **49,985 mutations, 182 escaped (0.364%)**, and **43,777 code-quote mutations, none
escaped** — have **no artifact, no script and no test anywhere in the repo**. They appear only as prose
in `README.md:335`, `README.md:398`, `bench/run.ts:1852-1855` and the spec at `:746-749`. They are
internally consistent (182/49,985 = 0.3641%) and nothing more. A one-off script that was not kept.

#### 1.5 Spill files are never deleted

**Verdict: true; "per-user temp directory" is imprecise.**

No `unlink` or `rm` exists anywhere in `src/`. But `os.tmpdir()` is per-user only on some platforms:
on this machine it is `/var/folders/tz/…/T` (per-user), on Linux it is `/tmp` (world-traversable) —
which `src/index.ts:507-509` already says in a comment while the README says "per-user temp directory"
twice (`README.md:123`, `:400`). The `0600` mode is what carries the protection, not the directory.
Suggested wording: "the OS temp directory, mode `0600`".

#### 1.6 In headless mode, config warnings are invisible

**Verdict: true, and there is a documented way to avoid it.**

`noOpUIContext` defines `notify: () => {}` at pi `dist/core/extensions/runner.js:92`; print/json mode
binds extensions without a `uiContext` (`dist/modes/print-mode.js:53-54`), so the no-op applies.
pi documents `ctx.hasUI` as the guard for exactly this (`docs/extensions.md:974`); `src/index.ts:583`
calls `ctx.ui.notify` unguarded.

**Missing from the limitation:** headless mode also silently disables the *project* config layer. pi
`docs/security.md:29` — non-interactive modes show no trust prompt, and with the default
`defaultProjectTrust: "ask"` an untrusted project's resources are ignored. So in `-p`/`--mode json`,
`ctx.isProjectTrusted()` is false by default and `<project>/.pi/fast-explorer.json` is never read, with
no message. Correct behaviour; undocumented consequence.

#### 1.7 Per-category cost fields are zero

**Verdict: true — but "token counts are broken out correctly" is not.**

`aggregateUsage` (`src/index.ts:383-402`) does leave `cost.input/output/cacheRead/cacheWrite` at zero.
However the token counts **over-count on retry**: pi retries a failed turn up to 3× by default
(`dist/core/settings-manager.js:582,595`) and the failed assistant message has *already* been emitted
as a `message_end` with its own usage (`pi-agent-core/dist/agent-loop.js:238,251`) before
`_prepareRetry` strips it from agent state (`dist/core/agent-session.js:2306-2309`). `processLine`
(`src/explorer.ts:106-121`) sums both attempts and increments `usage.turns` twice. **Reasoned.**

#### 1.8 Auto-promotion has run end to end exactly once per path, and is not benchmarked

**Verdict: true, and entirely unsourced.**

No artifact, session log or spill file exists for the described run. The figures — 105 files, four
explorers, 311 raw match lines, $0.129, 13.3k output tokens, 29,626 bytes of reports against 26,401
bytes of raw match list — appear only at `README.md:406`. The same is true of the clang counter-example
at `README.md:152` (twenty C files, 80 KB, 2,710 bytes, `{attempted: 10, verified: 0}`):
`tests/bash-promote.test.ts` has analogous unit tests on synthetic fixtures with *different* numbers,
and nothing reproducing the session. The constants the paragraph rests on do check out
(`src/detect.ts:22,31,37`).

Related staleness: the spec still asserts the opposite at `:639-641` — "no real `grep` result has ever
tripped the `tool_result` hook".

#### 1.9 Brief file lists are capped at 40 paths per explorer

**Verdict: true, and understated.**

`MAX_FILES_PER_BRIEF = 40` (`src/index.ts:161`), `computeFanout` clamps to `maxFanout` (default 4).
Arithmetic, confirmed by probe: a 1000-path `find` yields at most **4 × 40 = 160 paths named to any
explorer — 16% of the result**. The explorer is told the count it was not shown, so it knows it is
sampling, but the README frames this as a per-explorer cap and never states the aggregate.

#### 1.10 Only true match lines count toward the density threshold

**Verdict: still true, and now verified on both sides.**

pi's grep emits context lines as `${relativePath}-${line}- ${text}` (`dist/core/tools/grep.js:147`) and
matches as `${relativePath}:${line}: ${text}` (`:206`). Probe: `parseGrepMatches` on
`"src/a.ts-10-  before\nsrc/a.ts:11:  const x = 1;\nsrc/a.ts-12-  after\n"` returns exactly one match.
Adding an `--` group separator changes nothing.

**Missing context that matters more than the limitation:** pi's grep tool caps at **100 matches by
default** (`grep.js:24`) and 50 KB. So `minMatches: 60` operates inside a 60–100 band unless the model
passes an explicit `limit`, and a grep result can never be the thousand-match sweep the threshold text
implies.

#### 1.11 Explorers do not know what they do not know

**Verdict: true by construction.** `buildBriefs` (`src/index.ts:125-129`) passes one brief; nothing
carries conversation history. Not independently falsifiable here.

#### 1.12 Non-determinism

**Verdict: true. Measured.** `bench/results/2026-09-11T04-37-10.json`, question `tracking`, arm
`explorer`: recall `[0.5, 1, 1, 1, 1]`, latency 16,040–17,678 ms across five runs.

#### 1.13 `explore` without `questions` is not parallel

**Verdict: true.** `buildBriefs` returns `[input.question]` when `questions` is absent or empty
(`src/index.ts:126-128`). No planner exists.

#### 1.14 The turn budget is advisory

**Verdict: true.** pi 0.85.1 has no turn-limit flag: zero hits for `maxTurns|max-turns|turnLimit|maxSteps`
in `dist/cli/args.js`, `dist/main.js`, `dist/core/agent-session.js` or any `docs/*.md`, and none in
`pi --help`. `retry.maxRetries` is a failure-retry budget, not a turn cap.

**Caveat to add:** because retries double-count turns ([1.7](#17-per-category-cost-fields-are-zero)),
the measured overrun counts are an upper bound on real model turns, not an exact count.

#### 1.15 "On Windows, shell searches are not promoted"

**Verdict: FALSE as stated.**

The README says "pi swaps `bash` for `powershell` there". It does not. pi `docs/windows.md:1-9`:

> Pi uses Git Bash by default on Windows. Checked locations (in order): 1. Custom path from
> `~/.pi/agent/settings.json` 2. Git Bash (`C:\Program Files\Git\bin\bash.exe`) 3. `bash.exe` on PATH

and `docs/windows.md:13-19`: the `powershell` tool is **optional**, and you enable it by putting it in
`defaultTools` — the doc's own example is a *replacement you choose to make*, not a platform default.

So on a default Windows install the tool is still named `bash`, `isBashToolResult` still fires, and
shell searches promote exactly as they do elsewhere. The real gap is much narrower: **a user who has
opted into the `powershell` tool loses promotion for it.** pi already exports `isPowerShellToolResult`
(`dist/index.d.ts`), so the "two-line change to `sweepKind`" framing is accurate — it is the scope of
the loss that is wrong.

*(The audit brief states the same thing — "`bash` is also absent on Windows (pi uses `powershell`)".
That premise is wrong too.)*

#### 1.16 It does not make the main agent faster

**Verdict: true. Measured, and every figure reproduces.** See [§4](#4-numbers-that-do-not-match-their-source)
for the one provenance problem, which does not touch these numbers.

### README prose claims

| Claim | Verdict | Evidence |
|---|---|---|
| `1.16x: 16,276 ms vs 13,983 ms median`, `$0.0176 vs $0.0122` | **true** | Pooled medians over 20 runs per arm in `2026-09-11T04-37-10.json`, using `run.ts:620 summarize()`'s convention (even-`n` averages the two middle values; baseline is 13,982.5 → `toFixed(0)` → 13,983). |
| `fanout 19,051 ms / 1.36x / $0.0629` | **true** | Same artifact. |
| `20–36x less context` | **numbers true, source misattributed and selection-dependent** | See [4.1](#41-the-context-table-is-sourced-from-an-artifact-the-readme-never-cites). |
| Citation-quality table (520 blocks, 386/119/15, median 1.00 min 0.67) | **true** | `quoteRates.quotes = 520`; verdicts 386 + 119 + 11 + 4 = 520; 11 `fabricated` + 4 `missing-file` = 15 (2.88%); `deliveredExactAnchors {median:1, min:0.6667, n:33}`. |
| Second sweep: 75 runs, 0 failures, $2.79, recall/precision/latency/cost tables, `4 of 5`, `3 of 5`/`2 of 5`/`0 of 5` turn overruns, `3.6x`, `2.3x`, `2.98–3.56x`, `62 of 1,275 (4.9%)`, `min 0.00 on two questions`, `1.08x` | **all true** | `2026-09-11T05-44-05.json`; `FABRICATION_CEILING = 0.06` and `FABRICATION_RATE_AT_LAST_RATCHET = 0.0486` in `bench/run.ts`. "34 minutes" is `wallClockMs = 2,011,253` = 33.5 min — rounds up, generous but not wrong. |
| `pi's per-call truncation (50 KB / 2000 lines)` | **imprecise for the tools that matter** | Constants are real (`dist/core/tools/truncate.js:10-11`), but grep and find both override the line cap: `truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER })` at `grep.js:215` and `find.js:97,213`. Effective caps: **50 KB + 100 matches** (grep), **50 KB + 1000 results** (find). |
| `rg --column` "parses, but the text no longer matches the file's line, so verification refuses it" | **right outcome, wrong mechanism** | Probe: `src/a.ts:11:5:  const x = 1;` parses to `{file: "src/a.ts:11", line: 5}`. That path does not exist, so the result is rejected at the **resolution** gate (0% resolve, `src/detect.ts:148`), before `verifyMatchedLines` is ever called. |
| `grep` without `-n` is not promoted | **true** | Probe: `parseGrepMatches("src/a.ts:const x = 1;")` → `[]`. |
| "Nothing is destroyed: the full match list is on disk and its path is in the result" | **conditionally false** | See [2.2](#22-auto-promotion-replaces-the-tool-result-even-when-every-explorer-failed). |
| Branching factor "measured at roughly 40 per level" | **unsourced** | The arithmetic (40², 40³) is right. "Measured" has no artifact. |
| "A 40-file sweep can cost 300k tokens" | **unsourced / illustrative** | No artifact. |
| "345 tests" | **true** | `npx vitest --run` → 19 files, 345 passed. |

### Spec claims

| Spec | Verdict | Evidence |
|---|---|---|
| `:636` "313 unit tests across 18 files" | **stale** | 345 tests, 19 files. |
| `:639-641` "no real `grep` result has ever tripped the `tool_result` hook" | **stale** | Contradicted by README limitation 8 and by commit `af1bb37`. |
| `:238-239` "child PIDs are tracked and killed when `ctx.signal` fires, so Ctrl+C does not leave orphaned subprocesses" | **false** | No PID tracking exists. Only the direct child is signalled, and orphaned grandchildren were measured ([1.3](#13-signals-reach-only-the-direct-child)). README limitation 3 is the accurate statement; the spec never received the amendment. |
| `:521-530` Architecture block lists `planner.ts` | **stale, but disclosed** | Never built; noted at `:842-847`. The block itself was never corrected. |
| `:523` "index.ts # registers explore tool, grep hook, **/explore command**" | **stale, undisclosed** | No slash command is registered anywhere in `src/`. Unlike the planner, this is not recorded as unbuilt. |
| `:196-203` explorer invocation block | **stale** | Omits `--no-extensions`, which `:828` calls load-bearing. |
| `:249-260` config default block | **stale** | Omits `autoPromote.bash`. |
| `:162` "Concurrency is capped at 4" | **imprecise** | 4 is the *default*. `resolveConfig` enforces only `1 <= maxFanout <= concurrency`; nothing caps `concurrency`. |
| `:265-267` "7 of 40 … every one of them by landing on exactly 6 turns" | **true** | See [4.2](#42-the-turn-overrun-figure-is-conflated-across-three-documents) — this is the *correct* version. |
| `:721` "Any non-zero hallucination rate is a release blocker" | **superseded, not amended** | The spec records the gate failing at `:738-744` but never records that `bench/run.ts` replaced it with a 6% ratchet plus a marking-completeness check. The README does record it. |

---

## 2. Part 2 — undocumented limitations

### 2.1 The headline: a `stopReason` change in pi turns every sweep into a paid no-op

**Measured behaviour, reasoned trigger. Severity: high. Likelihood: low per release, certain over time.**

`src/explorer.ts:322-331` treats any `stopReason` that is present and not the literal `"stop"` as a
failure. Probe, feeding a synthetic NDJSON line through `runExplorer`:

| `stopReason` | result |
|---|---|
| `"stop"` | `ok: true` |
| `"length"`, `"aborted"`, `"max_tokens"`, `"end_turn"`, `"toolUse"` | `ok: false`, `Explorer stopped with reason "…"` |
| *absent* | `ok: true` — a missing field is treated as success |

pi's actual vocabulary is seven values, in a *transitive* dependency:
`node_modules/@earendil-works/pi-ai/dist/types.d.ts:287` —
`"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`.

Three sources disagree today and none is right:
- the union above (7 values),
- pi's own `docs/session-format.md:88` (5 values, missing `pending` and `deferred`),
- our comment at `src/explorer.ts:322-325` (5 values, missing `toolUse` and `error`).

The extension hand-redeclares the message shape (`StreamMessage`, `src/explorer.ts:67-79`), so
TypeScript cannot catch a rename. If pi ever renames `"stop"` — to `"end_turn"`, the name the
underlying provider APIs use — **every explorer in every configuration is reported as failed**, with
the money already spent. It fails closed, which is right; what makes it the headline is what happens
next.

**Status: partly fixed.** The comment now states pi's real seven-value vocabulary and cites the
transitive source by file and line. The allow-list is unchanged — it is still one literal string, and
a rename would still report every explorer failed — but the *consequence* is contained by the fix to
[2.2](#22-auto-promotion-replaces-the-tool-result-even-when-every-explorer-failed):
`tests/autopromote.test.ts` now runs a sweep whose explorers succeed and report
`stopReason: "end_turn"`, and asserts the original search result survives it.

### 2.2 Auto-promotion replaces the tool result even when every explorer failed

**Measured. Severity: medium-high. Likelihood: whenever explorers fail — `pi` off PATH, a bad `model`
or `thinking` value, a provider outage, or [2.1](#21-the-headline-a-stopreason-change-in-pi-turns-every-sweep-into-a-paid-no-op).**

`createSweepHandler` (`src/index.ts:551-562`) returns the synthesized text unconditionally. There is no
branch that falls back to the original content. Probe on `synthesize` with two failed results:

```
Exploration produced no findings — every explorer failed.

---

## Not Covered

These areas were NOT examined. Treat them as unverified:

- a — Failed to spawn explorer: spawn pi ENOENT
- b — Failed to spawn explorer: spawn pi ENOENT
```

That, plus the spill note, is what replaces the model's grep output. The README says "Nothing is
destroyed: the full match list is on disk and its path is in the result." That holds *only if the spill
write succeeded* — and when it did not, `src/index.ts:549` emits "Raw output could not be saved to
disk" and the match list is genuinely gone. Even in the good case the model pays a turn to read a file
back that it already had.

Composed with [2.1](#21-the-headline-a-stopreason-change-in-pi-turns-every-sweep-into-a-paid-no-op):
a pi patch release that touches `stopReason` does not degrade this extension, it inverts it — every
promotable search returns nothing useful, at four model calls apiece.

Mitigating note: pi catches a throwing `tool_result` handler (`dist/core/extensions/runner.js:722-733`)
and passes the original result through, so *crashes* fail safe. It is the *successful-but-empty*
return that does not.

**Status: fixed.** `createSweepHandler` now returns `undefined` when no explorer produced findings
(`hasFindings`, shared with `synthesize` so the two cannot disagree), so pi leaves its own result in
place untouched — and the spill file is written only once promotion is going ahead, so a failed sweep
no longer leaves a `0600` file of repository text behind with nobody told its path. The cost of
returning `undefined` is that a failed sweep's token usage goes unreported; the alternative, rebuilding
the original result from a hand-copied field list, was rejected as re-introducing the version coupling
this branch exists to contain.

### 2.3 `grep` and `find` output formats are undocumented implementation details

**Reasoned, cited. Severity: high. Likelihood: medium.**

`src/parse.ts` parses pi's grep and find output as text. Those formats appear in **no** pi doc — only in
`dist/core/tools/grep.js` and `find.js`. Confirmed shapes at 0.85.1:

- grep match: `${relativePath}:${lineNumber}: ${text}` (`grep.js:206,145`) — colon-space.
- grep context: `${relativePath}-${line}- ${text}` (`grep.js:147`).
- grep empty: literal `"No matches found"` (`grep.js:192`).
- notices appended as `\n\n[...]` (`grep.js:221-233`) — caught by `isNotice`.
- find: bare relative paths, one per line, no header or footer; empty is
  `"No files found matching pattern"` (`find.js:199`), which `src/parse.ts:63` matches exactly.

A cosmetic change — a `Found N matches in M files` header, dropping the space after the line number,
rewording a notice, or making paths repo-root-relative — breaks parsing with **no type error and no
crash**. The symptom is that auto-promotion quietly stops firing, which is indistinguishable from the
feature being switched off. This is the single largest silent-breakage surface in the package.

Two sharper hazards inside the same surface:

- **Paths are relative to the `path` argument, not the repo root** (`grep.js:69-77`,
  `find.js:11-16,209`). `normalizeMatchPaths` handles the normal case, but grep falls back to
  `path.basename(filePath)` when the computed relative escapes the search root — a bare filename with
  no directory, which `normalizeMatchPaths` will then re-anchor to the wrong place.
- **`parseFindOutput` treats every non-`[...]` line as a path** (`src/parse.ts:65-73`). Probe:
  `parseFindOutput("Found 3 files:\nsrc/a.ts\n")` returns `["Found 3 files:", "src/a.ts"]`. Harmless
  today because find emits no header; one added header line and the byte total, the bucketing and the
  briefs all take a non-path along for the ride.

### 2.4 The "unmarked failure" guarantee is vacuous for three shapes the parser cannot see

**Measured. Severity: medium-high. Likelihood: model- and language-dependent.**

`findUnmarkedFailures` (`src/citations.ts:1238-1267`) is documented as the proof that no fabrication
reaches the caller unlabelled. It re-parses the delivered text with the *same* parser
`reanchorReport` used — which is the right design for catching marking bugs, and precisely why it
cannot catch parsing blind spots. Probe: `reanchorReport(…)` then `findUnmarkedFailures(…)` on the
output, with a quote of code that is not in the file:

| shape | quotes seen | `fabricated` | marker in delivered text |
|---|---|---|---|
| ` ```ts ` … ` ``` ` (control) | 1 | 1 | **yes** |
| ` ````ts ` … ` ```` ` | 1 | 1 | **yes** |
| ` ```ts ` … *fence never closed* | **0** | **0** | **no** |
| `~~~ts` … `~~~` (CommonMark tilde fence) | **0** | **0** | **no** |
| ` ```sql ` with `-- real.ts:1` header | **0** | **0** | **no** |

`FENCE` (`src/citations.ts:37`) requires a closing triple-backtick; `HEADER` (`:40`) admits only `//`
and `#` comment openers. So:

- A report whose last fence is never closed — a truncated response, a `length` stop, a model that
  forgot — ships its excerpts **unverified and unmarked**, and the checker reports a clean run.
- `~~~` is standard markdown and some models prefer it.
- Every language whose line comment is not `//` or `#` — SQL, Lua, Haskell (`--`), HTML/XML (`<!--`),
  CSS and C89 (`/* */`), Lisp and assembly (`;`), MATLAB and LaTeX (`%`), VB (`'`), Fortran (`!`) —
  produces headers the parser cannot read. On a non-TypeScript corpus, quote verification is
  substantially or entirely a no-op, and the fidelity number reads 100% because nothing was checked.

The benchmark cannot see this either: `bench/run.ts:1837`'s "153 of 1,376 blocks carry no header" finding is
real, but **all 153 headerless blocks are in the `baseline` arm**, which was never inside the
guarantee. Restricted to explorer-arm reports the count is 1,223 blocks and **0** headerless — one
model, on one TypeScript corpus, following the contract.

The honest statement of the property is: *every failure the parser can see is marked*. That is a
weaker claim than the one in `src/citations.ts:1199-1214`, and the gap is exactly the set of reports
that need it most.

**Status: fixed.** `~~~` fences are parsed, and the header comment set is now `//`, `#`, `--`, `;`,
`%`, `<!--` and `/*` (with `-->` and block-comment closers preserved on rewrite) — chosen against a
re-scan of 3.13M lines, 1.6M of them in the languages the widening admits, which found zero lines
matching the wide pattern that did not already match the narrow one. `'`, `!` and a bare `*` were
left out deliberately; see the `HEADER` comment. An unterminated fence is still NOT parsed — reading
to end-of-report would manufacture a fabrication verdict out of the report's own prose — but it is no
longer invisible: `reanchorReport` marks its header `UNCHECKED: unterminated code fence` and counts it
in `ReanchorResult.unparsed`, and `findUnmarkedFailures` reports it as an `"unparsed"` entry rather
than a clean run. The residual boundary is an unterminated fence with no `path:line` header at all,
which makes no claim to be a checked excerpt; that is stated in the function's doc comment.

### 2.5 A report that ignores the contract produces zero citations, zero quotes, and no warning

**Measured. Severity: medium.**

`CITATION` (`src/citations.ts:17`) requires a numbered entry: `1. path (lines 10-50)`. Probe:
`extractCitations("## Files Retrieved\n- `real.ts` (lines 1-3) - stuff\n")` → `[]`. Likewise a report
that is pure prose yields no fences, so `reanchorReport` returns it byte-for-byte unchanged with all
counters at zero.

There is no runtime signal anywhere that a report failed to conform. `ExplorerResult.ok` is true, the
report is concatenated into the answer, and the main agent reads uncited prose that looks exactly like
cited findings minus the citations. The prompt warns the model ("A malformed entry is silently
discarded", `prompts/explorer.md:49-50`); nothing warns the *caller*.

This is the load-bearing model-dependence in the package. What the citation contract assumes of a
model, in descending order of how likely a weaker one is to break it:

1. Numbered `N. path (lines A-B)` entries — not bullets, not bold paths, not `path:10-50`.
2. A fence whose **first** line is a `//` or `#` comment naming `path:line` (`splitExcerpts` bails if
   `heads[0].index !== 0`, `:108`).
3. Paths relative to the repository root — anything else verifies as `missing-file`.
4. Verbatim quoting — paraphrase verifies as `fabricated`.
5. Taking line anchors from grep output rather than counting — the cheapest to break and the cheapest
   to survive, since drift is corrected silently.
6. Closing its fences and finishing inside the turn budget.

Items 1–4 fail *silently or loudly at the block level*. Item 1 and the unclosed-fence case in
[2.4](#24-the-unmarked-failure-guarantee-is-vacuous-for-three-shapes-the-parser-cannot-see) fail
*invisibly*. Everything measured about contract compliance ("0 violations", 520 and 1,275 blocks) is a
property of `openai/gpt-5.6-luna` on TypeScript.

### 2.6 Explorers load your skills and the repository's `AGENTS.md`

**Reasoned, from pi's own docs. Severity: medium (cost) / medium (injection).**

`buildExplorerArgs` (`src/explorer.ts:38-54`) passes `--no-extensions` and nothing else. pi has three
further discovery switches that are not passed: `--no-skills`, `--no-prompt-templates`,
`--no-context-files`.

Consequences:

- **Cost and latency are user-environment-dependent.** Every explorer loads the user's global skills
  and prompt templates on top of the system prompt and tool definitions. The "fixed overhead per
  explorer" the spec blames for the 1.16x is not fixed across users; someone with a large skills
  directory pays more per explorer than the benchmark measured, and nothing here bounds it.
- **Repository context files reach explorers regardless of project trust.** pi `docs/security.md:29`:
  "Context files such as `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` are loaded regardless of
  project trust unless context loading is disabled." So in a freshly cloned, untrusted repository, the
  repository's own instructions are in every explorer's system prompt. The read-only guarantee holds —
  the explorer still cannot write or run anything — but the *report* is an uninspected channel into the
  main agent, and only quoted code is verified. `## Architecture` and every prose sentence is passed
  through unchecked.

The README's read-only section says an explorer is safe "regardless of ... how it is prompt-injected".
That is true of capability and not of output.

### 2.7 The host process retains every NDJSON message, including tool results

**Measured. Severity: low-medium.**

`processLine` pushes every `message_end` message into `acc.messages` *before* the `role !== "assistant"`
filter (`src/explorer.ts:107-110`). pi emits `message_end` for the user prompt and for every tool-result
message (`pi-agent-core/dist/agent-loop.js:53,115,558`), so the array accumulates the full text of
everything the explorer read.

Probe: 40 user messages of 50,000 characters plus one assistant message retained **41 messages ≈ 2.0 MB**
in the host, to produce a final report of five characters. `extractFinalText` only ever needs the last
assistant message.

This does not put file contents in the main agent's *context* — the design claim holds — but it does
put them in the host agent's *heap*, at roughly (bytes the explorer read) × (explorers in flight),
freed when the promise settles.

### 2.8 Quote verification reads whole files with no size cap, and is not confined to the repository

**Measured. Severity: low-medium.**

`readLines` (`src/citations.ts:251-257`) does `readFileSync(resolve(cwd, file), "utf8").split("\n")`
with no size guard. Compare `src/detect.ts:44`, which caps the analogous read at `MAX_VERIFY_FILE_BYTES
= 4 MB` for exactly this reason. The asymmetry is undocumented.

Measured cost of `reanchorReport`, run synchronously inside `synthesize` on the host agent's event loop:

| report | ms | heap retained |
|---|---|---|
| 20 files × 20 KB, all quotes real | 4 | 0.8 MB |
| 20 files × 20 KB, all quotes fabricated | 5 | 0.7 MB |
| 40 files × 200 KB, all real | 15 | 11 MB |
| 40 files × 200 KB, all fabricated | 117 | 21 MB |
| 10 minified files × 2 MB, all fabricated | 131 | 43 MB |
| 40 files × 1 MB, all fabricated | **742** | **127 MB** |

Negligible on ordinary source. The tail is the misattribution search (`src/citations.ts:831-845`),
which is O(failing quotes × cited files) and only runs once every cheaper rule has failed — so the
cost is paid precisely when the report is worst.

Separately: a cited path is resolved against `cwd` with no containment check. Probe — a quote headed
`// ../<other-tmpdir>/secret.txt:1` verified as real and shipped **unmarked**. The explorer already has
read access, so this is not a new capability; it does mean "verified against disk" is not the same
claim as "verified against this repository".

**Status: size cap fixed; containment not.** Reads are now capped at `MAX_VERIFY_BYTES` (4 MB, the
same number `src/detect.ts:44` uses), and a quote citing an over-cap file gets the new `unread`
verdict — not `missing-file`, which would accuse the model of citing a file that is sitting there, and
not a pass either. It is marked `UNCHECKED: cited file is too large to verify` and sits outside both
sides of the fidelity ratio, like `trivial`.

Note that the cap alone does **not** explain the 742 ms row: every file in that fixture was 1 MB,
under the cap. The cost was the misattribution search re-deriving `anchoredLines` for every candidate
file for every failing quote — quotes × files, 1,600 derivations for 40 × 40. Anchoring is now cached
with the read, which is what moves the number: re-measured on the same shape (40 files of ~1.6 MB, all
quotes fabricated), **1,142 ms / 417 MB before, 257 ms / 173 MB after**. The pass remains bounded by
(cited files) × 4 MB; no aggregate budget was added.

The containment gap is untouched.

### 2.9 Verification outcomes depend on filesystem case sensitivity

**Measured. Severity: low, but it biases a published number.**

Probe on this machine (APFS, case-insensitive): a file written as `Case.ts` and cited as `case.ts`
verified clean, with no marker. On a case-sensitive filesystem the same report verifies as
`missing-file` → `UNVERIFIED`.

Every benchmark run was on darwin (`node v22.22.2`, darwin, recorded in the artifacts). So the
published citation-fidelity figures are a mild **upper** bound relative to Linux and CI.

### 2.10 A single `message_end` line larger than 1 MiB is silently dropped

**Measured. Severity: low.**

`STDOUT_BUFFER_CHARS = 1_048_576` (`src/explorer.ts:182`); over-long partial lines are truncated from
the *head* (`:272`), which destroys the JSON. Probe, feeding a single NDJSON line through `runExplorer`:

- 900,000-character report → `ok: true`, report length 900,000.
- 1,200,111-character line → `ok: false`, `Explorer produced no report`.

No realistic report is that large, so this is a boundary rather than a live risk — but the failure is
total and silent, and the whole bucket lands in `## Not Covered`.

### 2.11 `runExplorer` can reject instead of resolving, and no caller catches it

**Measured. Severity: low-medium.**

`spawn` is called inside the Promise executor (`src/explorer.ts:217`) and can throw synchronously —
demonstrated with `E2BIG` by passing a 3 MB argv. The promise rejects; `withExplorerSlot`,
`runWithConcurrency` and both entry points have no `catch`. The result is a rejected tool call rather
than an `ok: false` entry under `## Not Covered`, breaking the "an explorer that fails is never
silently dropped" contract in exactly the case it exists for.

`E2BIG` is reachable because the brief is passed as a command-line argument: `input.question`,
`input.scope` and each `questions` entry are inlined with no length cap (`src/index.ts:630`,
`src/explorer.ts:50-54`). Realistically this needs a model to emit hundreds of kilobytes of question
text. `EACCES` and the Windows `.cmd` case ([2.16](#216-windows-spawnpi-shellfalse-and-npms-picmd-shim))
are the same shape.

On the auto-promotion path pi catches the rejection and passes the original result through; on the
`explore` tool path it surfaces as a tool error.

### 2.12 Config validation is shallow in three ways, one of which disables the feature

**Measured. Severity: low. Likelihood: low but silent.**

`validatePartialConfig` (`src/config.ts:127-152`) checks types, not domains. Probes:

- `{"thinking": "banana"}` — accepted. Passed straight to `--thinking banana`; every explorer fails.
  The README documents the seven valid levels; nothing enforces them.
- `{"timeoutMs": -1}` — accepted. `setTimeout(fn, -1)` fires immediately, so every explorer is killed
  the instant it spawns.
- `{"maxTurnsPerExplorer": -5}` — accepted; writes "Turn budget: about -5 turns" into the prompt.
- **`{"maxFanout": 1.5, "concurrency": 2}` — accepted by both `validatePartialConfig` and
  `resolveConfig`, then throws inside the hook.** `computeFanout` returns `1.5`;
  `Array.from({length: 1.5})` has length 1; the balance loop at `src/partition.ts:38-42` indexes
  `buckets[1]` and dereferences `undefined`. Probe: `TypeError: Cannot read properties of undefined
  (reading 'length')`.

The last one fails safe by accident: pi catches the throw (`runner.js:722-733`) and the original grep
result passes through, so the symptom is "auto-promotion never fires", plus an extension error that is
invisible in headless mode ([1.6](#16-in-headless-mode-config-warnings-are-invisible)).
`maxFanout`/`concurrency` are the only keys with any range check at all
(`src/config.ts:69-78`), and it does not include integrality.

### 2.13 Auto-promoting a `grep` result can save at most ~50 KB of context directly

**Reasoned. Severity: low — it is a framing correction, not a defect.**

pi's grep tool truncates at 50 KB and 100 matches (`grep.js:24`, `truncate.js:11`). So the text
auto-promotion *removes* from the main agent's context is bounded by ~50 KB, while what it *adds* is
however long the explorer reports are. README limitation 8 already records one run where the reports
were larger than the match list (29,626 vs 26,401 bytes); the mechanism generalises that observation:
**on the `grep` path the direct context effect can never be large and may be negative.** The real win
is counterfactual — the main agent does not then read the 105 matched files — and that counterfactual
has never been measured.

`find` (1000 results, 50 KB) and `bash` (50 KB) are bounded the same way.

### 2.14 `--tools` typos degrade explorers silently

**Reasoned, cited. Severity: low.**

pi does no validation of `--tools` names: parsing is a split/trim/filter (`dist/cli/args.js:100-105`)
and enforcement is a set membership test (`dist/core/agent-session.js:2110`), with the source stating
outright that "Unknown tool names are ignored" (`:655`). A typo in `EXPLORER_TOOLS`
(`src/explorer.ts:9`) would produce explorers missing a tool, with no error, no warning and no
non-zero exit. `tests/explorer-args.test.ts` pins the string, which is the right mitigation; worth
knowing it is the *only* one.

(The exact string `--tools read,grep,find,ls` ships as an official example in `pi --help`, which is
the strongest contract signal available for it.)

### 2.15 The benchmark artifacts are not in the repository

**Measured. Severity: medium for a published package.**

`git check-ignore -v bench/results/2026-09-11T05-44-05.json` → `.gitignore:3:bench/results/`.

Both artifacts the README cites by filename are gitignored, as is `dist/`. Every sourced number in the
README and the spec is therefore uncheckable from a clone — including the numbers that argue *against*
the extension, which is the part a reader most needs to be able to verify. Compounding it: the
README's headline latency/cost table is a **pooled median across all runs of an arm**, a statistic
`bench/run.ts` never computes or prints — it emits per-question stats only. The table is a README-side
derivation, reproducible only by someone holding artifacts they cannot obtain.

### 2.16 Windows: `spawn("pi", …, {shell: false})` and npm's `pi.cmd` shim

**Suspected. Not verified — no Windows host was available.**

pi's `package.json` declares `"bin": { "pi": "dist/bundle/cli.js" }`. On Windows, npm materialises that
as `pi.cmd` / `pi.ps1` shims in the global bin directory; there is no `pi.exe`. `src/explorer.ts:217`
spawns `"pi"` with `shell: false`. A `.cmd` file is not a PE executable and cannot be started by
`CreateProcess` directly — it requires `cmd.exe /c` — and Node has been progressively hardening against
implicit `.cmd` execution since the 2024 `child_process` advisory.

If this is right, the extension does not function at all on a Windows npm install, and README
limitation 15 is describing a paper cut on a platform where the whole feature is down. If it is wrong
(libuv's PATHEXT search resolving and launching the shim), there is no issue. **This needs one run on
a real Windows box and nothing else.** It is the highest-value unverified item in this audit.

Two smaller Windows notes, both **Reasoned**:

- `proc.kill("SIGTERM")` is emulated on Windows as unconditional termination, so the SIGTERM→grace→
  SIGKILL ladder in `src/explorer.ts:228-239` collapses into a single immediate kill, and the
  `exitCode === null && signalCode === null` liveness test at `:234` is testing a distinction that does
  not exist there. Behaviourally harmless; the comment describing it is POSIX-only.
- `writeFileSync(spillPath, text, { mode: 0o600 })` — the mode argument is ignored on Windows. The
  per-user `%TEMP%` carries the protection instead.

### 2.17 Version coupling is unbounded in two independent directions

**Measured. Severity: medium.**

1. `peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.85.0" }` accepts `0.99`, `1.0`, `2.0`.
   pi is on `0.x`, where minor bumps are the breaking-change vehicle. `devDependencies` pins `^0.85.1`,
   so CI only ever type-checks against `0.85.x` — the declared compatibility range is far wider than
   anything tested.
2. The explorer subprocess is `"pi"` resolved from `PATH` (`src/index.ts:530,636`). That binary's
   version is unrelated to both the compiled-against package *and* the host pi that loaded the
   extension. A user on pi 0.92 with a 0.85-era `node_modules` gets a silent version split across the
   whole CLI half of the contract — flags, NDJSON shape, grep/find output, tool names. Nothing checks
   or reports it.

### 2.18 Smaller findings

| # | Finding | Kind | Note |
|---|---|---|---|
| a | `describeScope` + `normalizeMatchPaths` with an absolute `path` outside cwd | Measured | Probe: `normalizeMatchPaths(["a.ts"], "/repo", "/etc")` → `["../etc/a.ts"]`. Explorers are spawned with `cwd = session cwd` and may not be able to open `../` paths. |
| b | `claimOutput` state is process-global and never reset | Measured | `promotedOutputs` (`src/index.ts:226`) survives `session_start`. Two sessions in one process share a 32-entry history. Only relevant to embedders. |
| c | Symlink loops are handled | Measured (negative) | Probe: `resolvedFraction` through a 40-deep self-symlink returns 0 (ELOOP caught, no hang). Not a limitation — recorded so nobody re-investigates. |
| d | Binary files are handled | Measured (negative) | Probe: `verifyMatchedLines` on a PNG returns `{attempted: 1, verified: 0}` — no crash, correctly refuses. |
| e | `parseGrepMatches` handles Windows drive letters | Measured (negative) | `C:\src\a.ts:11: const x = 1;` → `{file: "C:\\src\\a.ts", line: 11}`. Correct. |
| f | Stat costs at scale are negligible | Measured (negative) | 1000-path `find`: `measureBytes` 2 ms (early exit), `resolvedFraction` 3 ms (no early exit, no cap). Not a problem on local disk; unmeasured on a network filesystem. |
| g | `runExplorer`'s `onProgress` is dead from the caller's side | Measured | Declared at `src/explorer.ts:158`, exercised only by `tests/explorer-run.test.ts`. Neither entry path passes it, so partial explorer output never streams to the user. |
| h | `synthesize` emits `## Not Covered`, and so does every explorer report | Measured | A synthesized answer can contain several `## Not Covered` headings meaning different things. Cosmetic. |
| i | A fence containing inner backticks truncates the quote | Measured | `FENCE` is non-greedy; the excerpt ends at the inner ` ``` `. Verification then sees a shorter quote, which is the safe direction. |

---

## 3. Part 3 — consolidated limitations section, for the README

> Proposed replacement for "Known limitations", ordered by **how likely you are to hit it**, not by
> severity. Every item is tagged **Measured** (we have data), **Reasoned** (mechanism understood,
> not executed) or **Suspected** (plausible, unverified).
>
> **Three items below are obsolete as written**, because the defects they describe were fixed after
> this audit: **4** (auto-promotion replacing your result when exploration failed — it now returns the
> original untouched), **6** (the verifier's parsing blind spots — `~~~` fences and six comment
> markers are now read, and an unparseable block is reported rather than passed over), and the first
> sentence of **18** (reads are now capped at 4 MB, and the adversarial case measures 257 ms rather
> than 742 ms). Do not copy those three into the README as they stand.

### Known limitations

These are trades and boundaries, not bugs to be surprised by later. Each is tagged with how well we
know it.

**1. It is slower and costlier per sweep than not using it. — Measured**
1.16x and 1.36x in the first sweep, 1.08x for both configurations in the second, with the unaided
baseline ahead on every question of four and on four of five. The win is context, recall on focused
questions, and verified citations; it is bought with latency and money. *(`bench/results/2026-09-11T04-37-10.json`, `2026-09-11T05-44-05.json`.)*

**2. "Recall 1.00" is a median, never a guarantee. — Measured**
At the current defaults the single-explorer arm scored recall 0.00 on at least one run of two of the
five questions. Five runs per question per arm; treat every number here as a median with spread.
*(`bench/results/2026-09-11T05-44-05.json`.)*

**3. Partition blindness — `questions` has no measured case in its favour. — Measured**
On the one question whose answer spans four subsystems, four explorers missed the file holding the
interactive approval prompt in 4 of 5 runs, with a sub-question aimed straight at it; one explorer
never missed it. On the four questions one explorer saturates, four cost 3.6x for identical recall.
Directory bucketing reduces this; no partition scheme removes it.

**4. If exploration fails, auto-promotion still replaces your search result. — Measured**
There is no fallback to the original text. When every explorer fails — `pi` not on `PATH`, a bad
`model` or `thinking` setting, a provider outage — the model gets "Exploration produced no findings"
plus the path to a spill file it must spend a turn reading. If the spill write also failed, the match
list is gone. Set `autoPromote.enabled: false` if that trade is wrong for you.

**5. The turn budget is advisory; per-explorer cost and latency are bounded only by `timeoutMs`. — Measured**
pi exposes no turn-limit flag, so `maxTurnsPerExplorer` is a sentence in the task text. 3 of 5
explorer runs and 2 of 5 fan-out runs exceeded the advisory 8 turns on the broadest benchmark
question. Related: pi retries a failed turn up to 3 times by default and the failed turn has already
been reported, so the turn and token counts this extension reports **over-count** retried turns. *(Overrun counts: Measured. Retry over-counting: Reasoned, from pi `dist/core/agent-session.js:2286-2330`.)*

**6. Quote verification only sees blocks it can parse, and reports nothing about the rest. — Measured**
Verification requires a closed triple-backtick fence whose first line is a `//` or `#` comment naming
`path:line`. An unterminated fence, a `~~~` fence, or a language whose line comment is `--`, `<!--`,
`/*`, `;`, `%` or `'` is invisible to the verifier — and equally invisible to the checker that proves
no failure ships unmarked. Such a block reaches you looking exactly like a verified one. The
"0 contract violations" result is one model on a TypeScript corpus; on other languages, expect quote
verification to be partly or wholly a no-op. Trust a `//`-headed excerpt's verification; treat any
other as unchecked.

**7. A report that ignores the output contract produces no citations and no warning. — Measured**
Citations must be numbered entries (`1. path (lines 10-50)`). Bullets, bold paths or `path:10-50`
parse to nothing, and there is no runtime signal that a report failed to conform — it arrives as
uncited prose that reads like findings. Everything measured about contract compliance is a property of
`openai/gpt-5.6-luna`; a weaker model is likeliest to fail the numbered-entry and fence-header rules
first.

**8. Only a sample of a wide `find` is ever named to an explorer. — Measured**
Briefs are capped at 40 paths, and fan-out at `maxFanout` (default 4), so at most **160 of a
1000-path `find` — 16%** — is listed to any explorer. Each explorer is told how many paths it was not
shown, so it reports on a sample knowingly; it is still a sample.

**9. `concurrency` is an extension-wide ceiling, not a per-call one. — Measured**
Both entry paths draw on one budget, deliberately: a model can issue ten greps in one message. The
consequence is that a batch of promotable searches serializes four explorers at a time.

**10. Explorers inherit your skills and the repository's `AGENTS.md`/`CLAUDE.md`. — Reasoned**
Only `--no-extensions` is passed; `--no-skills`, `--no-prompt-templates` and `--no-context-files` are
not. Two consequences. The per-explorer fixed overhead is not fixed across users — a large skills
directory makes every explorer more expensive than the benchmark measured. And pi loads context files
*regardless of project trust* (`docs/security.md`), so in an untrusted clone the repository's own
instructions are in every explorer's system prompt. The read-only guarantee still holds — an explorer
cannot write or run anything — but the report is an unverified channel: only quoted code is checked
against disk, and `## Architecture` and all other prose are passed through as written.

**11. Spill files are never deleted. — Measured**
Auto-promotion writes the raw search text to the OS temp directory with mode `0600` and leaves it
there, because the model may want it later. A long session leaves a trail of `fx-matches-*.txt`.
(Note that `os.tmpdir()` is per-user on macOS and Windows but is `/tmp` on Linux; the `0600` mode is
what protects it, not the directory.)

**12. In headless mode, config problems are invisible and the project config layer never loads. — Measured**
`ctx.ui.notify` is a no-op with no UI (`--mode json`, `-p`), so an invalid `fast-explorer.json` is
ignored silently. Separately, non-interactive pi never prompts for project trust, so with the default
`defaultProjectTrust: "ask"` the project config file is skipped entirely. Both fail safe; neither
tells you.

**13. Timeout and abort reach only the direct child. — Measured**
`SIGTERM`/`SIGKILL` go to the spawned `pi` process. Grandchildren it started are not signalled —
verified: two grandchildren survived a SIGKILL of their parent in a probe. Because those grandchildren
hold the stdio pipes, the promise settles on a 1-second drain backstop instead of on `close`, so a
timeout with live grandchildren costs about a second more than `timeoutMs` says.

**14. Per-category cost fields are zero. — Measured**
Only `cost.total` is available per explorer, so the aggregated usage reports a total and leaves the
input/output/cache cost split at zero.

**15. We depend on several pi behaviours that are implementation details, not documented contracts. — Reasoned**
Ranked by what would break silently:
 - **`grep`/`find` output text.** Parsed as `path:line: text` and bare paths. These formats appear in
   no pi doc. A cosmetic change — an added header, a dropped space, repo-root-relative paths — stops
   auto-promotion with no error, which is indistinguishable from the feature being switched off.
 - **`stopReason`.** Anything other than the literal `"stop"` is treated as an explorer failure. pi's
   actual vocabulary has seven values and three sources in pi and here disagree about which. A rename
   would report every explorer as failed — and, with limitation 4, replace every promotable search
   result with a failure notice.
 - **The `message_end` payload** (`usage.cacheRead`, `cost.total`, `errorMessage`) is defined in a
   *transitive* dependency we do not declare, so a rename degrades silently to zero-cost accounting.
 - **Unknown `--tools` names are silently ignored by pi**, so a typo in the explorer tool list would
   quietly remove a capability.
 - **Version range.** The peer dependency is `>=0.85.0`, unbounded, while CI only type-checks against
   `0.85.x`; and the explorer subprocess is whichever `pi` is on `PATH`, which may be a different
   version from both. Nothing detects the split.
 Documented and low-risk by comparison: `--no-extensions`, `getAgentDir()`, `CONFIG_DIR_NAME`, the
 `tool_result` hook and its replace-not-add `usage` semantics, `isProjectTrusted()`, and the absence of
 a turn-limit flag.

**16. Windows. — Reasoned, with one Suspected item that needs a real Windows box**
 - *Correction to a previous version of this list:* pi does **not** swap `bash` for `powershell` on
   Windows. It uses Git Bash by default, so shell searches promote normally. The gap is narrower than
   previously stated: only users who opt into pi's `powershell` tool via `defaultTools` lose promotion
   for it. pi already exports `isPowerShellToolResult`, so closing it is a small change — it is
   untested against real `Select-String` output, which is why it is not done.
 - **Suspected, unverified:** explorers are spawned as `spawn("pi", …, { shell: false })`, and npm
   installs pi on Windows as a `pi.cmd` shim rather than an executable. If Node cannot launch that
   shim without a shell, the extension does not work on Windows at all. Nobody has run it there.
 - `SIGTERM`/`SIGKILL` are emulated on Windows as immediate termination, so the grace-period ladder
   collapses to a single kill, and the `0600` spill-file mode is ignored.

**17. Config validation checks types, not values. — Measured**
`thinking` accepts any string (an invalid level fails every explorer at spawn time), `timeoutMs`
accepts a negative (which kills every explorer immediately), and a non-integer `maxFanout` is accepted
and then throws inside the auto-promotion hook — pi catches the throw, so the visible symptom is that
auto-promotion silently never fires. Only `maxFanout` and `concurrency` are range-checked, and not for
integrality.

**18. Verification cost grows with the size of the files a report cites. — Measured**
`reanchorReport` runs synchronously on the host agent's event loop and reads every cited file whole,
with no size cap (unlike the 4 MB cap used on the auto-promotion path). On ordinary source this is
~5 ms and under a megabyte. A report citing 40 megabyte-scale files whose quotes do **not** verify
measured 742 ms of blocking work and 127 MB of retained heap — the cost is highest exactly when the
report is worst.

**19. "Verified against disk" does not mean "verified against this repository". — Measured**
Cited paths are resolved against the session cwd with no containment check, so a quote headed
`// ../elsewhere/file:1` verifies against that file and ships unmarked. The explorer already had read
access, so this grants nothing new; it is a limit on what the word "verified" claims.

**20. Verification outcomes depend on the filesystem. — Measured**
On a case-insensitive filesystem (macOS by default) a citation with the wrong case verifies clean; on
a case-sensitive one it is marked `UNVERIFIED`. All benchmark runs were on macOS, so the published
citation-fidelity figures are a slight upper bound relative to Linux and CI.

**21. Explorers do not know what they do not know. — Structural**
The main agent holds the whole conversation; an explorer gets one brief, so it will miss
adjacent-but-relevant code. Related: every explorer re-reads the shared `types.ts`, which wastes
tokens and can produce inconsistent descriptions of the same entity across reports.

**22. Auto-promoting a `grep` result cannot save much context directly. — Reasoned**
pi truncates a grep result at 50 KB and 100 matches, so the text removed from your context is bounded
by ~50 KB while the explorer reports added are not. One recorded end-to-end run produced 29,626 bytes
of reports against 26,401 bytes of match list. The real saving is counterfactual — the main agent does
not then read the matched files — and that counterfactual has never been measured.

**23. Everything above was measured on one model and one corpus. — Measured**
`openai/gpt-5.6-luna` on `~/claude-plus-plus`, macOS, pi 0.85.1. The citation contract is a prompt; the
latency ratio is a property of that model. Run `BENCH_MODEL=… BENCH_REPO=… npm run bench` before
assuming any of it transfers. Note also that `bench/results/` is gitignored, so the artifacts these
numbers come from are not in this repository.

---

## 4. Numbers that do not match their source

### 4.1 The context table is sourced from an artifact the README never cites

**README:** "The first sweep, below, is where the latency, context and citation-quality numbers come
from — `bench/results/2026-09-11T04-37-10.json`."

Every cell of the context table reproduces exactly — 23,896 / 1,100 / 21.7x, 39,688 / 1,382 / 28.7x,
27,241 / 1,344 / 20.3x, 48,956 / 1,371 / 35.7x, and the fan-out column 3,858 / 3,400 / 3,874 / 4,351.
But **the baseline column is not in `2026-09-11T04-37-10.json` at all.** It comes from
`bench/results/2026-09-11T05-06-53-context.json`, a later, separate set of 20 baseline runs that the
README never mentions. The baseline runs behind the latency table and the baseline runs behind the
context table are different runs.

Worse, three context artifacts measured the same thing at the same settings and **disagree materially**:

| question | `…T04-45-13` | `…T04-57-07` | `…T05-06-53` (used) |
|---|---|---|---|
| microcompact baseline | 14,856 | 22,272 | **23,896** |
| cache-safety baseline | 42,558 | 31,777 | **27,241** |
| tracking baseline | 69,716 | 43,656 | **48,956** |

The README uses the last, which is the higher of the two 5-run measurements on 3 of 4 rows. Had
`…T04-57-07-context.json` been used, the reductions would read 20.2 / 25.6 / 23.6 / 31.8x — i.e.
**"20–32x", not "20–36x"**. The headline is reproducible from one of two equally valid artifacts.

**Recommendation:** cite `2026-09-11T05-06-53-context.json` explicitly, state that the baseline context
runs are separate from the baseline latency runs, and either report the range across the two 5-run
artifacts (~20–36x with a floor near 20x either way) or say which one was chosen and why.

### 4.2 The turn-overrun figure is conflated across three documents

| Source | Claim |
|---|---|
| `docs/.../2026-09-10-fast-explorer-design.md:265-267` | "7 of 40 benchmark explorer runs exceeded it, **every one of them** by landing on exactly 6 turns" |
| `README.md` (`maxTurnsPerExplorer` table row) | "**7 of 60** runs over budget, **5 of them** at exactly 6 turns with full recall" |
| `src/config.ts:46-48` | "across **60** benchmark runs, 7 exceeded the 5-turn budget, **5 of those** landing on exactly 6 turns" |

**The spec is right.** In `2026-09-11T04-37-10.json` the 7 over-budget runs are `persistence`/explorer
run 4, `persistence`/fanout runs 1–5, and `cache-safety`/fanout run 1 — **all 7 at exactly 6 turns**.

Both denominators are defensible (40 explorer-arm runs, 60 runs total), but only explorer-arm runs can
exceed a turn budget, so **40 is the meaningful one** and "7 of 60" invites the reader to compute a
rate against a population that includes the control.

"With full recall" is also not readable from the artifact: that build folded `turnCapExceeded` into
`ok`, so `coverage` is `null` for all 7. Re-scoring the 7 stored reports with a faithful
reimplementation of `scoreCoverage` (sanity-checked against a stored run — identical recall, precision
and file count) gives **recall 1.00 for all 7**. So the claim understates its own evidence.

**Recommendation:** "7 of the 40 explorer-arm runs exceeded the 5-turn budget, all 7 at exactly 6
turns, all 7 with recall 1.00 on re-scoring."

### 4.3 Numbers with no artifact behind them

None of these is wrong; none can be checked.

| Figure | Where | Status |
|---|---|---|
| 49,985 mutations / 182 escapes / 0.364%; 43,777 code mutations / 0 escapes | `README.md:335,398`, spec `:746-749`, `bench/run.ts:1852-1855` | No script, test or data file. One-off, not kept. |
| Auto-promotion end-to-end run: 105 files, 311 match lines, $0.129, 13.3k output tokens, 29,626 vs 26,401 bytes | `README.md:406` | No session log, no artifact, no spill file. |
| clang counter-example: 20 files, 80 KB, 2,710 bytes, `{attempted: 10, verified: 0}` | `README.md:152` | No artifact. `tests/bash-promote.test.ts` has analogous synthetic tests with different numbers. |
| Fork-bomb branching factor "measured at roughly 40 per level" | `README.md:234`, spec `:833` | Arithmetic is right (40², 40³); the measurement has no artifact. |
| "A 40-file sweep can cost 300k tokens" | `README.md:7`, spec `:19` | Illustrative. |

### 4.4 Stale corpus constants inside `src/citations.ts`

These are comments, not shipped claims, but they are cited as evidence for thresholds.

| Figure | Where | Status |
|---|---|---|
| "1,265 quotes in the stored reports" | `src/citations.ts:446,483` | **Was exactly right** against the pre-second-sweep `bench/results/` (202+45+202+145+671). Today the same computation gives **2,541**. Stale. |
| "140 stored reports" | `src/citations.ts:488` | **Was exactly right** as *all* records with a non-empty report across the same five files (20+8+40+12+60) — note this includes the baseline arm, a different denominator from the 1,265, which covers only the 92 explorer-arm reports. Today: 215 / 142. Stale. |
| "2,096 reference files", "3.4M lines", "2,167-file repo", "44,543 `}` lines in 1,764 files, 135 (7.7%) with exactly one" | `src/citations.ts:91, 408, 418-420, 692` | **Not reproducible.** Live corpus: 2,190 git-tracked non-`node_modules` files; 2,047 tracked `.ts`/`.tsx`; 535,727 lines in those; 2,490,060 lines across all non-`.git`/non-`node_modules` files. 2,167 is within 1% of 2,190 and plausible; 2,096 and 3.4M match nothing constructible. |

### 4.5 Artifact schema drift

Both cited artifacts were written by an **older `bench/run.ts`** than the file on disk. Their `gates`
are `["scoreable runs", "contract compliance", "quote fabrication"]`; the current `bench/run.ts` emits
four, including `"no unmarked failures"` and `"fabrication ratchet (<= 0.06)"` (`bench/run.ts:1033`,
with `FABRICATION_CEILING = 0.06` at `:121` and `FABRICATION_RATE_AT_LAST_RATCHET = 0.0486` at `:129`). The first sweep's `score`
objects have no `checkableQuotes`/`failedQuotes`/`unverifiableQuotes`, and neither artifact carries
`fabricationCeiling`, `fabricationRateAtLastRatchet` or `verdictCoverage`. Re-running today would not
reproduce these files' shape. No number changes, but the README's "the artifact records that failure"
refers to a gate that no longer exists under that name.

### 4.6 The `bench/run.ts` "153 headerless blocks" finding is scoped to the control arm

`FINDINGS` (`bench/run.ts:1837`) reports "153 of 1,376 blocks carry no header … outside the guarantee
entirely". Both counts
reproduce over the pre-second-sweep reports — but **all 153 are in `baseline` reports**, which were
never shown the output contract and are explicitly excluded from citation scoring. Restricted to
explorer-arm reports: 1,223 blocks, **0** headerless. The finding overstates the residual hole in the
`explorer` path — while [2.4](#24-the-unmarked-failure-guarantee-is-vacuous-for-three-shapes-the-parser-cannot-see)
shows there is a real hole it cannot see.

---

## 5. Things this audit checked and found fine

Recorded so they are not re-investigated.

- The concurrency semaphore: no over-subscription, no leak, throw-safe (`src/index.ts:172-210`).
- Symlink loops: `resolvedFraction` returns 0 on ELOOP; no hang.
- Binary files: `verifyMatchedLines` refuses them cleanly.
- Windows drive-letter paths parse correctly in `parseGrepMatches`.
- `grep` context mode does **not** break parsing, in either direction (confirmed against pi's real
  emitter format).
- `grep` without `-n` and `rg --column` are both correctly refused.
- Stat costs at 1000 paths are 2–3 ms on local disk.
- `--append-system-prompt` with a missing path is appended as literal text with no warning
  (pi `dist/core/resource-loader.js:17-31`) — the README's symlink warning is exactly right, and a path
  that exists but is unreadable behaves the same way plus a stderr warning.
- `--no-extensions` does stop discovery while leaving explicit `-e` paths working
  (pi `dist/core/resource-loader.js:316-318,409-411`).
- `tool_result` fires only from `agent.afterToolCall`, which is only reached from the model tool-call
  loop; `user_bash` is a separate event emitted only from interactive mode. Human-typed commands
  cannot be promoted.
- A `tool_result` hook's `usage` replaces rather than adds, and omitting it preserves the original
  (pi `dist/core/agent-session.js:270`, `pi-agent-core/dist/agent-loop.js:509`) — and `grep`, `find`
  and `bash` all resolve `{ content, details }` with no usage, so nothing is being wiped.
- `CONFIG_DIR_NAME` is specifically documented as the rebranding-safe way to do what `src/index.ts:576`
  does (pi `docs/extensions.md:980`).
- A throwing `tool_result` handler is caught by pi and the original result passes through
  (pi `dist/core/extensions/runner.js:722-733`).

---

## 6. Corrections to the audit brief

1. **"`bash` is absent on Windows (pi uses `powershell`)."** Not so — pi uses Git Bash by default on
   Windows and `powershell` is opt-in. See [1.15](#115-on-windows-shell-searches-are-not-promoted).
   This also means README limitation 15 overstates the gap.
2. **"Auto-promotion has run end to end … now verified."** True, but there is no artifact for it.
   Every figure in that paragraph is unsourced prose. The seam being exercised once and the numbers
   describing it being checkable are different things.
3. **"Very large repos, 1000-file `find` results, symlink loops"** as a scale axis — the scale probes
   came back clean (2–3 ms for 1000 stats, ELOOP handled, binaries handled). The scale problems that
   are real are different ones: the 16% brief coverage of a wide `find`, the unbounded whole-file reads
   during verification, and the host process retaining every explorer message.
4. **"What happens when the corpus is a non-git directory"** — nothing in `src/` touches git, and
   pi's grep is ripgrep-backed, so this is not a boundary. No finding.
