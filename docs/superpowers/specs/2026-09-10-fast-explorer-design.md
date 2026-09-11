# fast-explorer — Design

**Date:** 2026-09-10
**Status:** Implemented; amended 2026-09-11 against benchmark results
**Package:** `pi-fast-explorer`

Amendments are marked in place and dated rather than folded in silently, so a reader
can tell which parts of this document were designed and which were measured. The
largest is that the speed goal was falsified — see "Retired goal: speed
(2026-09-11)".

## Problem

When a pi agent needs to understand code spanning many files, it reads them one at
a time into its own context. A sweep across 40 files can cost 300k tokens, and every
one of those tokens is then dragged through every subsequent turn of the session
until compaction throws them away.

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

**Amended 2026-09-11.** This section said `promptGuidelines` "instructs the model to
supply `questions` whenever it can". That advice was measured wrong: on a question a
single explorer already covers, four explorers cost 3.6x for identical recall and
worse precision. The guidelines now condition decomposition on the question spanning
separable areas of the codebase, and omitting `questions` — one explorer — is the
documented default. Removing a round-trip is a saving on a split you had a reason to
make; it is not a reason to make the split. See "Open question: is fan-out ever
worth it?".

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
explorers — near the ceiling of 4 — and was still 1.36x slower end to end than the
unaided baseline, exactly as the relationship above predicts.

### Levers, in order of impact

These reduce the latency fast-explorer costs. None of them makes it negative.

1. **Thinking off** (`--thinking off`) while inheriting the model. Largest single
   reduction in per-turn latency, and it costs no relevance quality.
2. **No blocking planner.** `questions` lets the main agent decompose in the turn it
   already occupies, removing a serial round-trip from the critical path. This is a
   saving on a split worth making, not a reason to split — see the 2026-09-11
   amendment under "Trigger".
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
turn after it. Measured, a baseline sweep left 23,896–48,956 tokens of file contents
in the main context; an explorer report is 1,100–1,382 tokens. The explorer's own
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

The first was measured on 2026-09-11 and **failed**. Corpus `~/claude-plus-plus`,
model `openai/gpt-5.6-luna`, 4 questions × 5 runs × 3 arms, recorded in
`bench/results/2026-09-11T04-37-10.json`:

| arm | median latency | vs baseline | cost/run |
|---|---|---|---|
| baseline (plain pi) | 13,983 ms | — | $0.0122 |
| explorer (one) | 16,276 ms | 1.16x slower | $0.0176 |
| fanout (four) | 19,051 ms | 1.36x slower | $0.0629 |

The baseline was faster on every question in every configuration — not a marginal
loss on the aggregate, a clean sweep. The guard rails were not wrong and moving the
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
  the baseline; they are about how much the extension costs, and 1.16x is the number
  they bought.

The context claim, which was the secondary argument, held by 20.3–35.7x — a much
wider margin than the 5x the criterion asked for. The benchmark therefore falsified
the headline and confirmed the footnote, which is an argument for keeping both in a
spec rather than only the one that sounds better.

### Open question: is fan-out ever worth it?

Fan-out is the configuration this design argues for most strongly, and it is the one
with the worst evidence.

Measured, four explorers on a single question cost 3.6x as much as one ($0.0629 vs
$0.0176 per run), ran 1.17x slower (19,051 ms vs 16,276 ms), matched the single
explorer's recall exactly on every question both arms scored (median 1.00), and had
consistently worse precision (per-question medians 0.12–0.29 against 0.25–0.67)
because four explorers cite more files and dilute the ones that matter.

But every benchmark question turned out to be **saturated by one explorer**. So the
evidence is asymmetric in a way that is easy to over-read: there is measured
evidence that fan-out is wasteful on a saturated question, and **no evidence at all**
about a genuinely separable one, because the corpus never produced such a question.
The fan-out path exists for the separable case and that case has not been tested.

Two consequences, both taken:

1. `promptGuidelines` now condition decomposition on breadth — supply `questions`
   only when the question spans separable areas of the codebase — rather than
   advising it whenever decomposition is possible.
2. The path is kept. Removing it would be acting on the absence of evidence as
   though it were evidence of absence.

