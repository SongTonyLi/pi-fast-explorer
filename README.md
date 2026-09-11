# pi-fast-explorer

An extension for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that moves broad code-reading off the main agent's context and onto parallel read-only subagents.

## The problem

When a pi agent needs to understand code spanning many files, it reads them one at a time into its own context. A 40-file sweep can cost 300k tokens, and every one of those tokens is then dragged through every later turn of the session until compaction throws them away. The cost is not only the tokens: a context full of half-relevant file contents is also a context the model has to reason around.

pi's per-call truncation (50 KB / 2000 lines) bounds a single result but has no notion of how many results accumulate, and auto-compaction fires only near the end of the window, by which point the sweep has been paid for many times over.

fast-explorer fans that reading out to explorer subagents. Each explorer is a separate `pi` process with its own context window, restricted to `read`, `grep`, `find` and `ls`. The main agent gets back cited findings — `file:line`, plus verbatim excerpts of the code that matters — instead of the file contents.

Two entry paths:

- **The `explore` tool** — the model calls it when it knows a sweep is coming.
- **Auto-promotion** — a `tool_result` hook intercepts `grep`/`find` results that span many files and converts them into parallel exploration without being asked. This path matters more in practice, because the common failure is the model *not* knowing a sweep was coming.

## What it trades

It is **slower and costlier per sweep** than letting the main agent read the files itself. That is measured, not estimated — see [Benchmark](#benchmark) for the run, the numbers and the caveats. The short version:

> Slightly slower per sweep (1.16x: 16,276 ms vs 13,983 ms median) and somewhat costlier ($0.0176 vs $0.0122 per run), in exchange for 20–36x less context consumed, recall 1.00 instead of a baseline median of 0.50–1.00, and citations that are mechanically verified before they reach you.

The trade has a losing side and it is worth naming: the unaided baseline was faster on every question in every configuration, it was cheaper, and its *precision* was better on all four questions (0.29–1.00 vs 0.25–0.67) because an explorer cites more files than it strictly needs to. An earlier version of this design named "make the main agent faster, measurably" as a hard requirement with an acceptance test. It was tested and it failed. The goal has been retired and the failure is recorded in [the design spec](docs/superpowers/specs/2026-09-10-fast-explorer-design.md) rather than quietly dropped.

**Why the context number is the one to weigh.** The latency and the cost are paid once, at the moment of the sweep. The tokens are paid on every turn after it. A baseline sweep put a median of 24k–49k tokens of file contents into the main agent's context, and those tokens are re-sent with every subsequent request until compaction throws them away — and the compaction itself is a multi-second synchronous stall you have also brought forward. An explorer report is 1.1k–1.4k tokens, and that is all the main agent ever carries: the explorer's own reading happens in a separate process whose context is discarded when it exits. Two arms whose per-sweep costs are within 1.5x of each other therefore leave the session in very different states.

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
  questions?: string[],  // pre-decomposed sub-questions, one per explorer
  scope?: string,        // glob or directory to limit the search
  fanout?: number,       // lower the number of explorers for this call
})
```

### `questions`: when to fan out, and what it costs

Each entry in `questions` becomes one explorer's brief, and those explorers run concurrently. **Omit `questions` and you get exactly one explorer**, working on `question` alone — there is no planner subagent that decomposes the question for you. The original design had one; it is not in the code, and nothing substitutes for it.

One explorer is the right default. Measured against a real repository (`openai/gpt-5.6-luna`, 20 runs per arm), fanning a single question out to four explorers cost **3.6x** as much ($0.0629 vs $0.0176 per run) for **identical recall** (median 1.00 either way, on every question both arms scored) and consistently *worse* precision (per-question medians 0.12–0.29 vs 0.25–0.67) — four explorers cite more files and dilute the ones that matter. It was slower, too: 19,051 ms vs 16,276 ms median, because wall-clock is set by the slowest explorer, not the sum. The concurrency pool was not at fault; it measured 3.0–3.3x against sequential execution, near its ceiling of 4. Those questions were simply saturated by one explorer, leaving the other three nothing left to find.

So decompose when the question genuinely spans **separable areas of the codebase** — distinct subsystems, or facets that have to be looked for in different places — and not merely because the question can be phrased as several questions.

That guidance is the honest reading of the evidence, but note what the evidence does *not* contain: every benchmark question turned out to be answerable by a single explorer, so there is measured evidence that fan-out is wasteful on a saturated question and **no** evidence either way about a genuinely separable one. See [Open question: is fan-out ever worth it?](#open-question-is-fan-out-ever-worth-it).

```ts
// one explorer: one subsystem, one place to look
explore({ question: "How does the tokenizer handle trailing commas?" })

