# fast-explorer — Design

**Date:** 2026-09-10
**Status:** Implemented; amended 2026-09-11 against benchmark results
**Package:** `pi-fast-explorer`

Amendments are marked in place and dated rather than folded in silently, so a reader
can tell which parts of this document were designed and which were measured. Five are
large enough to name here, and the first two went against the design:

- The speed goal was falsified — see "Retired goal: speed (2026-09-11)".
- **The benchmark was measuring its own execution order, and every latency ratio this
  document published was too kind.** The arms ran in per-question blocks with the
  baseline always last. Interleaved, the explorer costs **+9.0 s per sweep** on the
  paired mean and loses **14 of 15** paired runs, against +6.4 s and 11 of 15 at the
  same config blocked. The retirement of the speed goal is unaffected; its numbers are
  replaced. See "Amendment (2026-09-11): the latency figures were measuring execution
  order".
- The parallelism argument lost on the one question built to test it. Fan-out is no
  longer recommended anywhere in the shipped text — see "Open question: is fan-out
  ever worth it?".
- **Two components in the architecture block were never built** — `planner.ts` and the
  `/explore` slash command. The planner's absence was recorded under "Implementation
  notes" but never in the block itself; the slash command's was recorded nowhere. See
  "Amendment (2026-09-11): two components in this block were never built".
- **Some figures in this document cannot be checked.** As of 2026-09-11 `bench/results/`
  is committed, so every benchmark number here resolves to a file. Three sets of figures
  do not, and are now labelled where they appear: the 49,985-mutation verifier sweep, the
  one end-to-end auto-promotion run, and the fork-bomb branching factor. They were real
  measurements; the artifacts were not kept.

## Problem

When a pi agent needs to understand code spanning many files, it reads them one at
a time into its own context. A sweep across 40 files can cost on the order of 300k
tokens — an illustrative figure with no measurement behind it — and every one of those
tokens is then dragged through every subsequent turn of the session until compaction
throws them away. What was later measured is smaller and points the same way: a single
baseline sweep on the benchmark's questions left 14,860–56,420 tokens in the main
context.

The cost is not only tokens. Sequential reads are slow, and a context full of
half-relevant file contents measurably degrades the model's reasoning on the task
that motivated the sweep in the first place.

pi has no mechanism that targets this. Its per-call truncation (50KB / 2000 lines)
bounds a single result but has no notion of how many results accumulate. Its
auto-compaction fires only at `contextWindow - reserveTokens`, by which point the
sweep has already been paid for many times over.

## Goals

- Convert broad code-scanning work into parallel subagent exploration, so the main
  agent receives findings instead of raw file contents.
- Fire both when the model anticipates a sweep and when it does not.
- Never destroy information — every finding carries a `file:line` citation, and raw
  data remains reachable on disk.
- Require no change to how the user works.
- **Reduce what the main agent carries, measurably** — the tokens a sweep leaves in
  context, not the time the sweep takes. This is a hard requirement with an
  acceptance test. See "Performance and context".

**Amended 2026-09-11.** The last bullet read "**Make the main agent faster,
measurably** — both on the exploration turn itself and on every turn after it. This
is a hard requirement with an acceptance test, not an expected side effect." It was
measured and it is false. The goal has been removed rather than weakened, and
replaced by the one it was always supposed to be serving: the context reduction,
which is the part that held. See "Retired goal: speed (2026-09-11)".

## Non-goals

- Replacing pi's auto-compaction. This reduces pressure on it; it does not remove
  the need for it.
- Orchestrating edits or any mutating work. Explorers are read-only by construction.
- Handling large tool output generally (e.g. build logs, test output). That is a
  different problem with different tradeoffs; see "Relationship to other designs".

## Background: what pi already provides

- **Subagents as subprocesses.** `pi --mode json -p --no-session --model <m>
  --tools <a,b,c> --append-system-prompt <file> "Task: ..."` spawns an isolated
  agent with its own context window. Reference implementation:
  `examples/extensions/subagent/index.ts:300`.
- **The `scout` agent** (`examples/extensions/subagent/agents/scout.md`) is
  single-threaded, manually-invoked exploration with an output contract that already
  demands exact line ranges. fast-explorer is scout plus automatic triggering,
  parallel partitioning, and synthesis.
- **Model inheritance.** When an agent definition omits `model`, the subagent
  inherits the dispatching session's active model and thinking level.
- **`tool_result` hook** — middleware-style, can rewrite result content, and
  supports async work via `ctx.signal`.
- **ripgrep-backed `grep` tool**, so explorers do not need shell access to search
  efficiently.

## Design

### Trigger

Two paths, both shipped in v1.

**Path A — explicit `explore` tool.** The model calls it when it knows a sweep is
coming.

```ts
explore({
  question: string,     // what to find out
  questions?: string[], // optional pre-decomposed sub-questions, one per explorer
  scope?: string,       // optional glob or directory to limit the search
  fanout?: number,      // override the computed fan-out
})
```

`questions` exists to avoid a blocking planner round-trip. The main agent is already
reasoning when it decides to explore, so it can decompose the problem **in the same
turn**. The planner is the fallback, not the default.

**Amended 2026-09-11 (first sweep).** This section said `promptGuidelines` "instructs
the model to supply `questions` whenever it can". That advice was measured wrong: on a
question a single explorer already covers, four explorers cost 3.6x for identical
recall and worse precision. The guidelines then conditioned decomposition on the
question spanning separable areas of the codebase, and omitting `questions` — one
explorer — became the documented default. Removing a round-trip is a saving on a split
you had a reason to make; it is not a reason to make the split.

**Amended again 2026-09-11 (second sweep).** The replacement advice was itself measured,
on exactly the case it named, and it lost. `bash-approval` — an answer spanning four
subsystems and ~5,100 lines — cost 2.3x with four explorers and returned *lower* recall
than one (0.80 against 1.00). The guidelines no longer condition decomposition on
anything: they state that decomposition has no measured benefit and give the numbers.
The path is kept, unrecommended. See "Open question: is fan-out ever worth it?".

`promptGuidelines` must name the tool explicitly — "Use explore when you need to
understand code spanning more than ~5 files" — because pi appends guideline bullets
flat into the system prompt with no tool-name grouping.

**Path B — grep/find auto-promotion.** Hooks `tool_result`. When a `grep` or `find`
result exceeds a threshold, the match list is not returned to the main agent.
Instead the matched files are explored in parallel and the findings are returned.

This path matters more than Path A in practice, because the common failure is the
model *not knowing* the sweep was coming.

Threshold: more than 15 distinct files, or more than 60 total matches.

### Partitioning

Shape-dependent — the input determines the split.

| Input shape | Strategy | Rationale |
|---|---|---|
| File list (Path B) | Bucket by directory | Preserves module locality; no planner call needed |
| Question (Path A) | Decompose into sub-questions | The right split is conceptual, not spatial |

