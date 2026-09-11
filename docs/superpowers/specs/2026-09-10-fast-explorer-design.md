# fast-explorer — Design

**Date:** 2026-09-10
**Status:** Approved for planning
**Package:** `pi-fast-explorer`

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
- **Make the main agent faster, measurably** — both on the exploration turn itself
  and on every turn after it. This is a hard requirement with an acceptance test,
  not an expected side effect. See "Performance".

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

`questions` exists for latency. The main agent is already reasoning when it decides
to explore, so it can decompose the problem **in the same turn**, eliminating a
blocking planner round-trip entirely. `promptGuidelines` instructs the model to
supply `questions` whenever it can. The planner is the fallback, not the default.

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
  `fanout` argument overrides that bound.
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
context, latency, and cache preservation. Users who want the cost saving can set
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

```json
{
  "fastExplorer": {
    "model": null,
    "thinking": "off",
    "maxFanout": 4,
    "concurrency": 4,
    "maxTurnsPerExplorer": 5,
    "minTotalBytes": 51200,
    "autoPromote": { "enabled": true, "minFiles": 15, "minMatches": 60 },
    "timeoutMs": 120000
  }
}
```

`model: null` means inherit from the dispatching session. `minTotalBytes` is the
bail-out floor described under "Performance".

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

## Performance

Making the main agent faster is a requirement, so the latency budget is specified
rather than assumed.

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
the number of sequential LLM turns inside any one explorer.** Optimising for speed
therefore means minimising turns per explorer and per-turn latency, not widening the
fan-out. Every lever below follows from that.

### Levers, in order of impact

1. **Thinking off** (`--thinking off`) while inheriting the model. Largest single
   reduction in per-turn latency, and it costs no relevance quality.
2. **No blocking planner.** `questions` lets the main agent decompose in the turn it
   already occupies, removing a serial round-trip from the critical path.
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
smaller context, so prefill and time-to-first-token drop for the rest of the
session. It also postpones auto-compaction, which is a multi-second synchronous
stall. This compounds, and it is the larger effect over a long session — but it is
deliberately not the only justification, because a design that is slower at the
moment the user is watching is a design that feels slow.

### Acceptance criteria

These are falsifiable and belong in the test suite, not in the README:

- On the fixture repository, `explore` over a ~40-file sweep completes in **no more
  wall-clock than the unaided main agent** performing the same sweep.
- Main-agent context after exploration is **at least 5× smaller** than after the
  unaided sweep.
- Median per-turn time-to-first-token for the ten turns following exploration is
  **lower** than for the ten turns following an unaided sweep.

If the first criterion fails, the guard rails are wrong and the thresholds move —
the feature must not ship as a latency regression. These are measured by the
benchmark suite described under "Benchmark", not asserted by hand.

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
  this dominating; in-process explorers may remove it entirely (see "Performance").
- **Latency floor set by the slowest explorer.** One explorer that needs five turns
  makes the whole sweep five turns long, however many others finished in one.
  Bucketing aims for balance but cannot guarantee it.
- **Non-determinism.** Parallel LLM calls give different answers across runs, which
  makes behaviour harder to test and to trust.
- **Auto-promote false positives.** A grep the model intended as a quick existence
  check becomes an 8-second exploration. Threshold tuning is real work and the
  defaults are a starting guess, not a validated answer.
- **Loss of incidental learning.** When the main agent reads files itself it absorbs
  conventions it was not looking for. Delegation eliminates that serendipity.

### When fast-explorer is the wrong tool

Encoded as guard rails in the tool description and the auto-promote threshold:

- Total candidate bytes below `minTotalBytes` (default 50KB) — reading directly is
  both faster and higher fidelity
- Fewer than ~8 candidate files
- The agent already knows the exact file and line
- Edit-heavy rather than search-heavy work
- Interactive debugging where the agent needs to iterate on real output

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
metric exists for. Any non-zero hallucination rate is a
release blocker — a confidently wrong citation is worse than no citation, because
the main agent will trust it and skip verifying.

Recall and precision together guard against the two failure modes named under
"Known limitations": partition blindness shows up as low recall, over-eager
exploration as low precision.

### Method

- N = 5 runs per question per arm; report **median and spread**, never a single run.
  LLM latency and output both vary enough that a single sample is meaningless.
- Report per-arm cost so a quality win bought with a large cost increase is visible
  rather than hidden.
- Results are written to `bench/results/<date>.json` and a summary table to stdout,
  so runs are comparable across commits.
- Gate on wide margins. The suite exists to catch regressions, not jitter.

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