// three explorers: three parts of the tree, none of which covers the others
explore({
  question: "How does session auth work?",
  questions: [
    "Where are session tokens minted and what is in them?",
    "How and where are tokens validated on each request?",
    "What is the refresh and expiry path?",
  ],
})
```

Supplying `questions` also removes a round-trip: the main agent is already reasoning when it decides to explore, so it can decompose in the turn it already occupies instead of blocking on a separate planning call. That saving is real, but it is a saving on a split you had reason to make — it is not a reason to split a question one explorer already covers. The tool's `promptGuidelines` carry the same rule and the same cost figure; a model can always ignore guidance, so if you are calling `explore` yourself, apply the test above deliberately.

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
  "maxTurnsPerExplorer": 8,
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
| `maxTurnsPerExplorer` | Turn budget written into each explorer's task text, phrased as a target to come in under. pi has no turn-limit flag, so this is **advisory** — an explorer can and sometimes does exceed it, and nothing here prevents that. It was 5; 5 was measured failing runs that had already succeeded (7 of 60 runs over budget, 5 of them at exactly 6 turns with full recall), so it is 8. The pressure to finish fast lives in `prompts/explorer.md`, which asks for about 3 turns. |
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

Turn budget: about <maxTurnsPerExplorer> turns. Aim to come in well under it — but a
complete report matters more than the budget, so take an extra turn if the brief
genuinely needs one."
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

### The run these numbers come from

`bench/results/2026-09-11T04-37-10.json` — corpus `~/claude-plus-plus`, model `openai/gpt-5.6-luna`, 4 questions × 5 runs × 3 arms, 60 runs. The arms:

| arm | what it is |
|---|---|
| `baseline` | plain pi with no extension, told to investigate the codebase directly. The control. |
| `explorer` | one explorer on the undecomposed question — what `explore({ question })` does. |
| `fanout` | four explorers on hand-written sub-questions, run concurrently. |

#### Latency and cost

| arm | median latency | vs baseline | cost/run |
|---|---|---|---|
| baseline | 13,983 ms | — | $0.0122 |
| explorer | 16,276 ms | **1.16x slower** | $0.0176 |
| fanout | 19,051 ms | **1.36x slower** | $0.0629 |

The baseline was faster on every one of the four questions, in both explorer configurations. There is no arrangement of this extension that is faster than not running it, and the design originally claimed there would be — see the spec.

The concurrency pool is not the reason. Fan-out measured 3.0–3.3x against sequential execution of the same four explorers, near its ceiling of 4. The cost is per-explorer fixed overhead (process spawn, system prompt, tool definitions, `AGENTS.md`) plus the fact that an explorer's wall-clock is turns × per-turn latency, and parallelism does not reduce the turns inside any one explorer.

#### Context — the claim that held

Median tokens entering the **main** agent's context, per question:

| question | baseline | explorer report | reduction | fan-out report | reduction |
|---|---|---|---|---|---|
| microcompact | 23,896 | 1,100 | 21.7x | 3,858 | 6.2x |
| persistence | 39,688 | 1,382 | 28.7x | 3,400 | 11.7x |
| cache-safety | 27,241 | 1,344 | 20.3x | 3,874 | 7.0x |
| tracking | 48,956 | 1,371 | 35.7x | 4,351 | 11.3x |

Tokens are estimated as chars/4, validated to within ~5% of the API-reported prompt size.

The explorers' own token spend does not appear in this table because it does not enter the main context — it is spent in a subprocess and discarded when that subprocess exits. That is the whole point, and it is why cost-per-run and context-per-run are not the same measurement: the baseline's $0.0122 buys tokens that stay, and the explorer's $0.0176 buys tokens that leave.

#### Recall and precision

Per-question medians, against a ground-truth file set established by exhaustive search rather than by running this extension:

| question | recall (baseline) | recall (explorer) | precision (baseline) | precision (explorer) |
|---|---|---|---|---|
| microcompact | 0.50 | 1.00 | 1.00 | 0.67 |
| persistence | 1.00 | 1.00 | 0.33 | 0.25 |
| cache-safety | 1.00 | 1.00 | 0.29 | 0.25 |
| tracking | 1.00 | 1.00 | 0.33 | 0.29 |

The explorer's recall median was 1.00 on all four. The baseline's swung run to run — 0.00 to 0.50 on microcompact, 0.00 to 1.00 on cache-safety, 0.50 to 1.00 on tracking. Recall is the metric that decides whether the answer you get is built on the right files, and it is where the explorer is reliably better.

Precision goes the other way, on all four questions: an explorer cites more files than the baseline does, including ones that are not in the ground-truth set. That is the cost of asking a subagent to over-report rather than under-report, and it means you will read some citations that turn out not to matter.

#### Citation quality

Across the 33 reports that scored (of 40 `explorer` and `fanout` runs — the `baseline` was never shown the output contract, so it is not judged against it), 520 quote blocks:

| | |
|---|---|
| Contract compliance | every scored report parsed into citations and quotes — **0 violations** |
| Exact anchors, as the model wrote them | 386/520 (74%) |
| Anchor drift — real code, wrong line number | 119/520 (23%), corrected automatically at runtime |
| Content the cited file does not contain | 15/520 (**2.9%**) |
| Exactness of what the main agent actually receives | median **1.00** per report (min 0.67) |

Drift is corrected rather than gated: `synthesize` runs every report through `reanchorReport` before the main agent sees it, so a verbatim quote with a wrong line number arrives with the right one. What cannot be repaired is marked in place on the fence header — `UNVERIFIED`, `PARTIAL`, `MISATTRIBUTED`, `UNCHECKED` — rather than silently dropped or silently kept.

**The fabrication gate is defined to fail at any non-zero rate, and on this run it failed**, at 2.9%. That is the honest state of the suite: roughly one quote block in 35 claims content the cited file does not hold. The runtime marker means such a block reaches you labelled, but the label depends on the verifier catching it.

The verifier itself was validated by injecting 49,985 mutations into known-good quotes: 182 escaped (0.364%), and **every** escape fell in one class — all-comment quotes where deleting a word still leaves a contiguous verbatim run, which the `reflowed` verdict is defined to accept. Restricted to quotes containing code, 43,777 mutations were injected and none escaped.

### Caveats — read these before believing the table

- **One model, one corpus.** Everything above is `openai/gpt-5.6-luna` on `~/claude-plus-plus`. The citation contract is a prompt, and a different model may hold it better or worse; the latency ratio depends on that model's per-turn latency against its own tool-calling speed. Run `BENCH_MODEL=... BENCH_REPO=... npm run bench` before assuming these numbers transfer.
- **Every benchmark question was saturated by one explorer.** That is why fan-out looks like pure waste here. It means the data shows fan-out is wasteful *on questions one explorer already covers*, and says **nothing** about genuinely separable ones — the corpus never produced one. Do not read the fan-out row as "fan-out is always waste"; read it as "fan-out was never tested on the case it was designed for". See [the open question](#open-question-is-fan-out-ever-worth-it).
- **Comment-only quotes are verified more loosely than code quotes.** That is the 0.364% escape class above. A fidelity number therefore reads stronger for a report made mostly of prose than for one made of code. Tightening it would trade the escapes for false fabrication reports on legitimately re-wrapped comments, which is a worse failure for a detector whose whole value is being believed.
- **Measured with `maxTurnsPerExplorer: 5`, which is no longer the default.** 7 of the 40 explorer-arm runs exceeded that budget and were scored as failures — among them all 5 fan-out runs on `persistence`, which is why the fan-out comparison rests on three questions rather than four. Those runs completed normally, so the latency and cost figures include them; it is the recall and precision sample sizes that shrank. The budget is 8 now precisely because of this, and the numbers have not been re-measured at 8.
- **Non-determinism.** 5 runs per question per arm, reported as medians with spread. A single run of this suite is not a measurement.

### Open question: is fan-out ever worth it?

The fan-out path has measured evidence that it is wasteful on a saturated question — 3.6x the cost, worse precision, identical recall — and no evidence that it is ever useful, because no question in the corpus turned out to be genuinely separable. Absence of evidence in one direction is not evidence in the other, so the path stays and the guidance is conditioned on breadth rather than the path being removed.

The alternative that fits the data is **sequential escalation**: run one explorer, look at whether its `## Not Covered` section is non-trivial, and fan out only if it is. That trades one round-trip — paid only on the questions that need it — for the 3.6x multiplier currently paid up front on questions that do not. It is not implemented, and it needs a separable benchmark question to be evaluated against, which is the missing piece rather than the code.