Path A uses `questions` when the caller supplied them. Only when it did not, and the
question cannot be split heuristically by `scope` or directory structure, does it
fall back to a planner call producing `[{ brief, globs }]`.

**Amended 2026-09-11.** The Path A row of that table is the design's weakest claim.
"The right split is conceptual" was never measured to produce a better answer, and
where it has now been measured it produced a worse one — the conceptual split lost
the file that sits between two of its concepts. Path B's row survived measurement;
Path A's did not. No planner shipped, which in hindsight avoided building machinery
for a split that does not pay. See "Open question: is fan-out ever worth it?".

Fan-out is determined per path:

- **Path A** — one explorer per sub-question, bounded by `maxFanout`. An explicit
  `fanout` argument can lower that number for a single call, but is clamped into
  `[1, maxFanout]` and so can never widen past the configured ceiling.
- **Path B** — `clamp(ceil(files / 8), 2, maxFanout)`, since the file count is known
  before any model call.

**`maxFanout` must never exceed `concurrency`.** Fanning out 6 explorers against a
concurrency limit of 4 produces two waves and doubles wall-clock for no benefit.
Both default to 4, and config validation rejects `maxFanout > concurrency`.

Over-fanning a small job is pure loss, since each explorer pays a fixed spawn,
system-prompt, tool definition, and `AGENTS.md` cost. That is what the lower bound
of 2 and the `minFiles` auto-promote threshold exist to prevent.

Concurrency is capped at 4, matching the limit pi's own subagent example uses.

### Explorer contract

**Every finding carries `file:line`. Key code is reproduced verbatim, never
paraphrased.**

This is the design's load-bearing decision. It converts the output from *lossy
compression*, where information is gone, into *an index with pointers*, where
information is one `read` away. The main agent can always verify or drill in.

Required output sections:

```
## Files Retrieved
1. src/auth/session.ts (lines 40-96) — token refresh, the 3600s window
2. src/auth/clock.ts (lines 12-28) — skew correction

## Key Code
(verbatim excerpts with file:line headers)

## Architecture
(how the pieces connect)

## Not Covered
(what this explorer did not examine)
```

`## Not Covered` extends beyond what `scout.md` requires. It makes blind spots
explicit rather than silent, which matters because a missed file is otherwise
invisible to the main agent.

### Explorer invocation

```
pi --mode json -p --no-session \
   --model <inherited or configured> \
   --thinking off \
   --tools read,grep,find,ls \
   --append-system-prompt prompts/explorer.md \
   "Task: <brief>"
```

**Thinking is off by default, even though the model is inherited.** Retrieval is not
reasoning. Extended thinking is a large per-turn latency cost that buys very little
on "find the relevant code and cite it" — whereas the *model* choice is what governs
relevance judgment, which is why that is inherited. Separating the two knobs keeps
the quality of an inherited model at roughly the speed of a small one. This is the
single largest latency lever in the design.

**`bash` is deliberately excluded.** Limiting explorers to `read, grep, find, ls`
gives a structural read-only guarantee — an explorer cannot mutate the repository or
run arbitrary commands, regardless of what its prompt or the briefing says. The
capability cost is low because pi's `grep` is already ripgrep-backed.

**Model defaults to the main agent's.** Explorers inherit the dispatching session's
model and thinking level unless configured otherwise. This preserves relevance
judgment: a weaker model deciding what matters in unfamiliar code is the single
largest quality risk in this architecture, and inheritance removes it. The
consequence is that the cost saving largely disappears — the remaining wins are
context, recall and verifiable citations. (This sentence read "context, latency, and
cache preservation" until 2026-09-11; latency is a cost here, not a win, and cache
preservation was never measured.) Users who want the cost saving can set
`model` explicitly to a cheaper one.

### Synthesis

v1 concatenates reports with mechanical dedup on file paths. A synthesizer subagent
that reconciles contradictions is deferred until reports prove noisy in practice —
it is an additive change that does not affect the v1 architecture.

### Failure handling

- An explorer that fails or times out is **never silently dropped**. Its bucket is
  named in the synthesized report's `## Not Covered` section so the main agent knows
  exactly which part of the tree is unverified.
- Abort propagates: child PIDs are tracked and killed when `ctx.signal` fires, so
  Ctrl+C does not leave orphaned subprocesses.
- Path B spills the raw match list to a file and includes the path in its output.
  Auto-promotion never destroys the data it replaces.

### Configuration

Keys live at the top level of the config file. There is no `fastExplorer` wrapper
key: the loader rejects unknown top-level keys, so a wrapped file would be discarded
in its entirety.

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

`model: null` means inherit from the dispatching session. `minTotalBytes` is the
bail-out floor described under "Performance and context".

`maxTurnsPerExplorer` was 5 here until 2026-09-11. It is 8 because 5 was measured
converting successes into failures — 7 of 40 benchmark explorer runs exceeded it,
every one of them by landing on exactly 6 turns. It is also **advisory in a way this
spec did not anticipate**: pi exposes no turn-limit flag, so the number rides in the
task text as a request the model is free to exceed. Nothing in this design bounds
turn count; the only hard stops are `timeoutMs` and the model's own context limit.

Source, added 2026-09-11: `bench/results/2026-09-11T04-37-10.json`, the 7 records with
`turnCapExceeded: true` — `persistence`/explorer run 4, `persistence`/fanout runs 1–5,
`cache-safety`/fanout run 1, each with `turns: 6`. The denominator is the 40
explorer-arm runs; the 20 baseline runs have no budget and cannot overrun one, and six
of them did exceed 5 turns without that meaning anything. That build folded the overrun
into `ok`, so `coverage` is `null` for all 7 and this spec could not say how good they
were. Re-scoring their stored reports gives **recall 1.00 on all 7**
(`bench/results/2026-09-11T04-37-10-turncap-rescore.json`), so the budget was discarding
seven answers that were entirely correct. The claim above was, if anything, too weak.

One qualification in the other direction: pi retries a failed turn up to 3 times by
default and the failed attempt has already been emitted with its own usage, which
`processLine` counts, so reported turn counts over-count retries. The overrun figures
are an upper bound on real model turns.

**Loading.** Config is resolved at every `session_start` from layers, lowest
precedence first:

1. the defaults above;
2. `~/.pi/agent/fast-explorer.json` (user level), always read;
3. `<project>/.pi/fast-explorer.json` (project level), **read only when the project
   is trusted**.

Project overrides user, and both override the defaults; `autoPromote` merges key by
key rather than replacing wholesale. The project file is trust-gated because it
lives inside the repository and is therefore attacker-supplied content in an
untrusted clone: `model` would redirect exploration to a model of the repository's
choosing and `timeoutMs` could stall the session, neither with any prompt to the
user. An invalid file is reported and ignored — the previously resolved config stays
in effect, rather than being silently replaced by the defaults.

## Performance and context

Reducing what the main agent carries is the requirement. Latency is a cost to be
kept small, not a benefit to be claimed — see "Retired goal: speed (2026-09-11)",
which is where this section used to argue otherwise.

