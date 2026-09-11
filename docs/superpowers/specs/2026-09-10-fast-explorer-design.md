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
  question: string,   // what to find out
  scope?: string,     // optional glob or directory to limit the search
  fanout?: number,    // override the computed fan-out
})
```

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

Path A runs a single cheap planner call producing `[{ brief, globs }]`, 2–6 items.

Fan-out is determined per path:

- **Path A** — one explorer per planner item. The planner is instructed to produce
  between 2 and `maxFanout` items. An explicit `fanout` argument on the tool call
  overrides that bound.
- **Path B** — `clamp(ceil(files / 8), 2, maxFanout)`, since the file count is known
  before any model call.

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
   --tools read,grep,find,ls \
   --append-system-prompt prompts/explorer.md \
   "Task: <brief>"
```

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
    "maxFanout": 6,
    "concurrency": 4,
    "autoPromote": { "enabled": true, "minFiles": 15, "minMatches": 60 },
    "timeoutMs": 120000
  }
}
```

`model: null` means inherit from the dispatching session.

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
  `AGENTS.md` — paid N times. The fan-out floor exists to prevent this dominating.
- **Non-determinism.** Parallel LLM calls give different answers across runs, which
  makes behaviour harder to test and to trust.
- **Auto-promote false positives.** A grep the model intended as a quick existence
  check becomes an 8-second exploration. Threshold tuning is real work and the
  defaults are a starting guess, not a validated answer.
- **Loss of incidental learning.** When the main agent reads files itself it absorbs
  conventions it was not looking for. Delegation eliminates that serendipity.

### When fast-explorer is the wrong tool

Encoded as guard rails in the tool description and the auto-promote threshold:

- Fewer than ~8 candidate files — reading them directly is cheaper and better
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