## Known limitations

These were found while building it. They are trades, not bugs to be surprised by later.

1. **Partition blindness.** Splitting the work by file cuts cross-file relationships. One explorer sees the caller, another sees the callee, and neither notices that they disagree. Directory-grouped bucketing keeps modules together and reduces this; no partition scheme eliminates it. The `## Architecture` and `## Not Covered` sections of each report are the mitigation, not a fix.

2. **`concurrency` is an extension-wide ceiling, not a per-call one.** Both entry paths draw on the same budget. This is deliberate — a model can issue ten greps in one message, and a per-call limit would let ten hooks each land `concurrency` explorers on the machine at once — but the consequence is that a batch of ten promotable greps serializes at four explorers at a time rather than running wide.

3. **Signals reach only the direct child.** Timeout and abort send `SIGTERM`/`SIGKILL` to the `pi` process that was spawned. If that process has spawned its own children, they are not signalled. `detached: true` plus `kill(-pid)` would cover them, but it changes stdio and signal semantics and has no Windows equivalent, so it was rejected; the grandchildren here are short-lived search processes that exit on their own.

4. **Quote verification is indentation-insensitive, and looser still on comments.** The verifier trims each line and skips blank ones before comparing a quoted block against the file on disk. Models reflow indentation when quoting, and counting that as a hallucination would make the detector cry wolf on correct citations. A wrong line number is not a failure either — the content is searched for across the whole file, and `synthesize` rewrites the anchor to where the code actually is before the main agent sees the report. Fabricated and misattributed content does fail, and is marked on the block rather than removed. The known soft spot is comment-only quotes: a mutation sweep of 49,985 injected edits leaked 0.364%, every one of them an all-comment quote where deleting a word still leaves a contiguous verbatim run. On quotes containing code, 43,777 mutations were injected and none escaped. Trust a code excerpt's verification more than a prose one's.