### Where the time actually goes

The baseline is faster than it first appears: pi executes sibling tool calls
concurrently by default (`docs/extensions.md:784`), so an unaided main agent can
already issue eight reads in a single turn. fast-explorer is not competing against
sequential file reads — it is competing against a handful of wide, parallel turns.

The governing relationship is:

```
explorer wall-clock ≈ (turns per explorer) × (per-turn latency)
```

Fan-out width barely appears in it. **Parallelism across explorers does not reduce
the number of sequential LLM turns inside any one explorer.** Keeping the latency
cost small therefore means minimising turns per explorer and per-turn latency, not
widening the fan-out. Every lever below follows from that.

This analysis survived measurement; the conclusion drawn from it did not. Fan-out
was measured at 3.0–3.3x speedup against sequential execution of the same four
explorers — near the ceiling of 4 — and was still slower end to end than the unaided
baseline, exactly as the relationship above predicts: **+9,428 ms on the paired mean,
slower in 14 of 15 paired runs** (`pairedLatency[(pooled), fanout]` in
`bench/results/2026-09-11T09-12-16.json`). This paragraph said "1.36x slower" until
2026-09-11; that ratio came from the blocked arm order and is withdrawn.

The relationship also predicts something the first sweep got wrong. Since parallelism
does not reduce the turns inside any one explorer, four explorers should cost roughly
what one costs in wall-clock and four times as much in money — and interleaved, that
is exactly what happens. Fan-out against one explorer is **+414 ms on the paired mean,
median ratio 0.994, slower in 7 of 15** — a wash — at **3.5x** the spend. The first
sweep's "1.17x slower" was the blocked order again, since the explorer block always
preceded the fan-out block.

### Levers, in order of impact

These reduce the latency fast-explorer costs. None of them makes it negative.

1. **Thinking off** (`--thinking off`) while inheriting the model. Largest single
   reduction in per-turn latency, and it costs no relevance quality.
2. **No blocking planner.** `questions` lets the main agent decompose in the turn it
   already occupies, removing a serial round-trip from the critical path. This lever
   has since gone quiet: no split has been measured that was worth making, so the
   round-trip it saves is one that need not be taken at all. See the two 2026-09-11
   amendments under "Trigger".
3. **`maxFanout == concurrency`.** Guarantees one wave, so wall-clock is the slowest
   single explorer rather than the sum of two batches.
4. **Turn budget plus parallel-tool instruction.** `prompts/explorer.md` directs
   explorers to issue every independent search in a single message, since pi runs
   them concurrently. An explorer making ten greps at once costs roughly one round,
   not ten. `maxTurnsPerExplorer` caps the tail.
5. **Bail out when exploration cannot pay.** If total candidate bytes fall below
   `minTotalBytes`, return the files directly. Below that floor, reading is both
   faster and higher fidelity than any subagent.

### The durable win

Independent of the exploration turn, every subsequent turn in the session carries a
smaller context. It also postpones auto-compaction, which is a multi-second
synchronous stall. This compounds, and it is now the *only* justification, because
the per-sweep latency effect was measured going the other way.

The shape of the trade is what makes it worth taking anyway: the latency and the
cost are paid once, at the sweep, while the tokens would otherwise be paid on every
turn after it. Measured, a baseline sweep left 14,860–56,420 tokens of file contents
in the main context; an explorer report is 1,100–1,382 tokens. (Corrected 2026-09-11:
this range was 23,896–48,956, which was one of three 5-run context samples taken at the
same settings. All three are now committed and the range spans them — see "Context" in
the README.) The explorer's own
reading is spent in a subprocess and discarded on exit, so it never enters the main
context at all — which is why per-run cost and per-run context are different
measurements and must not be collapsed into one.

### Acceptance criteria

One criterion remains, unchanged from the original three. It is falsifiable and is
measured by the benchmark suite described under "Benchmark", not asserted by hand.

- Main-agent context after exploration is **at least 5× smaller** than after the
  unaided sweep. **Met on 2026-09-11** — 20.3–35.7x measured.

The other two were both about speed. One was measured and failed; the other was
never implemented. Neither has been replaced. No new criterion has been added in
their place, deliberately: writing a fresh acceptance bar after seeing the results,
and choosing one the results clear, would be a way of passing rather than a way of
being tested. Recall, precision, citation validity and quote fidelity are all
measured and reported by the benchmark, but as observations, not as bars that were
set in advance.

### Retired goal: speed (2026-09-11)

This design listed "make the main agent faster, measurably" as a goal and carried an
acceptance criterion for it: *`explore` over a ~40-file sweep completes in no more
wall-clock than the unaided main agent performing the same sweep*. There was a third
criterion too, on time-to-first-token over the ten turns after a sweep.

The first was measured on 2026-09-11 and **failed**. It was re-measured later the same
day on a corrected harness and it failed by more. The current figures, from
`bench/results/2026-09-11T09-12-16.json` — corpus `~/claude-plus-plus`, model
`openai/gpt-5.6-luna`, 5 questions × 3 runs × 3 arms, arms interleaved:

| subject vs baseline | paired mean delta | runs the subject lost | paired median ratio |
|---|---|---|---|
| explorer (one) | **+9,015 ms** | **14 / 15** | 1.458 |
| fanout (four) | +9,428 ms | 14 / 15 | 1.552 |

Fields: `pairedLatency[(pooled), <arm>].meanDeltaMs`, `.subjectSlower` / `.pairs`,
`.ratio.median`. Per-question, the explorer's mean delta runs from +2,634 ms
(`persistence`) to +22,115 ms (`bash-approval`), and the baseline is ahead at the
median on all five.

The penalty is **per turn, not per run**. Pooled medians of
`records[].elapsedMs / records[].turns`: explorer **5,045 ms/turn** against the
baseline's **3,744 ms/turn**, at near-identical turn counts (mean 5.13 vs 4.93). The
explorer prompt asks for ten concurrent searches and a structured, cited report; that
is a protocol cost. It is also the most reproducible number here — 4,925 / 5,004 /
5,045 ms/turn across the three sweeps run at 5 questions and cap 8, a 2.4% spread,
while the same sweeps' explorer totals span 34%. The baseline's per-turn figure is not
that stable (4,043 / 4,949 / 3,744, a 32% spread), so the two absolute figures are
worth publishing and their ratio is not worth treating as a constant.

**The original version of this table is superseded and its ratios are withdrawn.** It
read, from the first sweep (`2026-09-11T04-37-10.json`, 4 questions × 5 runs):
baseline 13,983 ms, explorer 16,276 ms at "1.16x slower", fanout 19,051 ms at "1.36x
slower", costing $0.0122 / $0.0176 / $0.0629 per run. The absolute medians and the
costs are what that sweep measured and stand as such; the two ratios do not, because
that sweep ran the arms in per-question blocks with the baseline always last. See the
amendment below.