The alternative that fits the data is **sequential escalation**: run one explorer,
inspect its `## Not Covered` section, and fan out only when that section is
non-trivial. That pays one extra round-trip on the questions that need it, in place
of the 3.6x multiplier currently paid up front on questions that do not. It is not
implemented. The blocker is not the code — it is that the benchmark corpus contains
no separable question to evaluate either arm against, so building it now would be
building against the same missing measurement.

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
├── index.ts          # registers explore tool, grep hook, /explore command
├── explorer.ts       # spawn + stream one pi subprocess, abort handling
├── partition.ts      # shape-dependent split
├── planner.ts        # sub-question decomposition (Path A only)
├── synthesis.ts      # merge + dedup reports
├── config.ts         # settings + defaults
└── prompts/explorer.md
```

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

- **Partition blindness.** Splitting by file guarantees some cross-file
  relationships are cut. Explorer A sees the caller, explorer B sees the callee,
  neither notices a signature mismatch. Directory-grouped bucketing and the
  `## Architecture` section reduce this; no partition scheme eliminates it.
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
  check becomes an exploration — measured at a 16.3s median for one explorer, not the
  8s guessed here. Threshold tuning is real work and the defaults are still a
  starting guess: nothing in the benchmark exercises them, because the benchmark
  calls explorers directly rather than through the hook.
- **It is slower than not using it.** Measured 1.16x for one explorer and 1.36x for
  four, with the unaided baseline ahead on every question. This was a goal until
  2026-09-11 and is now a limitation; see "Retired goal: speed (2026-09-11)".
- **The parallelism argument is untested.** Fan-out has measured evidence of being
  wasteful on saturated questions and no evidence of being useful on separable ones,
  because the corpus contains none. See "Open question: is fan-out ever worth it?".
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
  enough turns to repay the 1.16x it costs up front

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

As built: 239 unit tests across 17 files, plus the benchmark. The end-to-end fixture
test in the third bullet was **not** written — the benchmark subsumed it for the
`explore` path, which now has 40 real explorer runs behind it. It did not subsume it
for the auto-promotion path: no real `grep` result has ever tripped the `tool_result`
hook, been bucketed, spawned explorers and had its content replaced. That seam is
covered by unit tests on each side of it and by nothing that crosses it.

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
| 3 | How does the per-message budget avoid breaking the prompt cache? | `utils/toolResultStorage.ts`, `services/api/promptCacheBreakDetection.ts` |
| 4 | How does the agent event tracking system record and expose events? | `services/agentTracker.ts`, `server/dashboard.ts` |

### Metrics

| Metric | Measurement | Kind |
|---|---|---|
| Wall-clock | end-to-end time for the sweep | speed |
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
and none escaped. Tightening it trades these escapes for false fabrication reports
on legitimately re-wrapped comments, which is the worse failure for a detector whose
only value is being believed. Recorded next to the fidelity number rather than
fixed.

Recall and precision together guard against the two failure modes named under
"Known limitations": partition blindness shows up as low recall, over-eager
exploration as low precision. Measured, they separated cleanly and in opposite
directions: the explorer's recall median was 1.00 on all four questions against a
baseline median of 0.50–1.00, while its precision was *worse* than the baseline's on
all four (0.25–0.67 against 0.29–1.00). Over-eager exploration is real and
visible; partition blindness did not appear, because no question was separable
enough to partition.

### Method

- N = 5 runs per question per arm; report **median and spread**, never a single run.
  LLM latency and output both vary enough that a single sample is meaningless.
- Report per-arm cost so a quality win bought with a large cost increase is visible
  rather than hidden.
- Results are written to `bench/results/<date>.json` and a summary table to stdout,
  so runs are comparable across commits.
- Gate on wide margins. The suite exists to catch regressions, not jitter.

### What the benchmark cannot tell you

Recorded because these are the limits of every number this spec now quotes.

- **One model, one corpus.** All results are `openai/gpt-5.6-luna` on
  `~/claude-plus-plus`. The output contract is a prompt, so contract compliance and
  quote fidelity are properties of that model as much as of this design; the latency
  ratio depends on that model's per-turn latency. `BENCH_MODEL` and `BENCH_REPO`
  exist so this can be rerun, not so the result can be assumed to transfer.
- **No separable question.** Every question in the set was saturated by a single
  explorer, which is why fan-out measures as pure waste and why the design's central
  parallelism argument is still untested. This is a gap in the corpus, not a finding.
  See "Open question: is fan-out ever worth it?".
- **Measured at `maxTurnsPerExplorer: 5`.** The default is 8 now, changed because of
  what this run showed, and nothing has been re-measured at 8. The affected runs
  completed normally, so latency and cost include them; what shrank is the number of
  runs that scored — 33 of 40.
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
another wave. The branching factor is per grep rather than per explorer — measured
at roughly 40 per level, which is ~1,600 processes at depth two and ~64,000 at depth
three. The flag is load-bearing, not tidiness.

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
