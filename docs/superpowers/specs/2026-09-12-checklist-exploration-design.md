# Checklist exploration and timeout salvage — Design

**Date:** 2026-09-12
**Status:** Approved for implementation (branch `feat/checklist-explore`)
**Package:** `pi-fast-explorer` 0.1.0 → 0.2.0

## Goal

The main agent should be able to hand a **checklist** of things it needs to know about a
large repository to read-only subagents, and get back the most relevant information —
cited, verified, and with an explicit statement of which items were and were not resolved.

Everything below was driven by one measured session (2026-09-12, DriftPaca, a 238-file
Flutter repository, `openrouter/deepseek-v4.1-flash`):

| observation | value |
|---|---|
| explorer tool turns | 7, in 43 s combined |
| report-writing turn | 1, **123 s on its own** (1,606 output tokens) |
| default `timeoutMs` | 120 s |
| outcome in the extension | killed while writing; `Explorer timed out`; zero findings |
| outcome by hand, no timeout | 8/8 ground-truth files, 0 fabricated quotes, 2 anchors corrected |
| main agent's next move | retried the identical call; timed out again; $0.013 for nothing |

So the model was accurate and the pipeline threw the answer away. Two separate defects:
the deadline measures the wrong thing, and the failure text invites a retry.

## Non-goals

- A planner subagent that decomposes questions. Not built, still not built.
- Changing the citation verifier, the auto-promotion gates, or the TUI inspector from PR #2.
- Making exploration faster than the main agent reading files itself (retired goal, unchanged).

## Approaches considered for the checklist

1. **Checklist as a report contract, one explorer** — the brief carries the items, the
   prompt demands a `## Checklist` section, the extension parses it and reports coverage.
   Cheap, testable, and the shape one explorer already handles well.
2. **(1) plus one bounded escalation wave** — items still unresolved after the first
   explorer are re-dispatched to fresh explorers that are told what the first wave
   established. This is the "explore once, fan out only if `Not Covered` is non-trivial"
   design the code comments describe but never built.
3. **One explorer per item from the start** — rejected. Measured on this repository's own
   benchmark: fan-out cost 2.3–3.6x for equal or lower recall, because each explorer covers
   its slice and the connective tissue falls through.

**Chosen: 2.** Built as 1 first, then the escalation on top, each with its own tests.

## Design

### 1. `explore` gains `checklist`

```ts
explore({
  question: string,
  checklist?: string[],   // concrete things to locate or answer, each resolved with file:line
  questions?: string[],   // unchanged, still not recommended
  scope?: string,
  fanout?: number,
})
```

The brief for every explorer becomes:

```
<question>

Checklist — resolve every item and cite file:line for each:
1. <item>
2. <item>

Limit your search to: <scope>        (only when scope is given)
```

`questions` and `checklist` compose: each question-explorer gets the full checklist.

### 2. Prompt contract: `## Checklist` section

`prompts/explorer.md` adds a fifth output section, emitted only when the task carries a
checklist, placed between `## Key Code` and `## Architecture`:

```
## Checklist
1. [x] <item> — path/to/file.ts:42 one-line answer
2. [ ] <item> — what was searched and why it is unresolved
```

Numbering follows the task. `[x]` means resolved with a citation; `[ ]` means unresolved.
`tests/prompt-contract.test.ts` is extended: the `##` heading set becomes five, and the
worked example parses to exactly two checklist lines.

### 3. `src/checklist.ts`

```ts
export interface ChecklistLine { index: number; resolved: boolean; text: string }
export interface ChecklistStatus { index: number; item: string; resolved: boolean; note: string; source?: string }

parseChecklist(report): ChecklistLine[]          // tolerant: "N. [x]", "- [x]", "[X]", "[ ]"
matchChecklist(items, reports: {brief, report}[]): ChecklistStatus[]
                                                  // by index first; an item no report mentions is unresolved, note "not reported"
formatChecklistCoverage(statuses): string          // "## Checklist coverage\n3/5 resolved.\nUnresolved:\n- 2. item — note"
```

`matchChecklist` takes several reports (wave 1 and wave 2, or several question-explorers)
and lets any `[x]` win over a `[ ]`, recording which brief resolved it.

### 4. Escalation wave

In `execute`, after wave 1:

- If `checklist` is empty, or `cfg.escalateUnresolved` is false, stop.
- If no wave-1 explorer produced a report, stop — re-running the same failure buys nothing;
  the failure text explains.
- Otherwise, take the unresolved items. Group them round-robin into
  `min(unresolved.length, maxFanout)` briefs. Each brief is:

  ```
  <question>

  A first explorer already established the following — do not re-verify it, build on it:
  - <each resolved checklist line from wave 1>
  - Files it retrieved: <## Files Retrieved entries from wave 1>

  Checklist — resolve every item and cite file:line for each:
  <the unresolved items, keeping their original numbers>
  ```