The baseline was faster on every question of that sweep in both explorer
configurations — not a marginal loss on the aggregate, a clean sweep — and that part
replicated exactly on all five questions once the arms were interleaved. (Across all
six sweeps there is one question-level exception, `tracking` in the blocked second
sweep, noted under "Re-measured in the second sweep" below.) The guard rails were not
wrong and moving the
thresholds would not have helped: the concurrency pool measured 3.0–3.3x against
sequential execution of the same four explorers, against a ceiling of 4, and the
remaining gap is per-explorer fixed overhead plus the turns × latency relationship
above — neither of which a threshold touches.

The TTFT criterion was never implemented, so it is retired as unmeasured rather than
as failed. It remains plausible on the mechanism — a smaller context does prefill
faster — but this design should not carry an unmeasured claim next to a falsified
one.

What this changes:

- The goal is **removed**, not softened into "roughly as fast" or "fast enough". A
  design record that quietly drops a falsified goal is less useful than one that
  never made the claim, because the reader cannot tell which claims were tested.
- "The durable win" is promoted from a supporting argument to the whole argument.
  The old text said the context effect was "deliberately not the only
  justification". It is now the only justification, and the honest framing is a
  trade with a losing side, not a win.
- The levers under "Levers, in order of impact" stay. They were never about beating
  the baseline; they are about how much the extension costs, and +9.0 s per sweep is
  the number they bought. (This bullet said "1.16x" until 2026-09-11.)

The context claim, which was the secondary argument, held by 20.3–35.7x — a much
wider margin than the 5x the criterion asked for. The benchmark therefore falsified
the headline and confirmed the footnote, which is an argument for keeping both in a
spec rather than only the one that sounds better. It is also why context stays the
headline after this correction: a 13–41x effect clears the noise floor by an order of
magnitude, and latency does not.

**Re-measured in the second sweep**, at the current defaults and over 5 questions: the
baseline was ahead on four questions of five, at 24,256 ms against 26,117 ms and
26,116 ms. That was published as "1.08x slower for one explorer and 1.08x for four",
and those ratios are withdrawn with the rest — the second sweep was blocked too, and
it produced the *kindest* ratio of the five, which is exactly the pattern the
amendment below explains. The retired goal stays retired either way.

The fifth question of five was `tracking`, where the explorer's median was 22,648 ms
against the baseline's 27,706 ms and fan-out's was 26,116 ms. **That is the only
question-level win either explorer arm has recorded in six sweeps**, and it is
recorded here rather than dropped. It did not survive interleaving — `tracking` is
+3,939 ms with 2 of 3 pairs lost in `09-12-16`. The likelier explanation is the
control arm rather than the extension: the baseline's own median on `tracking` reads
27,706 ms in that sweep and 19,949 ms in the interleaved one at the same settings, a
swing of 7,757 ms on the control alone — larger than the 5,058 ms "win" it produced.

#### Amendment (2026-09-11): the latency figures were measuring execution order

**Every latency ratio this document published before this date came from a harness
confounded by execution order, and all of them understated the cost.**

The benchmark ran the arms in per-question blocks — every explorer run, then every
fan-out run, then every baseline run. The baseline was therefore systematically the
last arm measured for each question, and the headline statistic was explorer over
baseline. Anything that made later runs slower inflated the denominator and flattered
the extension. Reconstructing arm start times by summing `records[].elapsedMs` in
array order, the baseline block in `2026-09-11T08-02-02.json` began on average
**171.8 s** later in the sweep than the explorer block. (`bench/run.ts`'s
`FINDINGS["turn-budget-not-a-latency-lever"]` reports 169 s for the same sweep; it
measured to each run's midpoint where `startOffsetMs` measures to its start. Nothing
turns on the convention.)

Commit `7c220f5` interleaves the arms run-by-run, rotating the order by run and
question. Rotation rather than a shuffle, because at three runs per question a fair
shuffle puts the baseline last in all three about one time in 27; rotation balances
mean position exactly rather than in expectation. Every record now carries `slot` and
`startOffsetMs`, so position is a stored field instead of a reconstruction. The mean
arm start-offset gap fell from ~172 s to **6.3 s**
(`executionOrder.meanOffsetGapToBaselineMs.explorer` = 6,348 ms), and
`executionOrder.balance[].meanSlot` is 22 for all three arms — exactly equal.

Same config, same corpus, same model, same cap of 8, three runs per question. Only the
ordering changed:

| statistic | blocked (`08-02-02`) | interleaved (`09-12-16`) |
|---|---|---|
| paired mean delta, explorer vs baseline | +6,385 ms | **+9,015 ms** |
| runs where the explorer was slower | 11 / 15 | **14 / 15** |
| paired median ratio | 1.337 | **1.458** |
| mean arm start-offset gap to baseline | ~171,800 ms | **6,348 ms** |

**What is established.** That the blocked design left execution order free to explain
the ratio. A confound does not have to be shown to be active to invalidate a
measurement — it has to be possible and uncontrolled, and this one was both. That is
enough to discard every pre-interleaving ratio, and the artifact says so in
`comparability.note`: *"Treat every pre-interleaving ratio as uninterpretable rather
than merely noisy."*

**What is not established: that latency actually drifts upward during a sweep.** The
evidence once offered for drift was that block separation rank-orders the reported
ratio across the five blocked sweeps (Spearman −1.0, Pearson −0.85). That correlation
is **circular**: the block gap was itself computed by summing the same `elapsedMs`
values that form the ratio's numerator and denominator, so both sides share their
inputs. The non-circular test is the within-block slope of `elapsedMs` against run
index, pooled over every `(question, arm)` block, and it does not survive: **+360,
−837, +71, +781, +979 ms per position** across the five blocked sweeps. It changes
sign. Drift is a plausible mechanism with no clean evidence behind it, and nothing in
this amendment depends on it being real.

**The fix carries its own possible bias.** Interleaving widens the spacing between
consecutive runs of the same arm — median 30.8 s → 72.2 s for the explorer, 25.9 s →
60.5 s for the baseline. If the provider caches prompt prefixes, wider spacing costs
cache locality, and the explorer carries the larger cached prefix (its own system
prompt plus `prompts/explorer.md`), so it has more to lose. Some unknown part of the
1.337 → 1.458 move could be that rather than bias removal. Assessed as small — 60–90 s
sits well inside plausible cache TTLs, and the spacing widened by the same factor
(2.3x) for both arms — but not zero, and not separable from this data. It would need a
third design, not another run of this one.

**The methodology finding is worth more than the number it corrected.** Five sweeps
agreed on the sign of the result, were internally consistent, and were quoted against
each other in this document as if they were comparable. A sixth measurement of the same
quantity moved the mean delta by 41%. Cross-run consistency is evidence that a harness
is deterministic; it is not evidence that the harness is measuring the quantity named
in the column header. Nothing in the design was wrong here — the measurement was, and
it took five agreeing runs to notice.

### Open question: is fan-out ever worth it?

**Partially answered 2026-09-11, and the answer is unfavourable. Recorded here as a
dated finding next to the retired speed goal, because it falsifies this design's
central parallelism argument the same way the benchmark falsified its speed goal.**

