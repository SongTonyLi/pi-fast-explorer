# pi-fast-explorer

An extension for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that moves broad code-reading off the main agent's context and onto parallel read-only subagents.

## The problem

When a pi agent needs to understand code spanning many files, it reads them one at a time into its own context. A 40-file sweep can cost on the order of 300k tokens — an illustrative figure, not a measured one — and every one of those tokens is then dragged through every later turn of the session until compaction throws them away. (What *is* measured is smaller and in the same direction: across 60 baseline runs on the benchmark's four questions, a single sweep put 13,597–89,563 tokens into the main context. See [Context](#context--the-claim-that-held).) The cost is not only the tokens: a context full of half-relevant file contents is also a context the model has to reason around.

pi's per-call truncation (50 KB / 2000 lines) bounds a single result but has no notion of how many results accumulate, and auto-compaction fires only near the end of the window, by which point the sweep has been paid for many times over.

fast-explorer fans that reading out to explorer subagents. Each explorer is a separate `pi` process with its own context window, restricted to `read`, `grep`, `find` and `ls`. The main agent gets back cited findings — `file:line`, plus verbatim excerpts of the code that matters — instead of the file contents.

Two entry paths:

- **The `explore` tool** — the model calls it when it knows a sweep is coming.
- **Auto-promotion** — a `tool_result` hook intercepts `grep`, `find` and shell search results that span many files and converts them into parallel exploration without being asked. This path matters more in practice, because the common failure is the model *not* knowing a sweep was coming.

## What it trades

It is **slower and costlier per sweep** than letting the main agent read the files itself. That is measured, not estimated — see [Benchmark](#benchmark) for the run, the numbers and the caveats. The short version:

> **+9.0 seconds per sweep**, with the explorer slower in 14 of 15 paired runs, and somewhat costlier ($0.0217 vs $0.0184 per run), in exchange for far less context consumed — an explorer report of 1.1k–1.4k tokens in place of a 15k–56k-token baseline context, a **13–41x reduction** depending on the question and on which of three baseline samples you take — more reliable recall **on focused questions** (median 1.00 against a baseline that swings 0.50–1.00), and citations that are mechanically verified before they reach you.

That latency figure is `pairedLatency[(pooled), explorer].meanDeltaMs` and `.subjectSlower` in `bench/results/2026-09-11T09-12-16.json`, the first sweep that interleaved the arms instead of running them in per-question blocks; the costs are the mean of `records[].cost` per arm in the same file. **Every latency figure published here before 2026-09-11 was kinder than this one, and it was kinder because the benchmark was partly measuring its own execution order.** See [Latency](#latency--the-corrected-measurement) for the corrected numbers and [the amendment](#amendment-2026-09-11--the-latency-numbers-were-measuring-execution-order) for why the old ones were wrong.

**The recall advantage is established on focused questions and is not established on broad ones.** On the one benchmark question whose answer spans four subsystems (`bash-approval`, ~5,100 lines), the unaided baseline matched one explorer exactly — recall median 1.00 for both, 4 of 5 runs perfect in each arm — while being **2.0x faster** and 1.3x cheaper. The extension bought nothing there except a smaller context and citations. Fan-out on that question was worse than both: recall 0.80. See [The second sweep](#the-second-sweep--a-question-that-spans-subsystems).

(That 2.0x is the worst question in the corpus and it is measured interleaved: `pairedLatency[bash-approval, explorer].ratio.median` = 1.967, `meanDeltaMs` = +22,115, explorer slower in 3 of 3 pairs, in `2026-09-11T09-12-16.json`. An earlier version of this paragraph said 1.26x, from the blocked-design second sweep.)

The trade has a losing side and it is worth naming: the unaided baseline was faster on every question of the first sweep and of the corrected fifth one, in both explorer configurations (the sole question-level exception in six sweeps is noted [under the amendment](#amendment-2026-09-11--the-latency-numbers-were-measuring-execution-order)), it was cheaper, and its *precision* was better on all four questions of the first sweep (0.29–1.00 vs 0.25–0.67) because an explorer cites more files than it strictly needs to. (Precision did not replicate as a clean loss in the second sweep — one explorer was worse on one question, better on two and tied on two — so treat the precision gap as real but not as a fixed ratio.) An earlier version of this design named "make the main agent faster, measurably" as a hard requirement with an acceptance test. It was tested and it failed. The goal has been retired and the failure is recorded in [the design spec](docs/superpowers/specs/2026-09-10-fast-explorer-design.md) rather than quietly dropped.

**Why the context number is the one to weigh.** The latency and the cost are paid once, at the moment of the sweep. The tokens are paid on every turn after it. A baseline sweep put a median of 15k–56k tokens of file contents into the main agent's context, and those tokens are re-sent with every subsequent request until compaction throws them away — and the compaction itself is a multi-second synchronous stall you have also brought forward. An explorer report is 1.1k–1.4k tokens, and that is all the main agent ever carries: the explorer's own reading happens in a separate process whose context is discarded when it exits. Two arms whose per-sweep costs are within 1.5x of each other therefore leave the session in very different states.

So: if your sessions are short and latency is what you feel, this is a bad trade. If they are long and the context window is what runs out first, it is a good one.

## Requirements

- Node >= 22.19.0
- `pi` >= 0.85.0 on `PATH` (explorers are spawned as `pi` subprocesses)
- A working pi provider/model configuration — explorers make real model calls

## Install

```bash
npm install -g pi-fast-explorer
mkdir -p ~/.pi/agent/extensions
ln -s "$(npm root -g)/pi-fast-explorer" ~/.pi/agent/extensions/fast-explorer
```

That is the convention pi's own examples use: extensions are auto-discovered from `~/.pi/agent/extensions/` ("Extension Locations" in pi's `docs/extensions.md`), and a subdirectory there is loaded when it declares `pi.extensions` in its `package.json`, which this package does.

**Symlink the package root, not `dist/`.** The extension reads its explorer prompt from `../prompts/explorer.md`, relative to the file pi loaded it as — and pi does not consistently dereference a symlink before resolving that (both behaviours were observed on pi 0.85.1, depending on where the target lives). A package-root symlink is correct either way, because `prompts/` sits next to `dist/` on both sides of the link. A symlink to `dist/` is not: it resolves to `~/.pi/agent/extensions/prompts/explorer.md`, which does not exist, and pi appends a missing prompt path to the system prompt as literal text rather than failing — so every explorer would run without its output contract and return unparseable reports, with nothing in the logs to say why.

To try it for a single session without installing anything globally, point `-e` at a checkout you have built:

```bash
pi -e /path/to/fast-explorer
```

To remove it: `rm ~/.pi/agent/extensions/fast-explorer`.

## The `explore` tool

```ts
explore({
  question: string,      // what you need to find out
  questions?: string[],  // sub-questions, one per explorer — NOT recommended, see below
  scope?: string,        // glob or directory to limit the search
  fanout?: number,       // lower the number of explorers for this call
})
```

### `questions`: measured, and not recommended

Each entry in `questions` becomes one explorer's brief, and those explorers run concurrently. **Omit `questions` and you get exactly one explorer**, working on `question` alone — there is no planner subagent that decomposes the question for you. The original design had one; it is not in the code, and nothing substitutes for it.

**One explorer is the default, and decomposition has no measured benefit.** Two sweeps against a real repository (`openai/gpt-5.6-luna` on `~/claude-plus-plus`) say the same thing from two directions:

- **On questions one explorer already covers**, fanning out to four cost **3.6x** as much for **identical recall** (median 1.00 either way) and consistently *worse* precision — four explorers cite more files and dilute the ones that matter. That held in both sweeps.
- **On the one question whose answer genuinely spans separable areas of the codebase** — shell-command approval in `~/claude-plus-plus`, four subsystems and ~5,100 lines, added specifically to give fan-out its best case — fan-out cost **2.3x** the single explorer and **found less**: recall 0.80 against 1.00, missing `interactiveHandler.ts` in **4 of 5 runs** despite having a sub-question aimed squarely at it.

That second result is the important one, because it is the case the earlier guidance steered toward. The diagnosis is partition blindness, now measured rather than predicted: each explorer covers its slice and stops, so the connective tissue between subsystems is exactly what falls through. The concurrency pool is not at fault — it measured 2.98–3.56x against sequential execution on four explorers, near its ceiling of 4.

**What this evidence is not.** One separable question, one model, one corpus, hand-written sub-questions. It is suggestive, not conclusive, and it is not a demonstration that fan-out can never help. What it does establish is that there is currently **no measured case in which `questions` pays**, so the tool description, the `promptGuidelines` and the parameter description all now say so. See [Open question: is fan-out ever worth it?](#open-question-is-fan-out-ever-worth-it) for the numbers and for the design that fits them.

```ts
// the default, and the only configuration with evidence behind it
explore({ question: "How does the tokenizer handle trailing commas?" })

// the shape `questions` takes, if you supply it anyway. Measured, this cost 2.3x
// a single explorer and found less, on a question with exactly this structure.
explore({
  question: "How does session auth work?",
  questions: [
    "Where are session tokens minted and what is in them?",
    "How and where are tokens validated on each request?",
    "What is the refresh and expiry path?",
  ],
})
```

The path is kept rather than removed. One separable question is too thin a basis for deleting tested, working code, and the same machinery is what a sequential-escalation design would run on. But it is no longer recommended anywhere, and a call that supplies `questions` is a bet against the only measurement there is.

Supplying `questions` does still remove a round-trip: the main agent is already reasoning when it decides to explore, so it can decompose in the turn it already occupies instead of blocking on a separate planning call. That saving is real and it is not the point — it saves a round-trip on a split that measured worse than not splitting. A model can always ignore guidance, so if you are calling `explore` yourself, the numbers above are the ones to weigh.

`questions` is truncated to `maxFanout` entries. `fanout` is clamped into `[1, maxFanout]`, so it can only narrow a call, never widen it past the configured ceiling.

`scope` is appended to each brief as "Limit your search to: …". It is an instruction to the explorer, not an enforced filter — an explorer that ignores it is not prevented from reading elsewhere in the repository.

The tool returns the concatenated explorer reports. Explorers that failed, timed out or produced nothing are listed by name under a `## Not Covered` heading rather than dropped, so the main agent can see which part of the tree is unverified. Explorer token usage and cost are reported back to pi, so they appear in session totals.

## Auto-promotion

The `tool_result` hook watches successful `grep`, `find` and `bash` results. It promotes when the result looks like a sweep **and** there is enough material to be worth the overhead. Those are two separate gates:

**Is it a sweep?** (`shouldAutoPromote`, breadth *or* density — not a single threshold)

- `files >= autoPromote.minFiles` (default 15) — breadth, or
- `matches >= autoPromote.minMatches` (default 60) **and** `files >= 3` — density

The `files >= 3` floor on the density branch exists so that one file with a thousand matches is treated as the narrow search it is, not as a sweep.

**Is it worth it?** (`shouldExplore`) The matched files' sizes are summed — with an early exit as soon as the floor is cleared — and promotion is abandoned if the total is below `minTotalBytes` (default 50 KB). Below that floor, letting the main agent read the files directly is both faster and higher fidelity.

When both gates pass:

1. The matched paths are re-anchored on the session cwd (grep and find emit paths relative to their own search root) and bucketed by directory into `clamp(ceil(files / 8), 2, maxFanout)` groups.
2. One explorer runs per bucket, with a brief naming the pattern, the scope, and the total file count.
3. **If every explorer failed, the hook returns nothing and your original search result is left exactly as it was.** No spill file is written, because nothing is being replaced and a file whose path nobody is told is litter.
4. Otherwise the raw grep/find text is written to a spill file in the OS temp directory, mode `0600`, and the tool result the model sees is **replaced** by the synthesized findings, followed by the spill file path.

Nothing is destroyed: either the match list is on disk with its path in the result, or the match list is still the result. The model can read the spill file if the findings are not enough.

Step 3 is the whole of the failure story, and it is deliberately unconditional: whatever went wrong — `pi` not on `PATH`, a bad `model` or `thinking` value, a provider outage, or a pi release that changes a `stopReason` string this extension does not recognise — the worst case is that you paid for explorers and got your grep output, rather than paying for explorers and losing it.

Briefs are phrased per source on purpose. A grep pattern carries real intent, so that brief leans on it. A glob carries none — `**/*.ts` says only "these are TypeScript files" — so that brief asks what the files *are* rather than inviting the explorer to invent a purpose. A shell command carries the most of the three, since `rg -n --glob '!node_modules' 'tool_use_id' src/` states the pattern, the exclusions and the scope in one string; that brief quotes the command as a statement of intent and tells the explorer not to run it, because explorers have no shell.

Auto-promotion is a trade, not a free win. A grep the model intended as a quick existence check becomes several seconds of exploration and a model call per bucket. Set `autoPromote.enabled` to `false` to keep only the explicit `explore` tool, or `autoPromote.bash` to `false` to keep the hook for the structured tools only.

### Why `bash` is in the trigger set

Because a hook watching only `grep` and `find` was measured missing the case it exists for. Asked *explicitly* to "use the grep tool" to search `src/`, a real session on pi's default toolbelt ran this instead:

```json
{"type":"tool_execution_end","toolName":"bash",
 "args":{"command":"grep -RIn -- \"tool_use_id\" src/"}}
```

The same session restricted to `--tools read,grep,find,ls` promoted correctly, so the machinery was right and only the trigger was too narrow. `bash` ships in pi's default tool set, and models reach for it.

Detection is by **output shape, not by command parsing**. Nothing here knows what `grep`, `rg`, `ag` or `git grep` are, and nothing tries to unpick pipes, flags or quoting; the end-to-end run that confirmed this works was a `rg -n` invocation that no hand-written command parser in this repository would have recognised. What the hook does instead is parse the output as `path:line:text` and then demand that the output describe *this repository*:

- **Paths resolve.** At least 90% of the distinct parsed paths must exist as files on disk. Real search output resolves at 1.00; a Node stack frame parses as `    at a (/tmp/crash.js`, a vitest failure as ` ❯ x.test.ts`, a syslog line as `2026-09-11 12`, and none of those resolve at all. The 10% of slack absorbs the ways a genuine sweep loses a path — output the bash tool truncated mid-line, a file deleted between the search and the hook — and allows exactly one bad path in the smallest promotable sweep.
- **The text is the file's line.** Up to 10 rows, strided across the match list, are read back off disk and compared against the file's real content at the cited line. This is the gate resolution cannot cover, and it is not hypothetical: compilers and linters emit `path:line:col: message` about real files, so they pass a resolution check outright. mypy's default `path:line: error: …` parses to a real file at a real line. What a diagnostic cannot do is carry the file's actual source text there, because it is a message *about* the line. Search output round-trips exactly; 80% of the sample must match.

Both gates are mechanical properties of the output. Neither enumerates a tool, a command or a message format, so nothing rots when clang rewords a diagnostic or someone reaches for a grep clone this extension has never heard of.

That second gate is load-bearing, and the proof is a real session rather than a fixture. Twenty C files, 80 KB, each with a warning on line 3, compiled with `-fno-show-column -fno-caret-diagnostics` so the output is exactly `path:line: message`, and `-Wno-error` so the command exits 0 and cannot be dismissed as a failed tool call. A real `gpt-5.6-luna` session ran it and the result was **not** promoted — the model got clang's 2,710 bytes back byte for byte. Every cheap gate had passed: 20 distinct paths, all 20 resolving, 80 KB of matched files. `verifyMatchedLines` returned `{ attempted: 10, verified: 0 }`, and that is the only reason the raw diagnostics survived.

**That session was not recorded, so those five numbers are an unreproducible measurement** — no artifact, no log, no fixture directory survives it. What *is* checkable is the property it demonstrates, and that is covered: `tests/bash-promote.test.ts` runs the same shape against synthetic diagnostics (with different numbers), and the thresholds the paragraph names are constants in `src/detect.ts`. Read the session as an anecdote that motivated the gate, not as its evidence.

Three more things hold this path in place:

- **Only the model's own commands.** A command *you* type at the prompt goes through pi's `user_bash` event, which this extension does not register for. `tool_result` fires from `agent.afterToolCall` and nowhere else, so a shell command run by a human can never have its output replaced. The bash the hook sees was chosen by the model, in exactly the way it chooses `grep`.
- **Failed commands are skipped.** A non-zero exit makes pi's bash tool throw, which arrives as `isError`, which the hook ignores — so the usual broken build never reaches the gates in the first place.
- **Reading the spill back is not a loop.** Every promotion ends with "Raw command output saved to: …", and with a shell available the model takes that invitation by running `cat`. That output is a perfect promotion candidate: it parses, resolves and verifies. So promoted outputs are remembered (32 of them, by hash) and never promoted twice. A repeated *grep* still promotes — repeating a search is searching — but reading a spill file back returns the spill file.

Two shapes are deliberately not promoted, and both fail closed: `grep` without `-n` (`path:text` carries no line number and is far too weak a shape to key on) and `rg --column` (`path:line:col:text` parses, but the text no longer matches the file's line, so verification refuses it).

## Configuration

Defaults:

```json
{
  "model": null,
  "thinking": "off",
  "maxFanout": 4,
  "concurrency": 4,
  "maxTurnsPerExplorer": 8,
  "minTotalBytes": 51200,
  "autoPromote": { "enabled": true, "bash": true, "minFiles": 15, "minMatches": 60 },
  "timeoutMs": 120000
}
```

| Key | Meaning |
|---|---|
| `model` | Model id for explorers. `null` inherits the dispatching session's model, which is the default because a weaker model deciding what matters in unfamiliar code is the largest quality risk here. Setting it to a cheaper model is where the cost saving lives. |
| `thinking` | Thinking level passed to each explorer (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Off by default even when the model is inherited: retrieval is not reasoning, and per-turn latency dominates wall-clock. |
| `maxFanout` | Maximum explorers per call. Must not exceed `concurrency`. |
| `concurrency` | Ceiling on explorers running at once, extension-wide (see limitations). |
| `maxTurnsPerExplorer` | Turn budget written into each explorer's task text, phrased as a target to come in under. pi has no turn-limit flag, so this is **advisory** — an explorer can and sometimes does exceed it, and nothing here prevents that. It was 5; 5 was measured failing runs that had already succeeded (**7 of the 40 explorer-arm runs** over budget, **all 7** at exactly 6 turns, **all 7 with recall 1.00** on re-scoring), so it is 8. The pressure to finish fast lives in `prompts/explorer.md`, which asks for about 3 turns. That original argument has since been retired at its source — the bench now reports overruns instead of discarding the run — so **6 was benchmarked against 8 and bought nothing**. Median explorer turns fell 6 → 5 and explorer median wall-clock fell 29,529 → 27,853 ms, but the baseline fell with it (22,088 → 20,622 ms), and `bash-approval` median recall stayed 0.80 either way. (That experiment was published as a pair of ratios, 1.35 at 6 against 1.34 at 8. Both were blocked-design and both are now withdrawn — see [the amendment](#amendment-2026-09-11--the-latency-numbers-were-measuring-execution-order). The conclusion stands on the mechanism instead, which is the stronger evidence and was always the real argument.) **The gap is per-turn cost, and no turn budget reaches it:** interleaved, the explorer runs 5,045 ms/turn against the baseline's 3,744 ms/turn while taking about the same number of turns — mean 5.13 against 4.93. See `FINDINGS["turn-budget-not-a-latency-lever"]` in `bench/run.ts`, whose own evidence block rests partly on the withdrawn ratios. |
| `minTotalBytes` | Byte floor below which exploration is skipped and the original result is left alone. |
| `autoPromote.enabled` | Turns the whole `tool_result` hook off without affecting the `explore` tool. |
| `autoPromote.bash` | Whether `bash` results that parse as search output are promoted too. Separate from `enabled` because the risk profile differs, not the feature: a `grep` result is a search by construction, while a `bash` result is whatever the model ran, so promoting it rests on inferring intent from output shape. Turn it off to keep promotion for the structured tools only. |
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

Turn budget: about <maxTurnsPerExplorer> turns. Aim to come in well under it — but a
complete report matters more than the budget, so take an extra turn if the brief
genuinely needs one."
```

## Why explorers run with `--no-extensions`

This flag is load-bearing. Do not remove it.

Without it, pi's extension discovery runs inside every explorer, which means every explorer loads *this extension*. The explorer prompt instructs explorers to issue every independent search in a single message, so each explorer fires many greps — and each of those grep results hits the auto-promotion hook, which spawns another wave of explorers, each of which does the same. The branching factor is per grep, not per explorer: taking it as roughly 40 per level, one level is 40 processes, two is ~1,600, three is ~64,000. (The 40 is an estimate with no artifact behind it — an earlier version of this paragraph called it "measured", which overstated it. The arithmetic above is only as good as that figure. What is not an estimate is that the recursion happens at all: that was observed, and it is why the flag is load-bearing.)

Verified against pi 0.85.1: neither print mode (`-p`) nor `--no-session` stops extension discovery. `--no-extensions` is what stops it.

There is a second layer, because `--no-extensions` cannot cover everything: explicit `-e <path>` loads still work with that flag set, and discovery is never consulted for them. So every explorer is spawned with `PI_FAST_EXPLORER_NESTED=1` in its environment (inherited by the whole subtree), and the auto-promotion hook's very first action is to return early when it sees that variable. Either layer alone would hold today; both are cheap and the failure mode is a fork bomb.

Adding `bash` to the trigger set does not widen any of this. There is a third layer under it that is structural rather than defensive: explorers are spawned with `--tools read,grep,find,ls`, so an explorer has no shell whose output could promote even if both other layers were removed. The `PI_FAST_EXPLORER_NESTED` check still runs first and still covers every tool.

## When not to use it

- **Fewer than a handful of files.** The `explore` tool's own guidance is "more than ~5 files"; auto-promotion needs 15 files, or 60 matches across at least 3. Each explorer pays a fixed cost — process spawn, system prompt, tool definitions, `AGENTS.md` — and over-fanning a small job is pure loss.
- **Under the byte floor.** Below `minTotalBytes` (50 KB of candidate files), reading directly is faster and loses nothing.
- **You already know the exact file and line.** Read it.
- **Edit-heavy work.** Explorers cannot edit. Exploration that only precedes a one-line change was probably not worth a subprocess.
- **Interactive debugging.** When you need to iterate against real output, a summarized index of the code is the wrong shape and explorers have no `bash` to reproduce anything with.

## Benchmark

Unit tests prove the gates and the helpers behave. Only the benchmark says whether exploration is any good, so it is a separate suite that is never part of `npm test` — it spends real model calls.

```bash
npm run bench                              # 5 runs per question per arm
BENCH_REPO=/path/to/repo npm run bench     # a different corpus
BENCH_MODEL=some/model npm run bench       # a different model
BENCH_RUNS=1 npm run bench                 # one run per question
npm run bench -- --context                 # context delta only, reusing reports on disk
npm run bench -- --self-check              # score synthetic reports, no model calls
```

Results are written to `bench/results/<timestamp>.json`. The suite skips with a clear message when the corpus is absent, so the published package does not depend on anyone having a particular clone.

#### The artifacts are in the repository, with the report text stripped

`bench/results/` was gitignored until 2026-09-11. Every number below was therefore uncheckable from a clone — including the numbers that argue against this extension, which are the ones a reader most needs to be able to verify. All fifteen artifacts are now committed, superseded runs included: the disagreement *between* runs is itself evidence, and pruning to the runs the prose happens to cite is the failure mode this section exists to avoid. That disagreement is not decoration — five sweeps' worth of it is what exposed the execution-order confound described [below](#amendment-2026-09-11--the-latency-numbers-were-measuring-execution-order).

One thing was removed. `records[].report` held the verbatim explorer and baseline reports — about 1 MB of source quoted out of the benchmark corpus, which is a private third-party repository. That field is stripped; `reportChars` is kept. Since `estimateTokens` is `ceil(chars / 4)`, every report-token figure in this README recomputes exactly from `reportChars`, and every other published number (`elapsedMs`, `cost`, `turns`, `turnCapExceeded`, `coverage`, `score`, `quoteRates`, `armSummaries`) was already a stored field. What you cannot do with the committed copies is re-derive the quote-level scoring from raw text, or re-run `npm run bench -- --context` against them — that path reuses stored report text and will report `n/a` for the explorer columns. Unstripped copies live at `bench/results/raw-reports/`, which stays gitignored.

| artifact | what it is |
|---|---|
| `2026-09-11T04-37-10.json` | **First sweep.** 4 questions × 5 runs × 3 arms, `maxTurnsPerExplorer: 5`. Latency, cost, recall/precision, citation quality, turn overruns. |
| `2026-09-11T05-44-05.json` | **Second sweep.** 5 questions × 5 runs × 3 arms at current defaults. The fan-out result and the 4.9% fabrication rate. |
| `2026-09-11T08-02-02.json` | **Third sweep.** 5 questions × 3 runs × 3 arms, `maxTurnsPerExplorer: 8`, after `autoPromote.bash` was added. Blocked arm order; its latency comparison is superseded. |
| `2026-09-11T08-29-29.json` | **Fourth sweep.** Identical to the third except `maxTurnsPerExplorer: 6`. The turn-budget experiment, and the null result that reverted it. Blocked arm order. |
| `2026-09-11T09-12-16.json` | **Fifth sweep — the latency source of record.** Identical config to the third (5 questions × 3 runs × 3 arms, cap 8), but the arms are **interleaved run-by-run**. 45 runs, 0 failures, 0 turn overruns, 1,122 s, $1.75. Carries `executionOrder`, `pairedLatency`, and per-record `slot`/`startOffsetMs`. |
| `2026-09-11T04-50-55-context.json`, `…T04-57-07-context.json`, `…T05-06-53-context.json` | Three independent 5-run baseline context samples. The context table is the range across all three. |
| `2026-09-11T04-45-13-context.json` | A 1-run context probe. Kept for the record, excluded from the table — not comparable with the 5-run samples. |
| `2026-09-11-context-range.json` | Derived. The context table's arithmetic, naming each source file and field. |
| `2026-09-11T04-37-10-turncap-rescore.json` | Derived. Coverage for the 7 turn-capped runs of the first sweep, which that build never scored. |
| `2026-09-11.json`, `…T03-56-01.json`, `…T04-06-53.json`, `…T04-18-41.json` | Superseded earlier sweeps. Nothing in this README cites them; they are kept so the sequence of runs is visible rather than curated. |

The two derived artifacts are not `bench/run.ts` output. Each states in its own `method` field exactly how it was produced, and the re-scoring one carries a sanity check: the reimplementation of `scoreCoverage` used to produce it reproduces all 38 stored coverages in the source artifact field for field.

Five sweeps are described below, and they do not all speak to the same thing. **Latency comes from the fifth and only the fifth** ([Latency](#latency--the-corrected-measurement)), because it is the only one that interleaved the arms. Citation quality and the first recall/precision numbers come from the first ([The first sweep](#the-first-sweep--recall-citations-and-a-retired-latency-table)). The fan-out result comes from the second ([The second sweep](#the-second-sweep--a-question-that-spans-subsystems)). The third and fourth are the turn-budget experiment. The context numbers come from none of them — they are a separate set of baseline runs, described under [Context](#context--the-claim-that-held).

### Latency — the corrected measurement

`bench/results/2026-09-11T09-12-16.json` — corpus `~/claude-plus-plus`, model `openai/gpt-5.6-luna`, 5 questions × 3 runs × 3 arms, 45 runs, `maxTurnsPerExplorer: 8`, arms interleaved run-by-run. 0 failures, 0 turn overruns, 1,122 s of wall-clock, $1.75.

Three numbers, in the order they should be weighed.

#### 1. Paired per-run delta — the headline

Each explorer run is subtracted from the baseline run of the *same question and the same run index*, and the differences are averaged. From `pairedLatency` in that artifact:

| | mean delta (`meanDeltaMs`) | runs the subject lost (`subjectSlower` / `pairs`) | per-run ratio (`ratio.median`) |
|---|---|---|---|
| explorer vs baseline | **+9,015 ms** | **14 / 15** | 1.458 |
| fanout vs baseline | +9,428 ms | 14 / 15 | 1.552 |

Per question, explorer vs baseline (`pairedLatency[<id>, explorer]`):

| question | mean delta | slower in | `ratio.median` |
|---|---|---|---|
| persistence | +2,634 ms | 3/3 | 1.136 |
| tracking | +3,939 ms | 2/3 | 1.140 |
| microcompact | +7,546 ms | 3/3 | 1.458 |
| cache-safety | +8,838 ms | 3/3 | 1.562 |
| bash-approval | **+22,115 ms** | 3/3 | **1.967** |

The baseline was faster at the median on all five questions and lost only one of fifteen paired runs — `tracking` run 2, by 1,364 ms (`deltaMs.min`).

**Fan-out against one explorer is a wash on latency, and was published as 1.17x slower.** Pairing the two explorer arms the same way gives a mean delta of **+414 ms** and a median ratio of **0.994**, with fan-out slower in 7 of 15 — indistinguishable from zero. The first sweep's 1.17x was the same blocked-order artefact, since the explorer block always ran before the fan-out block. What fan-out actually costs is money: **3.5x** the single explorer's spend ($0.0768 vs $0.0217 per run, mean of `records[].cost`). The case against `questions` was never a latency case and does not weaken. (This pairing is a README-side derivation over `records[]`; `pairedLatency` only pairs against the baseline arm.)

**Why the mean and not the median.** Under drift of any constant rate, the expected paired delta is the true delta plus that rate times the mean gap in wall-clock position between the two arms — so a mean paired delta is unbiased exactly when that gap is zero, without anyone having to know the rate. Rotation drives it there: `executionOrder.balance[].meanSlot` is **22 for all three arms**, exactly equal, and the residual in wall-clock terms is `executionOrder.meanOffsetGapToBaselineMs.explorer` = **6,348 ms** across a 1,096,629 ms sweep. Regressing `elapsedMs` on `startOffsetMs` across all 45 records gives 0.0132 ms per ms of offset, so even taking that slope at face value the residual gap explains **84 ms of the 9,015** — under 1%. (That slope is computed from the same latencies it is correcting, so read it as an order-of-magnitude bound, not a proof.) The median paired ratio is reported alongside because it survives a timed-out run, which the mean does not.

#### 2. Per-turn wall-clock — where the penalty actually lives

Pooled medians of `records[].elapsedMs / records[].turns`:

| arm | ms/turn | turns (median / mean) |
|---|---|---|
| baseline | **3,744** | 5 / 4.93 |
| explorer | **5,045** | 4 / 5.13 |
| fanout | 4,807 | 6 / 6.00 |

The explorer takes **about the same number of turns as the baseline** — 5.13 against 4.93 on the mean — and each of its turns costs **35% more**. That is the whole of the gap. The explorer prompt asks for ten concurrent searches and a structured, cited report; that is a protocol cost, and no turn budget reaches it. This is the finding that survived the confound, because it never depended on a cross-arm ratio of totals.

The explorer's per-turn figure is also the most reproducible number in this repository. Across the three sweeps run at 5 questions and cap 8 — `05-44-05`, `08-02-02`, `09-12-16` — it reads 4,925 / 5,004 / 5,045 ms/turn, a spread of 2.4%, while the same sweeps' explorer *totals* span 22,001–29,529 ms, a spread of 34%.

**The baseline's per-turn figure is not that stable, and the ratio inherits its instability.** Over the same three sweeps the baseline reads 4,043 / 4,949 / 3,744 ms/turn — a 32% spread, no better than its own totals. So publish the two absolute figures; do not treat 1.35x-per-turn as a constant of nature. (The 4,949 outlier is the blocked third sweep, where the baseline block ran last. That is consistent with drift and is not evidence for it — see the amendment.)

These are pooled over all 15 runs of each arm. `bench/run.ts` emits `armSummaries[].msPerTurn` per question only, so the pooled figure is a README-side derivation over `records[]`, following `summarize()`'s even-`n` convention.

#### 3. Context — still the headline overall

A 13–41x reduction in what the sweep leaves in the main agent's context, unchanged by any of this and unaffected by execution order. It is measured on separate runs and is the only claim here whose effect size clears the noise floor by more than an order of magnitude. See [Context](#context--the-claim-that-held).

#### The pooled ratio of medians is retired

Until 2026-09-11 this README led with a single number — median explorer latency over median baseline latency, pooled across questions. It is gone, and not merely updated. Three reasons, only the first of which is about the confound:

1. **It was measuring execution order.** See the amendment below.
2. **It is a statistic about the question mix, not about the extension.** Explorer medians in this sweep span 19,491 ms (`persistence`) to 42,350 ms (`bash-approval`) — a 2.2x range across five questions. Pooling medians makes the published figure a function of which questions happen to be in the corpus, so adding a hard question moves the headline without anything in the code changing.
3. **It is n=3 medians per question.** A median of three is the middle run.

For the record, and so nobody has to recompute it to compare with older text: on this interleaved sweep the retired statistic reads **1.244** (22,001 ms / 17,680 ms), which is *lower* than the blocked third sweep's 1.337 even though every paired statistic moved against the extension. That divergence is the argument against the statistic in one line.

#### Amendment (2026-09-11) — the latency numbers were measuring execution order

**Every latency ratio this project published before this date came from a benchmark design that was confounded by execution order, and all of them understated the cost.**

The harness ran the arms in per-question blocks: all explorer runs, then all fan-out runs, then all baseline runs. The baseline was therefore systematically the last arm measured for every question. Reconstructing arm start times from `records[].elapsedMs` in array order, the baseline block in `2026-09-11T08-02-02.json` began on average **171.8 s** later in the sweep than the explorer block. The headline ratio was explorer over baseline, so anything that made later runs slower inflated the denominator and flattered the extension.

(`FINDINGS["turn-budget-not-a-latency-lever"]` lists that gap as 169 s, and the other four as 269 / 175 / 166 / 78 s. The difference is only that it measured to each run's midpoint where the new `startOffsetMs` field measures to its start; start-based, the same five are 171.8 / 271.6 / 176.4 / 167.9 / 80.0 s. Nothing turns on which convention is used.)

Commit `7c220f5` interleaved the arms run-by-run with the order rotated by run and question. Rotation was chosen over a shuffle because at three runs per question a fair shuffle lands the baseline last in all three about one time in 27; rotation balances mean position exactly rather than in expectation. `BENCH_ORDER=random` remains for the case rotation cannot defend against — a fixed period resonating with an external one — and the seed is recorded either way. The mean arm start-offset gap fell from ~172 s to **6.3 s**.

Same config, same corpus, same model, same cap of 8, three runs per question — only the ordering changed:

| statistic | blocked (`08-02-02`) | interleaved (`09-12-16`) |
|---|---|---|
| paired mean delta | +6,385 ms | **+9,015 ms** |
| runs where the explorer was slower | 11 / 15 | **14 / 15** |
| paired median ratio | 1.337 | **1.458** |
| mean arm start-offset gap to baseline | ~171,800 ms | **6,348 ms** |

The conclusion did not change — no sweep has ever found this extension faster overall, and the corrected one has the baseline ahead at the median on all five questions. What changed is the magnitude, and it changed in the direction that is worse for the extension, which is why the kinder number could not be left standing.

(One exception exists in the record and is not worth hiding: in the blocked second sweep the explorer's median on `tracking` was 22,648 ms against the baseline's 27,706 ms, and fan-out's was 26,116 ms — the only question-level win either arm has scored across six sweeps. It did not survive interleaving: `tracking` is +3,939 ms and 2 of 3 pairs lost in `09-12-16`. The likelier explanation is the control arm, not the extension — the baseline's own median on `tracking` reads 27,706 ms in that sweep and 19,949 ms in the interleaved one at the same settings, a 7,757 ms swing on the control alone, larger than the 5,058 ms "win" it produced.)

**What is established, and what is not.**

*Established:* the blocked design left execution order free to explain the ratio. A confound does not have to be proven active to invalidate a measurement; it has to be possible and uncontrolled, and this one was both. That is sufficient to discard every pre-interleaving ratio, which the artifact itself says in `comparability.note`: *"Treat every pre-interleaving ratio as uninterpretable rather than merely noisy."*

*Not established: that latency actually drifts upward during a sweep.* The evidence once offered for it was that block separation rank-orders the reported ratio across five blocked sweeps (Spearman −1.0, Pearson −0.85, recorded in `comparability.note` and in `FINDINGS["turn-budget-not-a-latency-lever"]`). That correlation is **circular** — the block gap was itself reconstructed by summing the very `elapsedMs` values that form the ratio's numerator and denominator, so the two sides of the correlation share their inputs. The non-circular test is the within-block slope of `elapsedMs` against run index, and it does not hold up: pooled over every `(question, arm)` block it reads **+360, −837, +71, +781, +979 ms per position** across the five blocked sweeps. It changes sign. Drift is a plausible mechanism with no clean evidence behind it, and nothing here depends on it being real.

**The fix has its own possible bias, and it is not separable from this data.** Interleaving widens the gap between consecutive runs of the same arm — median 30.8 s to 72.2 s for the explorer, 25.9 s to 60.5 s for the baseline. If the provider caches prompt prefixes, wider spacing costs cache locality, and the explorer carries the larger cached prefix (its own system prompt plus `prompts/explorer.md`), so it has more to lose. Some unknown part of the 1.337 → 1.458 move could be that rather than bias removal. The assessment is that it is small — 60–90 s of separation sits well inside plausible cache TTLs, and the spacing widened for both arms by a similar factor — but it is not zero, and this sweep cannot separate the two effects. Measuring it needs a third design, not another run of this one.

**The methodology finding outlasts the number it corrected.** Five sweeps agreed with each other on the *sign* of the result and were internally consistent, and a sixth measurement of the same quantity moved it by 41% on the mean delta. Cross-sweep consistency is evidence that a harness is deterministic. It is not evidence that the harness is measuring the thing named in the column header.

### The first sweep — recall, citations, and a retired latency table

`bench/results/2026-09-11T04-37-10.json` — corpus `~/claude-plus-plus`, model `openai/gpt-5.6-luna`, 4 questions × 5 runs × 3 arms, 60 runs, `maxTurnsPerExplorer: 5`. The arms:

| arm | what it is |
|---|---|
| `baseline` | plain pi with no extension, told to investigate the codebase directly. The control. |
| `explorer` | one explorer on the undecomposed question — what `explore({ question })` does. |
| `fanout` | four explorers on hand-written sub-questions, run concurrently. |

#### Latency and cost — the ratios here are withdrawn

| arm | median latency | vs baseline | cost/run |
|---|---|---|---|
| baseline | 13,983 ms | — | $0.0122 |
| explorer | 16,276 ms | ~~1.16x slower~~ | $0.0176 |
| fanout | 19,051 ms | ~~1.36x slower~~ | $0.0629 |

**The "vs baseline" column is struck through because this sweep ran the arms in per-question blocks with the baseline always last.** 1.16x and 1.36x were the figures this README led with until 2026-09-11; both are understatements produced by the execution-order confound described under [Latency](#latency--the-corrected-measurement). Use +9,015 ms and 14/15 from the fifth sweep instead. The absolute medians and the costs are left in place: they are what this sweep measured, they are not cross-arm ratios, and the cost column does not depend on when a run was scheduled.

These are pooled over all 20 runs of each arm — median of `records[].elapsedMs`, mean of `records[].cost`. `bench/run.ts` never computes that statistic; it prints per-question stats only (`armSummaries[]`), so this table is a README-side derivation over the artifact rather than something the suite emits. It follows `summarize()`'s even-`n` convention of averaging the two middle values, which is why the baseline's 13,982.5 appears as 13,983.

The baseline was faster on every one of the four questions, in both explorer configurations — and it was faster on all five questions of the interleaved sweep too, so that part replicated once the ordering was fixed. There is no arrangement of this extension that is faster than not running it, and the design originally claimed there would be — see the spec.

The concurrency pool is not the reason. Fan-out measured 3.0–3.3x against sequential execution of the same four explorers, near its ceiling of 4. The cost is per-explorer fixed overhead (process spawn, system prompt, tool definitions, `AGENTS.md`) plus the fact that an explorer's wall-clock is turns × per-turn latency, and parallelism does not reduce the turns inside any one explorer.

#### Recall and precision

Per-question medians, against a ground-truth file set established by exhaustive search rather than by running this extension:

| question | recall (baseline) | recall (explorer) | precision (baseline) | precision (explorer) |
|---|---|---|---|---|
| microcompact | 0.50 | 1.00 | 1.00 | 0.67 |
| persistence | 1.00 | 1.00 | 0.33 | 0.25 |
| cache-safety | 1.00 | 1.00 | 0.29 | 0.25 |
| tracking | 1.00 | 1.00 | 0.33 | 0.29 |

The explorer's recall median was 1.00 on all four. The baseline's swung run to run — 0.00 to 0.50 on microcompact, 0.00 to 1.00 on cache-safety, 0.50 to 1.00 on tracking. Recall is the metric that decides whether the answer you get is built on the right files, and it is where the explorer is reliably better **on questions of this size**. All four of these are answerable from one or two files in a single directory. On the broader question added later, the baseline matched the explorer at 1.00 and the advantage disappeared — see [the second sweep](#the-second-sweep--a-question-that-spans-subsystems).

Precision goes the other way, on all four questions: an explorer cites more files than the baseline does, including ones that are not in the ground-truth set. That is the cost of asking a subagent to over-report rather than under-report, and it means you will read some citations that turn out not to matter. (This did not replicate cleanly in the second sweep, where one explorer was worse on one question, better on two and tied on two.)

#### Citation quality

Across the 33 reports that scored (of 40 `explorer` and `fanout` runs — the `baseline` was never shown the output contract, so it is not judged against it), 520 quote blocks:

| | |
|---|---|
| Contract compliance | every scored report parsed into citations and quotes — **0 violations** |
| Exact anchors, as the model wrote them | 386/520 (74%) |
| Anchor drift — real code, wrong line number | 119/520 (23%), corrected automatically at runtime |
| Content the cited file does not contain | 15/520 (**2.9%**) |
| Exactness of what the main agent actually receives | median **1.00** per report (min 0.67) |

All six figures are the `quoteRates` object of `2026-09-11T04-37-10.json`: `quotes: 520`, `fabricated: 15`, `fabricationRate: 0.0288`, `drift: 119`, `deliveredExactAnchors: {median: 1, min: 0.6667, n: 33}`.

Drift is corrected rather than gated: `synthesize` runs every report through `reanchorReport` before the main agent sees it, so a verbatim quote with a wrong line number arrives with the right one. What cannot be repaired is marked in place on the fence header — `UNVERIFIED`, `PARTIAL`, `MISATTRIBUTED`, `UNCHECKED` — rather than silently dropped or silently kept.

**What the verifier can read, and what it says when it cannot.** A quote is verified when it sits in a fenced block (` ``` ` or `~~~`) whose first line is a comment naming `path:line`, opened with `//`, `#`, `--`, `;`, `%`, `<!--` or `/*` — so SQL, Lua, Haskell, HTML, CSS, Lisp, assembly, MATLAB and LaTeX excerpts are checked, not just TypeScript ones. Two cases fall outside that and neither is passed over in silence: a file larger than 4 MB is not read at all and its block is marked `UNCHECKED: cited file is too large to verify`, and a block inside a fence the model never closed cannot be delimited, so it is marked `UNCHECKED: unterminated code fence` and counted in `ReanchorResult.unparsed`. `findUnmarkedFailures` — the check that proves no failure reaches you unlabelled — reports an unparseable block as a finding rather than as a clean run, because a checker that cannot see a block has to say so.

**The fabrication gate is defined to fail at any non-zero rate, and on this run it failed**, at 2.9%. That is the honest state of the suite: roughly one quote block in 35 claims content the cited file does not hold. The runtime marker means such a block reaches you labelled, but the label depends on the verifier catching it.

The verifier itself was validated by injecting 49,985 mutations into known-good quotes: 182 escaped (0.364%), and **every** escape fell in one class — all-comment quotes where deleting a word still leaves a contiguous verbatim run, which the `reflowed` verdict is defined to accept. Restricted to quotes containing code, 43,777 mutations were injected and none escaped.

> **Unreproducible measurement.** Unlike everything else in this section, these four figures resolve to no file. The sweep was a one-off script that was not kept: there is no artifact, no test and no data file for it anywhere in this repository, and the numbers appear only as prose here, in `bench/run.ts`'s `FINDINGS` and in the design spec. They are internally consistent (182 / 49,985 = 0.364%) and that is the whole of the evidence. The *shape* of the finding — that comment-only quotes are checked more loosely than code, because `locateReflow` is gated to all-comment quotes — is readable straight out of `src/citations.ts` and does not depend on the sweep. The specific rates do. Treat them as a recorded observation, not as a result you can check.

### Context — the claim that held

*(Not part of either sweep. Its own runs, its own artifacts.)*

**The baseline column does not come from the first sweep.** It comes from three separate `--context` runs, which re-execute the baseline arm on its own and reuse the stored explorer reports. An earlier version of this README cited `2026-09-11T04-37-10.json` for this table; that file does not contain a baseline context column at all. The baseline runs behind the first sweep's latency table and the baseline runs behind this one are different runs.

Those three `--context` runs measured the same quantity, at the same settings, on the same questions — and **they disagree by as much as 1.6x on a single question**. Baseline context turns out to be the noisiest thing measured here: individual runs span 13,597–89,563 tokens. Picking one artifact and publishing its medians would be an arbitrary choice that happens to move the headline between 20–32x and 20–36x, so the table reports the span across all three instead.

Median tokens entering the **main** agent's context, per question. Each baseline cell is `rows[].baselineContextTokens.median` from one of the three artifacts, in file order (`…T04-50-55` / `…T04-57-07` / `…T05-06-53`); each report cell is the median of `ceil(records[].reportChars / 4)` over that arm in `2026-09-11T04-37-10.json`:

| question | baseline (3 samples of 5 runs) | explorer report | reduction | fan-out report | reduction |
|---|---|---|---|---|---|
| microcompact | 14,860 / 22,272 / 23,896 | 1,100 | 13.5–21.7x | 3,858 | 3.9–6.2x |
| persistence | 56,420 / 35,388 / 39,688 | 1,382 | 25.6–40.8x | 3,400 | 10.4–16.6x |
| cache-safety | 39,125 / 31,777 / 27,241 | 1,344 | 20.3–29.1x | 3,874 | 7.0–10.1x |
| tracking | 47,876 / 43,656 / 48,956 | 1,371 | 31.8–35.7x | 4,351 | 10.0–11.3x |

So: **13–41x**, and **11 of those 12 question-by-sample combinations are at 20x or better** — the exception is microcompact in the first sample, at 13.5x. The arithmetic, with every source file and field named, is in `bench/results/2026-09-11-context-range.json`. A fourth context artifact (`…T04-45-13-context.json`) exists and is excluded: it is a single run per question, not a 5-run sample.

The right reading of that spread is that the *floor* is the trustworthy part. How much context a baseline sweep consumes depends on how many files that particular run decided to read, which varies enormously; how large an explorer report is barely varies at all (1,021–2,032 tokens across every explorer run of every question). The reduction is large and the exact multiple is not a stable number.

Tokens are estimated as chars/4, validated to within ~5% of the API-reported prompt size. The baseline figure is `finalPromptTokens` — `usage.input + cacheRead + cacheWrite` on the final baseline turn — which is the real API-reported size rather than an estimate.

The explorers' own token spend does not appear in this table because it does not enter the main context — it is spent in a subprocess and discarded when that subprocess exits. That is the whole point, and it is why cost-per-run and context-per-run are not the same measurement: the baseline's $0.0122 buys tokens that stay, and the explorer's $0.0176 buys tokens that leave.

### The second sweep — a question that spans subsystems

`bench/results/2026-09-11T05-44-05.json` — same corpus, same model, current defaults (`maxTurnsPerExplorer: 8`), 5 questions × 5 runs × 3 arms, 75 runs, 0 failures, 34 minutes, $2.79.

The fifth question exists because the first sweep could not answer the question that mattered most: every question in it was saturated by a single explorer, so fan-out had never been tested on the case it was designed for. `bash-approval` — *"when a shell command needs approval, how is that decided, how is the user asked, and how is an 'always allow' answer remembered?"* — was added because its answer lives in four separate top-level subsystems of `~/claude-plus-plus`, about 5,100 lines: generic rule evaluation, shell rule matching, the interactive ask, and the UI that presents it. Its four sub-questions were hand-written to be derivable from the parent question alone, with no knowledge of the corpus, so the fan-out arm got no advantage a real caller could not have had.

Per-question medians over 5 runs, all three arms scored the same way (by which ground-truth files the answer names — the baseline answers in prose and cites nothing in the explorer format, so citation-based scoring is not comparable across arms):

| arm | recall | precision | median latency | cost/run |
|---|---|---|---|---|
| baseline (no extension) | **1.00** | 0.50 | 26,075 ms † | **$0.0296** |
| explorer (one) | **1.00** | **0.625** | 32,916 ms † | $0.0373 |
| fanout (four) | **0.80** | 0.235 | 35,154 ms † | $0.0872 |

† Blocked arm order, baseline measured last. Do not derive a ratio from this column — see [Latency](#latency--the-corrected-measurement). Interleaved, this question is the extension's worst: paired mean delta **+22,115 ms**, explorer slower in 3 of 3 pairs.

**Fan-out lost its own best case.** It was the only arm that missed a ground-truth file in the median run, and it missed the *same* file — `src/hooks/toolPermission/handlers/interactiveHandler.ts`, the interactive ask — in **4 of 5 runs**, despite one of its four sub-questions being "how is the approval request presented to the user, and what choices are offered?". The single explorer missed a ground-truth file in 1 of 5 runs and never missed that one; the baseline missed one in 1 of 5. Partition blindness stops being a theoretical risk in the design document at this point and becomes a measured effect: each explorer covers its slice and stops, and what connects the slices is what goes missing.

**The extension won nothing on recall here.** One explorer tied the unaided baseline at 1.00 while costing 1.3x more and — remeasured with the arms interleaved — taking **2.0x longer** (`pairedLatency[bash-approval, explorer].ratio.median` = 1.967 in `2026-09-11T09-12-16.json`; this paragraph said 1.26x until 2026-09-11, from the blocked table above). It was better on precision (0.625 vs 0.50) and it still keeps the file contents out of the main context — but the reliability argument that carries this README elsewhere does not apply to this question. It also strained the turn budget: 3 of 5 explorer runs and 2 of 5 fan-out runs exceeded the advisory 8 turns, against 0 of 5 for the baseline.

**On the other four questions the first sweep replicated at the new defaults.** Fan-out cost 3.6x the single explorer ($0.0671 vs $0.0184 per run) for identical recall (median 1.00 both), with worse precision on every one of the five questions (per-question medians 0.08–0.25 against 0.17–0.63). The concurrency pool is again not the explanation: per-question speedup medians were 2.98–3.56x on four explorers, near the ceiling of 4.

**What this sweep does not establish.** One separable question, one corpus, one model, hand-written sub-questions, 5 runs. That is enough to say fan-out has no measured case in its favour and one measured case against it; it is not enough to say fan-out never helps. Treat it as the reason `questions` is no longer recommended, not as a proof that it is worthless. Note also that the single explorer's recall spread widened at these defaults — min 0.00 on two questions, against a median of 1.00 — so "recall 1.00" is a median, never a guarantee.

One number moved in the wrong direction and is recorded rather than buried: quote fabrication was **62 of 1,275 checkable quotes (4.9%)** in this sweep, against 2.9% in the first. Against the gate as it stood when this sweep ran — fail at any non-zero rate — it failed, and the artifact records that failure. The gate has since become a ratchet at 6% plus a check that every failure reaches the main agent marked; 4.9% is the rate that ratchet was set from, so it is a ceiling against further drift and not a pass mark.

### Caveats — read these before believing the table

- **Only the fifth sweep can support a latency comparison.** The first four ran the arms in per-question blocks with the baseline always last, so their cross-arm latency ratios are uninterpretable rather than merely noisy — the artifact says so itself in `comparability.note`. Everything else those sweeps measured (recall, precision, cost, citation quality, turn counts) stands. If you re-run the suite, check `executionOrder.interleaved === true` before comparing a latency number against anything published here.
- **One model, one corpus.** Everything above is `openai/gpt-5.6-luna` on `~/claude-plus-plus`. The citation contract is a prompt, and a different model may hold it better or worse; the latency penalty is per-turn cost, and per-turn cost is a property of that model against its own tool-calling speed. Run `BENCH_MODEL=... BENCH_REPO=... npm run bench` before assuming these numbers transfer.
- **One separable question, tested once.** Four of the five benchmark questions are saturated by a single explorer, which is why fan-out looks like pure waste on them. The fifth, `bash-approval`, was built to be the case fan-out exists for, and fan-out lost it — at 2.3x the cost, with recall 0.80 against 1.00. That is one question, on one corpus, with hand-written sub-questions: evidence against fan-out where there used to be none, not a closed case. See [the open question](#open-question-is-fan-out-ever-worth-it).
- **Comment-only quotes are verified more loosely than code quotes.** That is the 0.364% escape class above. A fidelity number therefore reads stronger for a report made mostly of prose than for one made of code. Tightening it would trade the escapes for false fabrication reports on legitimately re-wrapped comments, which is a worse failure for a detector whose whole value is being believed.
- **The first sweep was measured with `maxTurnsPerExplorer: 5`, which is no longer the default.** (The second sweep is at 8, and its numbers are the ones to compare against future runs.) 7 of the 40 explorer-arm runs exceeded that budget — all 7 by landing on exactly 6 turns — and that build folded the overrun into `ok`, so all 7 were scored as failures and carry `coverage: null`. Among them are all 5 fan-out runs on `persistence`, which is why the fan-out comparison rests on three questions rather than four. Those runs completed normally, so the latency and cost figures include them; it is the recall and precision sample sizes that shrank. Re-scoring their stored reports afterwards (`bench/results/2026-09-11T04-37-10-turncap-rescore.json`) gives **recall 1.00 on all 7** — the budget threw away seven correct answers, which is exactly why it is 8 now. The second sweep re-measured everything at 8 and scored 50 of 50 explorer-arm runs, so where the two sweeps disagree on quality, prefer the second; where they disagree on latency, neither is usable and the fifth is.
- **Non-determinism.** 5 runs per question per arm, reported as medians with spread. A single run of this suite is not a measurement.

### Open question: is fan-out ever worth it?

**Partially answered on 2026-09-11, and the answer is unfavourable.**

The question used to be unanswerable here: fan-out had measured evidence against it on saturated questions and no evidence either way on separable ones, because the corpus contained none. A separable question was then added — `bash-approval`, four subsystems, ~5,100 lines, sub-questions written to be derivable from the parent question alone — and fan-out lost that one too:

| | saturated questions (4) | separable question (1) |
|---|---|---|
| recall, one explorer | 1.00 | **1.00** |
| recall, four explorers | 1.00 | **0.80** |
| cost, four vs one | **3.6x** | **2.3x** |
| precision, four vs one | worse on all four | worse (0.235 vs 0.625) |

So fan-out has **no measured case in its favour and one measured case against it**, including on the case it was designed for. The guidance now says exactly that: the tool description, the `promptGuidelines` and the `questions` parameter description all state that decomposition has no measured benefit, with the numbers attached.

**The path is kept anyway**, and that is a judgement call rather than a conclusion from the data. One separable question, one corpus, one model and hand-written sub-questions is thin evidence for deleting code that is tested and working — and the same machinery is the substrate for the design that actually fits the data.

That design is **sequential escalation**: run one explorer, look at whether its `## Not Covered` section is non-trivial, and fan out only if it is. It pays one extra round-trip on the questions that need it, in place of the 2.3–3.6x multiplier currently paid up front on questions that do not — and the measurement says the round-trip is much the cheaper of the two. **It is not implemented, and nothing here should be read as a decision to implement it**; it is recorded as the direction a future version should take, for a human to decide on. The honest alternative to it is removing `questions` outright, which is also on the table.

## Known limitations

These were found while building it. They are trades, not bugs to be surprised by later.

1. **Partition blindness — now measured, not predicted.** Splitting the work cuts cross-file relationships. One explorer sees the caller, another sees the callee, and neither notices that they disagree. Directory-grouped bucketing keeps modules together and reduces this; no partition scheme eliminates it. The `## Architecture` and `## Not Covered` sections of each report are the mitigation, not a fix. On the one benchmark question whose answer spans four subsystems, four explorers missed the file holding the interactive approval prompt in 4 of 5 runs — one of the four had a sub-question aimed straight at it — while a single explorer on the whole question never missed it. This is the main reason `questions` is no longer recommended.

2. **`concurrency` is an extension-wide ceiling, not a per-call one.** Both entry paths draw on the same budget. This is deliberate — a model can issue ten greps in one message, and a per-call limit would let ten hooks each land `concurrency` explorers on the machine at once — but the consequence is that a batch of ten promotable greps serializes at four explorers at a time rather than running wide.

3. **Signals reach only the direct child.** Timeout and abort send `SIGTERM`/`SIGKILL` to the `pi` process that was spawned. If that process has spawned its own children, they are not signalled. `detached: true` plus `kill(-pid)` would cover them, but it changes stdio and signal semantics and has no Windows equivalent, so it was rejected; the grandchildren here are short-lived search processes that exit on their own.

4. **Quote verification is indentation-insensitive, and looser still on comments.** The verifier trims each line and skips blank ones before comparing a quoted block against the file on disk. Models reflow indentation when quoting, and counting that as a hallucination would make the detector cry wolf on correct citations. A wrong line number is not a failure either — the content is searched for across the whole file, and `synthesize` rewrites the anchor to where the code actually is before the main agent sees the report. Fabricated and misattributed content does fail, and is marked on the block rather than removed. The known soft spot is comment-only quotes: a mutation sweep of 49,985 injected edits leaked 0.364%, every one of them an all-comment quote where deleting a word still leaves a contiguous verbatim run. On quotes containing code, 43,777 mutations were injected and none escaped. (Those four figures are an **unreproducible measurement** — the sweep script was not kept and no artifact for it exists in this repository. See the note under [Citation quality](#citation-quality).) Trust a code excerpt's verification more than a prose one's.

5. **Spill files are never deleted.** Auto-promotion writes the raw search text to the per-user temp directory with mode `0600` and leaves it there, because the model may still want to read it at any later point in the session. The OS reaps the temp directory eventually, but a long session leaves a trail of `fx-matches-*.txt`.

6. **In headless mode, config warnings are invisible.** `ctx.ui.notify` is a no-op stub when there is no UI (`--mode json`, `-p`), so an invalid `fast-explorer.json` is ignored *silently* in exactly the contexts — scripts, CI — where nobody is watching the terminal anyway. The config still fails safe (previous values are kept); you just will not be told.

7. **Per-category cost fields are zero.** Only `cost.total` is available per explorer, so the aggregated usage reports a total but leaves the input/output/cache cost split at zero. Token counts are broken out correctly; cost breakdowns attribute all explorer spend to the total.

8. **Auto-promotion has run end to end exactly once per path, is not benchmarked, and the run was not recorded.** The seam is no longer untested: a real `openai/gpt-5.6-luna` session on pi's *default* toolbelt, in `~/claude-plus-plus`, chose `bash: rg -n --hidden --glob '!node_modules' 'tool_use_id' src/`, and the hook promoted it — 105 files, four explorers over `src/utils`, `src/hooks`, `src/tools/AgentTool` and `src/remote`, 311 raw match lines replaced by cited findings, $0.129 and 13.3k output tokens reported back into session totals. It also did not save context — the four reports came to 29,626 bytes against 26,401 bytes of raw match list, so on a sweep this wide the win is that the main agent gets analysed, cited findings instead of a match list, not that it gets fewer tokens.

    **Unreproducible measurement.** No session log, no benchmark artifact and no spill file for that run survives; every figure in the paragraph above exists only as this prose. The constants it rests on do check out against `src/detect.ts`, and the *behaviour* is covered by unit tests on both sides of the seam — but the run itself is not something you can open and check, and you should not treat it as though it were. Two things are unmeasured rather than unrecorded: nobody has scored a promoted result the way the benchmark scores `explore`, and the counterfactual that actually justifies the feature — that the main agent would otherwise have read those 105 files — has never been measured at all.

9. **Brief file lists are capped at 40 paths per explorer.** A `find` sweep can return up to 1000 paths, and pasting hundreds of them into a prompt recreates inside the subprocess exactly the context bloat this extension exists to remove. When the cap bites, the explorer is told how many paths were withheld, so it reports on a sample knowingly rather than mistaking its slice for the whole set.

10. **Only true match lines count toward the density threshold.** In `grep`'s context-lines mode (`context > 0`), matched lines are emitted as `path:12: text` and surrounding context as `path-11- text`. The parser reads the former and skips the latter, so promotion still fires normally on a context-mode result — but `minMatches` is measured against matches, not against the much larger number of printed lines. A context-heavy result is smaller, for threshold purposes, than it looks on screen.

11. **Explorers do not know what they do not know.** The main agent holds the whole conversation; an explorer gets one brief. It will miss adjacent-but-relevant code. Related: every explorer re-reads the shared `types.ts`, which wastes tokens and can produce inconsistent descriptions of the same entity across reports.

12. **Non-determinism.** Parallel LLM calls give different answers across runs. This makes behaviour harder to test and harder to trust than a mechanical index would be. It is visible in the benchmark: on the same question and arm, recall ranged 0.50–1.00 and latency 16.0s–17.7s across five runs, which is why every number here is a median over five and never a single run.

13. **`explore` without `questions` is not parallel, and that is now the recommendation rather than a shortfall.** There is no planner subagent, so a call that supplies only `question` runs exactly one explorer. Fan-out was measured costing 3.6x for identical recall on questions one explorer already covered, and 2.3x for *lower* recall on the one question that genuinely spanned subsystems, so the explicit tool path being single-threaded by default costs nothing that has been measured. It does mean the parallelism in this extension is reached almost entirely through auto-promotion, which always fans out because it partitions a known file list. See "[`questions`: measured, and not recommended](#questions-measured-and-not-recommended)" above.

14. **The turn budget is advisory.** pi exposes no turn-limit flag, so `maxTurnsPerExplorer` is a sentence in the task text, not a mechanism. Explorers exceed it — 7 of the 40 explorer-arm runs in the first sweep went over the then-default budget of 5 — and the only hard stops are `timeoutMs` and the model's own context limit. Do not treat it as a bound on cost or latency. (The denominator is 40 rather than 60 because only the explorer and fan-out arms are given a budget; the 20 baseline runs are the control and cannot exceed one. Six baseline runs did take more than 5 turns, which is not an overrun.) A second effect pushes the other way: pi retries a failed turn up to 3 times by default and the failed turn has already been reported as complete, so the turn counts this extension reports **over-count** retried turns. The overrun counts are therefore an upper bound on real model turns.

15. **On Windows, shell searches are promoted — unless you have opted into the `powershell` tool.** *(Corrects an earlier version of this list, which said pi swaps `bash` for `powershell` on Windows and that shell searches are therefore never promoted there. That was wrong.)* pi uses **Git Bash by default** on Windows — `docs/windows.md:3-7` lists the lookup order as a custom `shellPath`, then `C:\Program Files\Git\bin\bash.exe`, then `bash.exe` on `PATH`. The `powershell` tool is **optional**: `docs/windows.md:11-27` describes it as a thing you turn on by naming it in `defaultTools`, either replacing `bash` or alongside it. So on a default Windows install the tool is still called `bash`, `isBashToolResult` still fires, and shell searches promote exactly as they do on macOS and Linux.

    The real gap is narrower: **if you have put `powershell` in `defaultTools`, results from that tool are not promoted.** If you replaced `bash` with it, that is all shell promotion; if you enabled both, it is the searches the model happens to route through PowerShell. pi already exports `isPowerShellToolResult`, so wiring it into `sweepKind` is a small change — it is not done because `Select-String`'s output shape has never been checked against the parser on a real Windows box, and a trigger nobody has run is worse than an admitted gap. `grep` and `find` promote normally on every platform.

    **Unverified, and larger than either:** explorers are spawned as `spawn("pi", …, { shell: false })`, and npm installs pi on Windows as a `pi.cmd` shim rather than a `.exe` (`"bin": { "pi": "dist/bundle/cli.js" }`). If Node will not launch that shim without a shell, the extension does not work on Windows at all and the rest of this item is moot. Nobody has run it on Windows. This needs one session on a real Windows box and nothing else.

16. **It does not make the main agent faster, and the cost is larger than this README used to say.** Measured with the arms interleaved, one explorer costs **+9,015 ms per sweep** on the paired mean and loses **14 of 15** paired runs; four explorers cost +9,428 ms and lose 14 of 15. The baseline was ahead at the median on all five questions, and on the worst of them (`bash-approval`) by +22,115 ms. The mechanism is per-turn: 5,045 ms/turn against the baseline's 3,744, at roughly equal turn counts.

    The figures this item carried until 2026-09-11 — 1.16x and 1.36x from the first sweep, 1.08x from the second — are **withdrawn, not merely superseded**. They came from a harness that ran the arms in per-question blocks with the baseline always last, which left execution order free to explain the ratio. Every one of them understated the penalty. See [Latency](#latency--the-corrected-measurement) and [the amendment](#amendment-2026-09-11--the-latency-numbers-were-measuring-execution-order).

    The design once treated speed as a hard requirement; it was tested and it failed, and the goal has been retired rather than restated more weakly. The win is context, recall and verifiable citations, and it is bought with latency and cost. See [What it trades](#what-it-trades).

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest (419 tests)
npm run typecheck:tests
npm run bench        # real model calls — see Benchmark, not part of npm test
```

## License

MIT