- Wave 2 runs through the same concurrency slot and abort signal. Exactly one wave; no
  third.

The result text is: wave-1 reports, wave-2 reports (each `# Explorer:` section as today),
then `## Checklist coverage`, then `## Not Covered` if anything failed.
`details.checklist` carries the `ChecklistStatus[]`.

### 5. Deadline: idle timeout plus a hard cap

`runExplorer` currently arms one timer at `timeoutMs` (120 s). pi's JSON mode streams a
`message_update` event for every text delta, so a healthy explorer is never silent for more
than a few seconds. The deadline is therefore split:

| key | meaning | default |
|---|---|---|
| `timeoutMs` | hard wall-clock cap, unchanged meaning | 120 000 → **300 000** |
| `idleTimeoutMs` | kill after this long with no stdout bytes | **60 000** (new) |

The idle timer is reset on every stdout chunk. Both fire the existing SIGTERM → SIGKILL
ladder. Error text names which one: `timed out after 300s (hard cap)` or
`stalled: no output for 60s`.

### 6. Partial-report salvage

`processLine` learns `message_update`: `text_start` opens a streaming buffer,
`text_delta` appends, `text_end` closes it (and `message_end` clears it). If the explorer is
killed — by either timer or by abort — while a buffer is open and no complete final report
exists, `finalize` returns the buffer as `report` with `partial: true`, `ok: false`, and an
error such as `Explorer timed out after 300s during turn 8 while writing its report (7 tool
turns completed); partial report salvaged`.

`synthesize` includes a partial report as `# Explorer: <brief> — PARTIAL (timed out while
writing; incomplete)`, re-anchored like any other, **and** lists it under `## Not Covered`
as partially covered. `hasFindings` counts a non-empty partial as findings, so auto-promotion
prefers a verified partial report plus the spill path over nothing. A `length` stop keeps
its current handling.

### 7. Failure text

When any explorer failed, `synthesize` appends one paragraph after `## Not Covered`:

> Do not repeat this explore call unchanged — the failure is not transient. Narrow `scope`,
> split the brief into a shorter `checklist`, or read the files named above directly.

`## Not Covered` lines now carry the turn count and the phase the explorer was in.

### 8. Explorer invocation

`buildExplorerArgs(cfg, model, promptPath, task)` takes
`model: { id: string; provider?: string } | null`. With a provider it emits
`--provider <p> --model <id>`; from `cfg.model` (a string) it emits `--model` only, so a user
can still write `provider/id` themselves. Two flags are added unconditionally:
`--no-skills --no-prompt-templates`. Context files (`AGENTS.md`) are still loaded.

### 9. Prompt: output length is wall-clock

The Speed section stops claiming turns are the only cost. New bullet: keep `## Key Code`
to the excerpts that matter — about six to ten blocks of at most twelve lines — because on a
slow provider the report turn alone can exceed the exploration.

### 10. Tests must not write to the real temp directory

334 `fx-matches-*.txt` files (500 bytes each) in `$TMPDIR` came from vitest runs.
`vitest.config.ts` gains `setupFiles: ["tests/setup.ts"]`, which points `TMPDIR` at a
per-worker `mkdtemp` directory and removes it after the file's tests.

## Config

New keys, validated like the rest: `idleTimeoutMs` (finite number > 0),
`escalateUnresolved` (boolean, default `true`). `timeoutMs` default changes; README table
updated.

## Testing

- `tests/checklist.test.ts` — parser shapes, index alignment, unresolved-by-omission,
  any-`[x]`-wins across reports, coverage formatting.
- `tests/explorer-run.test.ts` — idle kill with hard cap far away; continuous streaming past
  the idle window survives; hard cap kills a slow streamer; partial text salvaged with
  `partial: true`; abort mid-stream salvages too.
- `tests/explorer-stream.test.ts` — `message_update` handling.
- `tests/synthesis.test.ts` — partial section + Not Covered entry; retry guidance present
  only when something failed; `findUnmarkedFailures` still empty on partial text.
- `tests/explorer-args.test.ts` — provider flag, new flags, argv pin.
- `tests/index-task.test.ts` — brief construction with checklist and scope; escalation brief
  construction; escalation skipped when wave 1 produced nothing.
- `tests/prompt-contract.test.ts` — five sections; checklist example parses.
- `tests/config*.test.ts` — new keys and defaults.

## Rollout

Build, run the suite, install the local checkout into pi (replacing the registry package),
then exercise on three repositories through Herdr: DriftPaca (Flutter, 238 files),
claude-plus-plus (TypeScript, 27k files), claude-sqlite-plugin (TypeScript, 48 files). Record
wall-clock, tokens, cost, checklist coverage, and verifier statistics in
`docs/AUDIT-2026-09-12-multi-repo.md`.