Fan-out is the configuration this design argues for most strongly, and it is the one
with the worst evidence.

The first sweep (`bench/results/2026-09-11T04-37-10.json`) measured four explorers on
a single question costing 3.6x as much as one ($0.0629 vs $0.0176 per run), matching
the single explorer's recall exactly on every question both
arms scored (median 1.00), with consistently worse precision because four explorers
cite more files and dilute the ones that matter. (That sentence also said "running
1.17x slower". It is withdrawn: the arms were blocked and the explorer block always
preceded the fan-out block. Interleaved, fan-out is a wash against one explorer —
paired mean delta +414 ms, median ratio 0.994, slower in 7 of 15 — and costs 3.5x.
The case against `questions` is a cost-and-recall case, and removing the latency claim
does not weaken it.) But every question in that sweep was
**saturated by one explorer**, so the evidence was asymmetric: wasteful on saturated
questions, nothing at all about separable ones. The path existed for the separable
case and the separable case had not been tested.

#### The separable case, tested (2026-09-11, second sweep)

`bench/results/2026-09-11T05-44-05.json` — same corpus, same model, current defaults,
5 questions × 5 runs × 3 arms, 75 runs, no failures. A fifth question was added for
this purpose: `bash-approval`, "when a shell command needs approval, how is that
decided, how is the user asked, and how is an 'always allow' answer remembered?". Its
answer lives in four separate top-level subsystems of `~/claude-plus-plus`, about
5,100 lines — rule evaluation, shell rule matching, the interactive ask, the UI. Its
four sub-questions were hand-written to be derivable from the parent question alone,
so the fan-out arm held no advantage a real caller could not have had.

Per-question medians over 5 runs, scored by which ground-truth files the answer names
(the cross-arm scorer: a baseline answers in prose and cites nothing in the explorer
format, so citation-based recall is not comparable across arms):

| arm | recall | precision | median latency | cost/run |
|---|---|---|---|---|
| baseline (no extension) | **1.00** | 0.50 | 26,075 ms † | **$0.0296** |
| explorer (one) | **1.00** | **0.625** | 32,916 ms † | $0.0373 |
| fanout (four) | **0.80** | 0.235 | 35,154 ms † | $0.0872 |

† Blocked arm order, baseline measured last; do not derive a ratio from this column.
Interleaved, `bash-approval` is the extension's worst question by a wide margin —
paired mean delta **+22,115 ms**, explorer slower in 3 of 3 pairs, median ratio 1.967.

Fan-out lost its own best case. It was the only arm below 1.00 recall in the median
run, and it missed the same file —
`src/hooks/toolPermission/handlers/interactiveHandler.ts` — in **4 of 5 runs**, with
one of its four sub-questions ("how is the approval request presented to the user")
aimed squarely at it. The single explorer missed a ground-truth file in 1 run of 5
and never missed that one.

**"Partition blindness", listed under "Known limitations" since this spec was
written, is therefore no longer a predicted risk. It is a measured effect.** Each
explorer covers its slice and stops; what connects the slices is what falls through.
The concurrency pool is not the explanation — per-question speedup medians were
2.98–3.56x on four explorers, near the ceiling of 4.

On the other four questions the first sweep replicated at the current defaults:
fan-out at 3.6x the single explorer's cost ($0.0671 vs $0.0184 per run) for identical
recall, with worse precision on all five questions.

#### Limits of this evidence

One separable question, one corpus, one model, hand-written sub-questions, 5 runs. It
establishes that fan-out has no measured case in its favour and one measured case
against it. It does **not** establish that fan-out never helps, and this section
should not be read as though it did.

#### Consequences

1. The guidance no longer conditions decomposition on anything. The tool
   description, `promptGuidelines` and the `questions` parameter description all
   state that decomposition has no measured benefit, with the 3.6x and 2.3x figures
   and the 4-of-5 miss attached. Nothing in the shipped text recommends `questions`.
2. **The path is kept, unrecommended.** n = 1 on the separable case is too thin to
   delete tested, working code, and the fan-out machinery is exactly what the design
   below would run on. This is a judgement call, not a conclusion from the data; the
   honest alternative is removing `questions` outright.

#### The design that fits the data

**Sequential escalation**: run one explorer, inspect its `## Not Covered` section, and
fan out only when that section is non-trivial. It pays one extra round-trip on the
questions that need it, in place of the 2.3–3.6x multiplier currently paid up front
on questions that do not — and the measurement now says which of those two is the
expensive one. The blocker named here used to be that the corpus contained no
separable question; that blocker is gone, and `bash-approval` is the question to
evaluate it against.

**This is recorded as the direction a future version should take, and it is
deliberately not implemented.** Whether to build it — or to remove `questions`
instead — is a product decision for a human, not something to fold into the
documentation pass that recorded the result.

### Open question: in-process explorers

Each subprocess pays node startup, config load, and `AGENTS.md` parsing. pi exports
`createAgentSession()` from its SDK, which would allow running explorers in-process
and eliminating that fixed cost. This trades process isolation and abort simplicity
for startup latency. **To be measured during implementation**, with the subprocess
path retained as the fallback; the choice is an implementation detail behind
`explorer.ts` and does not affect the rest of the architecture.

## Architecture

```
fast-explorer/
├── index.ts          # registers explore tool, grep hook, /explore command   ← NOT BUILT: no slash command
├── explorer.ts       # spawn + stream one pi subprocess, abort handling
├── partition.ts      # shape-dependent split
├── planner.ts        # sub-question decomposition (Path A only)              ← NOT BUILT
├── synthesis.ts      # merge + dedup reports
├── config.ts         # settings + defaults
└── prompts/explorer.md
```

#### Amendment (2026-09-11): two components in this block were never built

The block above is the design, not the package. Two of the things it names do not exist
in `src/`, and until now only one of them said so anywhere.

- **`planner.ts`** — designed as the Path A fallback that decomposes a bare `question`
  into sub-questions. Not built. This was already recorded under "Implementation notes"
  (*"No planner shipped in v1"*), but the architecture block itself was never corrected,
  so a reader arriving here first was told a module exists that does not. It is kept in
  the listing rather than deleted because the reason it was dropped is the interesting
  part: the benchmark then measured decomposition *losing* — 3.6x the cost for identical
  recall on saturated questions, and lower recall on the one question built to favour it
  — so the missing planner turned out to be the absence of a mechanism that had no
  measured case in its favour. See "Open question: is fan-out ever worth it?".
- **The `/explore` slash command** — named in the `index.ts` comment. Not built, and
  never disclosed anywhere until this amendment. No slash command is registered anywhere
  in `src/`; the two entry paths that exist are the `explore` tool and the `tool_result`
  hook. Nothing was measured about this one — it was simply not needed once the model
  could call the tool directly, and it was dropped without a note.

Everything else in the block is real and carries the responsibilities described below.

Each module has one responsibility and a narrow interface:

- `explorer.ts` knows how to run exactly one explorer and stream its progress. It
  knows nothing about partitioning or synthesis.
- `partition.ts` is pure — input shape in, `[{ brief, globs }]` out. No I/O, so it
  is directly unit-testable.
- `synthesis.ts` is pure — reports in, merged report out.
- `index.ts` wires them to pi's extension API and owns all UI concerns.

The extension is **standalone**. It spawns `pi` directly rather than depending on
the `subagent` example being installed, so there is no install-order coupling.

## Known limitations

These are accepted, not solved. They are recorded so they are not rediscovered as
surprises.

- **Partition blindness — measured on 2026-09-11, no longer a prediction.** Splitting
  by file guarantees some cross-file relationships are cut. Explorer A sees the
  caller, explorer B sees the callee, neither notices a signature mismatch.
  Directory-grouped bucketing and the `## Architecture` section reduce this; no
  partition scheme eliminates it. On the one benchmark question whose answer spans
  four subsystems, four explorers missed the file holding the interactive approval
  prompt in 4 of 5 runs — one of the four briefs pointed straight at it — while a
  single explorer on the whole question never missed it. This is now the main reason
  `questions` is documented as not recommended.
- **Explorers do not know what they do not know.** The main agent holds the whole
  conversation; an explorer gets one brief. It will miss adjacent-but-relevant code.
- **Duplicated reading.** Every explorer reads the shared `types.ts` and `index.ts`.
  This wastes tokens and can produce inconsistent descriptions of the same entity
  across reports.