5. **Spill files are never deleted.** Auto-promotion writes the raw grep/find text to the per-user temp directory with mode `0600` and leaves it there, because the model may still want to read it at any later point in the session. The OS reaps the temp directory eventually, but a long session leaves a trail of `fx-matches-*.txt`.

6. **In headless mode, config warnings are invisible.** `ctx.ui.notify` is a no-op stub when there is no UI (`--mode json`, `-p`), so an invalid `fast-explorer.json` is ignored *silently* in exactly the contexts — scripts, CI — where nobody is watching the terminal anyway. The config still fails safe (previous values are kept); you just will not be told.

7. **Per-category cost fields are zero.** Only `cost.total` is available per explorer, so the aggregated usage reports a total but leaves the input/output/cache cost split at zero. Token counts are broken out correctly; cost breakdowns attribute all explorer spend to the total.

8. **Auto-promotion has never run against a real model.** Explorers themselves have now been exercised heavily — the benchmark has put 40 real exploration runs against `openai/gpt-5.6-luna` through spawn, streaming, the citation contract, re-anchoring and synthesis. What that did *not* cover is the `tool_result` hook path: no real `grep` has ever tripped the promotion gates, had its matches bucketed, spawned explorers and had its result replaced. Every gate and helper on that path is unit-tested (239 tests, including a stub subprocess emitting recorded pi JSON events, and a test that keeps `prompts/explorer.md` in sync with the citation parsers), and the pieces downstream of it are benchmarked, but the seam between them is untested end to end. The `explore` tool has the evidence; auto-promotion has the unit tests.

9. **Brief file lists are capped at 40 paths per explorer.** A `find` sweep can return up to 1000 paths, and pasting hundreds of them into a prompt recreates inside the subprocess exactly the context bloat this extension exists to remove. When the cap bites, the explorer is told how many paths were withheld, so it reports on a sample knowingly rather than mistaking its slice for the whole set.

10. **Only true match lines count toward the density threshold.** In `grep`'s context-lines mode (`context > 0`), matched lines are emitted as `path:12: text` and surrounding context as `path-11- text`. The parser reads the former and skips the latter, so promotion still fires normally on a context-mode result — but `minMatches` is measured against matches, not against the much larger number of printed lines. A context-heavy result is smaller, for threshold purposes, than it looks on screen.

11. **Explorers do not know what they do not know.** The main agent holds the whole conversation; an explorer gets one brief. It will miss adjacent-but-relevant code. Related: every explorer re-reads the shared `types.ts`, which wastes tokens and can produce inconsistent descriptions of the same entity across reports.

12. **Non-determinism.** Parallel LLM calls give different answers across runs. This makes behaviour harder to test and harder to trust than a mechanical index would be. It is visible in the benchmark: on the same question and arm, recall ranged 0.50–1.00 and latency 16.0s–17.7s across five runs, which is why every number here is a median over five and never a single run.

13. **`explore` without `questions` is not parallel.** There is no planner subagent, so a call that supplies only `question` runs exactly one explorer. That is the recommended default — fan-out was measured costing 3.6x for identical recall on questions one explorer already covered — but it does mean the explicit tool path fans out only as wide as the caller decomposed, while auto-promotion always fans out because it partitions a known file list. See "`questions`: when to fan out, and what it costs" above.

14. **The turn budget is advisory.** pi exposes no turn-limit flag, so `maxTurnsPerExplorer` is a sentence in the task text, not a mechanism. Explorers exceed it — 7 of 40 benchmark runs went over the then-default budget of 5 — and the only hard stops are `timeoutMs` and the model's own context limit. Do not treat it as a bound on cost or latency.

15. **It does not make the main agent faster.** Every configuration measured was slower than plain pi: 1.16x for one explorer, 1.36x for four, with the baseline ahead on all four questions. The design once treated speed as a hard requirement; it was tested and it failed, and the goal has been retired rather than restated more weakly. The win is context, recall and verifiable citations, and it is bought with latency and cost. See [What it trades](#what-it-trades).

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest (239 tests)
npm run typecheck:tests
npm run bench        # real model calls — see Benchmark, not part of npm test
```

## License

MIT