- **Fixed overhead per explorer** — spawn, system prompt, tool definitions,
  `AGENTS.md` — paid N times. The fan-out floor and `minTotalBytes` exist to prevent
  this dominating; in-process explorers may remove it entirely (see "Performance and
  context"). Measured, this overhead is most of the reason the extension is slower
  than the baseline, which makes the in-process question the one open item with a
  plausible path to closing that gap.
- **Latency floor set by the slowest explorer.** One explorer that needs five turns
  makes the whole sweep five turns long, however many others finished in one.
  Bucketing aims for balance but cannot guarantee it. Measured: four explorers ran at
  3.0–3.3x the sequential time of the same four, against a ceiling of 4 — the missing
  0.7–1.0 is this.
- **Non-determinism.** Parallel LLM calls give different answers across runs, which
  makes behaviour harder to test and to trust. Measured on one question and arm,
  recall ranged 0.50–1.00 across five runs.
- **Auto-promote false positives.** A grep the model intended as a quick existence
  check becomes an exploration — measured at a **22.0 s** pooled median for one
  explorer (`records[].elapsedMs`, explorer arm, `2026-09-11T09-12-16.json`), not the
  8 s guessed here. (This read "16.3s" until 2026-09-11, from the first sweep, which
  ran four easier questions at a lower turn cap. The two are not comparable and the
  later one is the corpus the rest of this document now uses.) Threshold tuning is
  real work and the defaults are still a
  starting guess: nothing in the benchmark exercises them, because the benchmark
  calls explorers directly rather than through the hook.
- **It is slower than not using it, by more than this document used to say.**
  Interleaved, one explorer costs **+9,015 ms per sweep** on the paired mean and loses
  **14 of 15** paired runs; four explorers cost +9,428 ms and lose 14 of 15. The
  baseline is ahead at the median on all five questions. The mechanism is per-turn
  cost: 5,045 ms/turn against 3,744, at near-equal turn counts. The figures this item
  carried until 2026-09-11 — 1.16x and 1.36x from the first sweep, 1.08x from the
  second — are **withdrawn**, not superseded: they came from blocked arm ordering with
  the baseline always last. This was a goal until 2026-09-11 and is now a limitation;
  see "Retired goal: speed (2026-09-11)" and its amendment.
- **The parallelism argument was tested and it lost.** Fan-out is wasteful on
  saturated questions (3.6x the cost, identical recall) and, on the one separable
  question the corpus now contains, it cost 2.3x for *lower* recall than a single
  explorer. The design's central parallelism claim has no measured case in its favour.
  The path is kept, unrecommended, on n = 1. See "Open question: is fan-out ever worth
  it?".
- **Loss of incidental learning.** When the main agent reads files itself it absorbs
  conventions it was not looking for. Delegation eliminates that serendipity.

### When fast-explorer is the wrong tool

Encoded as guard rails in the tool description and the auto-promote threshold:

- Total candidate bytes below `minTotalBytes` (default 50KB) — reading directly is
  both faster and higher fidelity
- Fewer than ~5 candidate files (as shipped; this said ~8 when it was a guess, and
  the tool description says "more than ~5 files")
- The agent already knows the exact file and line
- Edit-heavy rather than search-heavy work
- Interactive debugging where the agent needs to iterate on real output
- Latency-sensitive work in a short session, where the context saving never has
  enough turns to repay the ~9 s per sweep it costs up front (this said "the 1.16x"
  until 2026-09-11)

## Relationship to other designs

fast-explorer and context compaction address the same pressure from opposite ends,
and fail in opposite directions:

- **Compaction:** full fidelity when it matters, detail decays later. Failure mode is
  *lost detail*.
- **Exploration:** never sees the detail, receives a cited index instead. Failure mode
  is *incomplete findings*.

They compose. fast-explorer keeps large sweeps out of context; compaction remains the
backstop for everything else. This spec does not depend on any compaction work.

## Testing strategy

- `partition.ts` and `synthesis.ts` are pure functions — unit tested directly with
  fixture inputs, no subprocess required.
- `explorer.ts` is tested against a stub subprocess that emits recorded pi JSON
  events, covering success, non-zero exit, timeout, and abort.
- Auto-promote threshold logic is unit tested against recorded `grep`/`find` tool
  results.
- One end-to-end test against a fixture repository, asserting the citation contract
  holds (every `## Files Retrieved` entry resolves to a real file and line range)
  rather than asserting on model prose, which is non-deterministic.
- **A benchmark suite** measuring speed *and* quality against a real repository.
  Specified in full below.

As built: **345 unit tests across 19 files** (`npx vitest --run`, 2026-09-11), plus the
benchmark. The end-to-end fixture test in the third bullet was **not** written — the
benchmark subsumed it for the `explore` path, which now has 90 real explorer runs behind
it across two sweeps.

#### Amendment (2026-09-11): the auto-promotion seam has now been crossed, once

This section said *"no real `grep` result has ever tripped the `tool_result` hook, been
bucketed, spawned explorers and had its content replaced."* That has been false since
commit `af1bb37`. A real `gpt-5.6-luna` session on pi's default toolbelt ran
`rg -n --hidden --glob '!node_modules' 'tool_use_id' src/` through the `bash` tool, and
the hook promoted it: 105 files, four buckets, 311 match lines replaced by cited findings.

Two caveats keep this from being the end-to-end test the bullet asked for. **The run was
not recorded** — no artifact, no session log, no spill file survives it, so its figures
are an unreproducible measurement rather than something a reader can check; they are
flagged as such in README limitation 8. And it establishes only that the path *executes*.
Nobody has scored a promoted result the way the benchmark scores `explore`, so the
quality of what auto-promotion returns is still unmeasured. The seam is crossed; it is
not covered.

## Benchmark

Unit tests cannot tell us whether exploration is actually good. The benchmark is a
separate, explicitly-invoked suite (`npm run bench`) that measures fast-explorer
against an unaided baseline on a real codebase.

### Corpus

Default target: `~/claude-plus-plus` — a large, real, deeply-structured TypeScript
codebase with genuine multi-file subsystems.

The path is configurable via `BENCH_REPO`, and the suite **skips with a clear
message when the repository is absent**. A published package must not hard-depend on
a local clone, and CI will not have one.

### Baseline

The same model and the same question, with fast-explorer disabled, instructed to
investigate the codebase directly. Capped at a fixed turn limit so a runaway
baseline cannot hang the suite; hitting the cap is recorded as a baseline failure
rather than silently discarded.

### Questions

Each question has an independently-established ground-truth file set. Ground truth
must be derived by exhaustive search or human review, **not** by running
fast-explorer — otherwise the benchmark grades itself.

Initial set, spanning more than one subsystem so results do not overfit to a single
area of the repo:

| # | Question | Ground truth (illustrative) |
|---|---|---|
| 1 | How does microcompaction decide which tool results to clear? | `services/compact/microCompact.ts`, `timeBasedMCConfig.ts` |
| 2 | Where are large tool results persisted, and how is the preview built? | `utils/toolResultStorage.ts` |
| 3 | How does the per-message budget avoid breaking the prompt cache? | `utils/toolResultStorage.ts` |
| 4 | How does the agent event tracking system record and expose events? | `services/agentTracker.ts`, `server/dashboard.ts` |

Question 5 was added on 2026-09-11, after the first sweep showed that all four of the
above were saturated by a single explorer and that fan-out had therefore never been
tested on the case it exists for:

| # | Question | Ground truth |
|---|---|---|
| 5 | When a shell command needs approval, how is that decided, how is the user asked, and how is an "always allow" answer remembered? | `utils/permissions/permissions.ts`, `tools/BashTool/bashPermissions.ts`, `hooks/toolPermission/handlers/interactiveHandler.ts`, `components/permissions/BashPermissionRequest/BashPermissionRequest.tsx`, `utils/permissions/PermissionUpdate.ts` |

Its answer spans four top-level subsystems and about 5,100 lines, and its four
sub-questions are derivable from the parent question alone — no corpus knowledge —
so the fan-out arm gets no advantage a real caller could not have had. It was chosen
because the code is shaped that way, not to give fan-out a win, and the result is
recorded under "Open question: is fan-out ever worth it?" whichever way it fell. It
fell against fan-out.

### Metrics

| Metric | Measurement | Kind |
|---|---|---|
| Wall-clock | end-to-end time for the sweep | speed |
| **Paired per-run delta** | subject minus baseline on the same question and run index, averaged | speed — the statistic of record since 2026-09-11 |
| **Per-turn wall-clock** | `elapsedMs / turns`, pooled median per arm | speed — where the penalty actually lives |
| Main-agent context after | tokens in the main session post-sweep | context |
| Subsequent TTFT | median time-to-first-token over the next 10 turns | speed |
| **File recall** | `|cited ∩ truth| / |truth|` | quality |
| **File precision** | `|cited ∩ truth| / |cited|` | quality |
| **Citation validity** | cited file exists and line range is in bounds | quality, mechanical |
| **Quote fidelity** | quoted block matches the file's lines at that position, compared line-wise after trimming | quality, mechanical |
| Answer sufficiency | fixed rubric scored by an LLM judge | quality, noisy |
| Cost | tokens × model price | cost |

**Quote fidelity is the most valuable metric here.** Because the explorer contract
requires verbatim code under `file:line` headers, every quoted block can be checked
against the file on disk. A mismatch is a hallucination, caught mechanically with no
judge and no ambiguity.

The comparison as implemented is **not byte-for-byte**: each quoted line is trimmed
and blank lines are dropped on both sides before comparing, so indentation and
blank-line placement do not count. Models reliably reflow indentation when quoting
into a report, and scoring that as a hallucination would make the detector cry wolf
on citations that are in fact correct — a detector nobody trusts blocks nothing.
Fabricated, paraphrased or mislocated content still fails, which is the property the
metric exists for. Any non-zero hallucination rate is a release blocker — a
confidently wrong citation is worse than no citation, because the main agent will
trust it and skip verifying.

**Two corrections to the paragraph above, from implementation and measurement.**

*Mislocated content does not fail, and should not.* "Quote fidelity below 1.0 fails"
turned out to be un-shippable for the right reason: it conflated invented code with
a correct excerpt carrying a wrong line number, and the second was the overwhelming
majority. On the first recorded sweep, of 131 failing quotes, 111 were drift and 20
were invention. So `verifyQuote` searches the whole file rather than only the stated
line, and `reanchorReport` — which runs at request time in `synthesize`, not only in
the benchmark — rewrites the anchor to where the code actually is. Drift is reported
and not gated, because gating on a defect that is already corrected automatically is
gating on nothing. The gate is invented, misattributed, missing-file and empty
content only.

*The gate is red, and the package shipped anyway.* Measured on 2026-09-11, 15 of 520
quote blocks (2.9%) named content the cited file does not contain, and the gate is
defined to fail at any non-zero count — so the recorded run fails it. This
contradicts "release blocker" as written. It is recorded rather than quietly
softened: the mitigation in place is that such a block reaches the main agent marked
`UNVERIFIED` or `MISATTRIBUTED` on its own fence header rather than being removed or
silently passed, which makes a bad citation visible but does not make it zero.

*The verifier has a known soft spot.* Validated by injecting 49,985 mutations into
known-good quotes: 182 escaped (0.364%), every one an all-comment quote where
deleting a word still leaves a contiguous verbatim run — which the `reflowed`
verdict accepts by design. On quotes containing code, 43,777 mutations were injected
and none escaped. **Unreproducible measurement (noted 2026-09-11):** that sweep was a
one-off script that was not kept, and no artifact, test or data file for it exists in
the repository — these four figures resolve to nothing checkable. The soft spot itself
is readable out of `src/citations.ts` (`locateReflow` is gated to all-comment quotes);
only the rates depend on the lost sweep. Tightening it trades these escapes for false
fabrication reports
on legitimately re-wrapped comments, which is the worse failure for a detector whose
only value is being believed. Recorded next to the fidelity number rather than
fixed.

Recall and precision together guard against the two failure modes named under
"Known limitations": partition blindness shows up as low recall, over-eager
exploration as low precision. Measured, they separated cleanly and in opposite
directions: the explorer's recall median was 1.00 on all four questions against a
baseline median of 0.50–1.00, while its precision was *worse* than the baseline's on
all four (0.25–0.67 against 0.29–1.00). Over-eager exploration is real and
visible.

Partition blindness did not appear in that sweep, because no question was separable
enough to partition. It appeared as soon as one was: on `bash-approval` in the second
sweep, the fan-out arm's recall fell to 0.80 against the single explorer's 1.00, with
the same file missing in 4 of 5 runs. Low recall under partitioning is exactly the
signature this metric pair was built to catch, and it caught it.

### Method

- N = 5 runs per question per arm; report **median and spread**, never a single run.
  LLM latency and output both vary enough that a single sample is meaningless.
- Report per-arm cost so a quality win bought with a large cost increase is visible
  rather than hidden.
- Results are written to `bench/results/<date>.json` and a summary table to stdout,
  so runs are comparable across commits. Amended 2026-09-11: those artifacts were
  gitignored, which made every number in this spec and the README uncheckable from a
  clone. They are committed now, with the verbatim report text stripped — it quoted
  ~1 MB of a private corpus. Every published figure is a field that survives the strip.
- **Interleave the arms.** Amended 2026-09-11: the suite ran them in per-question
  blocks, which put the baseline last every time and made the latency comparison a
  partial readout of execution order. Arms now rotate run-by-run, every record carries
  `slot` and `startOffsetMs`, and `executionOrder.balance` reports the mean position of
  each arm so the assumption behind the paired statistic is checkable rather than
  asserted. See "Amendment (2026-09-11): the latency figures were measuring execution
  order".
- Gate on wide margins. The suite exists to catch regressions, not jitter.

### What the benchmark cannot tell you

Recorded because these are the limits of every number this spec now quotes.

- **Only an interleaved sweep can support a latency comparison.** The first four
  sweeps blocked the arms with the baseline last, so their cross-arm latency ratios are
  uninterpretable and are withdrawn wherever this document quoted them. Everything else
  those sweeps measured stands. Check `executionOrder.interleaved === true` before
  comparing any future latency number against the ones here.
- **One model, one corpus.** All results are `openai/gpt-5.6-luna` on
  `~/claude-plus-plus`. The output contract is a prompt, so contract compliance and
  quote fidelity are properties of that model as much as of this design; the latency
  penalty is per-turn cost, which is a property of that model. `BENCH_MODEL` and
  `BENCH_REPO` exist so this can be rerun, not so the result can be assumed to
  transfer.
- **One separable question, measured once.** Four of the five questions are saturated
  by a single explorer, which is why fan-out measures as pure waste on them. The
  fifth was added to test the case the design's parallelism argument rests on, and
  fan-out lost it — but that is one question, one corpus, one model, and
  hand-written sub-questions. It is evidence against fan-out where there used to be
  none; it is not a demonstration that fan-out never helps. See "Open question: is
  fan-out ever worth it?".
- **The first sweep was measured at `maxTurnsPerExplorer: 5`.** The default is 8 now,
  changed because of what that run showed. The affected runs completed normally, so
  latency and cost include them; what shrank is the number of runs that scored — 33
  of 40. The second sweep is at 8 and scored 50 of 50, so the two sweeps' cost figures
  are comparable but their failure columns are not — and neither sweep's latency
  comparison is usable at all, for the separate reason above.
- **Answer sufficiency was never implemented.** The LLM-judge rubric in the metrics
  table above does not exist in the suite. Everything reported is mechanical.

## Publishing

- npm package `pi-fast-explorer`, MIT licensed, matching pi's own license.
- Public GitHub repository.
- README documents install via symlink into `~/.pi/agent/extensions/fast-explorer/`,
  matching the convention pi's own examples use.

Publishing and repository creation are explicit, user-confirmed steps. They are not
part of the implementation work.

## Future work

Deferred from v1, additive, and not affecting the architecture above:

- **Exploration memos.** Cache findings in tool `details` — the pattern
  `examples/extensions/todo.ts` uses for branch-correctness — so follow-up questions
  about an already-explored area reuse the first sweep instead of repeating it.
- **Synthesizer subagent** to reconcile contradictions between reports.
- **Read-sequence detection** as a third trigger: N sequential reads in one turn
  with no edits promotes to exploration.

## Implementation notes

Recorded after the fact, because this spec did not anticipate it.

**Explorers must be spawned with `--no-extensions`.** Verified against pi 0.85.1:
neither print mode (`-p`) nor `--no-session` stops extension discovery, so without
the flag every explorer loads *this extension*. The explorer prompt instructs
explorers to issue every independent search in one message, so each explorer fires
many greps, and each grep result then hits the auto-promotion hook and spawns
another wave. The branching factor is per grep rather than per explorer — estimated
at roughly 40 per level, which is ~1,600 processes at depth two and ~64,000 at depth
three. The flag is load-bearing, not tidiness. (An earlier version called the 40
"measured"; it has no artifact, so the depth-two and depth-three figures are only as
good as that estimate. What was observed, and is the actual argument for the flag, is
that the recursion happens at all.)

`--no-extensions` cannot cover an explicit `-e <path>` load, where discovery is
never consulted, so there is a second layer: every explorer is spawned with
`PI_FAST_EXPLORER_NESTED=1` in its environment (inherited by the whole subtree) and
the auto-promotion hook returns early whenever it sees that variable.

**No planner shipped in v1.** "Partitioning" above describes a planner call as the
Path A fallback when the caller supplies no `questions`. It was not built. A
`question`-only `explore` call runs exactly one explorer, so the explicit tool path
fans out only as wide as the caller decomposed. Path B is unaffected: it partitions
a file list it already has. The README states this at the call site, because it
determines how the tool should be invoked.

**Install requires a `pi.extensions` manifest.** The symlink install under
"Publishing" works only because `package.json` declares
`"pi": { "extensions": ["dist/index.js"] }`: pi discovers a subdirectory of
`~/.pi/agent/extensions/` only when it holds a top-level `index.ts`/`index.js` or
declares that field. The symlink must also target the package root rather than
`dist/`, because pi does not consistently dereference a symlink before resolving
`prompts/explorer.md` relative to the loaded file, and a missing
`--append-system-prompt` path is appended as literal text rather than raising —
which would strip the output contract from every explorer with no error anywhere.

### Amendment (2026-09-11): question 3 ground truth corrected

The table above originally listed `services/api/promptCacheBreakDetection.ts` for
question 3. It was matched on its name, not its contents: it contains zero
occurrences of `budget` or `tool_result`, hashes system and tool state, and logs
cache-break telemetry. Neither module imports the other. The budget and its
cache-stability reasoning live entirely in `toolResultStorage.ts`.

This mattered more than a stale row usually would. While that entry stood, the
benchmark scored question 3 at recall 0.50 across five consecutive runs — the
explorers had found everything that was actually there, every time, and were being
penalised for not citing a file with nothing relevant in it. A benchmark that marks
correct answers wrong is worse than no benchmark, because the obvious response is to
"fix" the tool until it chases the error.

`bench/questions.ts` was corrected first; this table had drifted from it.
