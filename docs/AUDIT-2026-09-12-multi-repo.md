# Field audit — pi-fast-explorer on three repositories

**Date:** 2026-09-12 · **Branch:** `feat/checklist-explore` (from `main` @ `4eeef25`) · **pi:** 0.85.1 · **Node:** v22.22.2 (darwin 25.6.0)
**Main-agent model:** `openrouter/deepseek-v4.1-flash`, thinking `high` · **Explorers:** same model, thinking `off` (inherited)
**Harness:** each repository was driven through a real interactive `pi` session in a Herdr pane; every number below was read from the session file on disk (`~/.pi/agent/sessions/<repo>/*.jsonl`) with a small analyzer, and every citation was checked against ground truth established by exhaustive `git grep` before the run.

This is an audit *and* a fix pass: findings marked **Fixed** landed on this branch, with the commit named. Findings marked **Open** did not.

## 0. Headlines

1. **The 120 s deadline was killing healthy explorers while they wrote their report.** On the first run, one explorer spent 43 s over seven tool turns reading the right files and was then killed 120 s into an eighth turn that was generating the report. Reproduced by hand with no deadline: the same brief finished in 166 s with 8/8 ground-truth files, 0 fabricated quotes and 2 line anchors corrected. The extension returned "every explorer failed". **Fixed** — idle-based deadline, 300 s hard cap, partial-report salvage (`c7babf4`, `142a560`).
2. **The main agent, told every explorer failed, retried the identical call.** Its thinking, verbatim: "I did that before and it timed out. I should just call it again." Twice the spend for nothing. **Fixed** — retry guidance in the failure text (`142a560`).
3. **In a default `pi` session there is no `grep`, `find` or `ls` tool.** `agent-session.js:2210` enables `["read", "bash", "edit", "write"]` unless `--tools` is passed. Asked to "use the grep tool", the main agent replied that no such tool exists. So the `grep`/`find` auto-promotion paths never fire for a default user; the `bash` path is the one that carries the feature. **Open** — documented in the README on this branch; the hooks themselves are correct when the tools are enabled.
4. **Checklist exploration works, and the escalation wave works.** Three repositories, four checklists, 28 of 29 items answered correctly, 0 fabricated quotes across 5 checklist runs, and the one escalation wave that fired re-dispatched exactly the two items the first explorer could not resolve — both of which were genuinely absent from the repository. **New** (`f5058b3`, `39bb9c3`).

## 1. Runs

| # | repo (tracked src files) | call | explorers | turns | wall | tokens | cost | outcome |
|---|---|---|---|---|---|---|---|---|
| 1 | DriftPaca (238 Dart) | `explore` question, v0.1.0 as shipped | 1 | 6 | 120 s (killed) | 34.7k | $0.0059 | 0 findings; main agent retried: 7 turns, 120 s, $0.0074, 0 findings |
| 1b | same brief, run by hand, no deadline | 1 | 8 | 166 s (43 s tools + 123 s report) | ~17k/turn | $0.0050 | 8/8 files, 0 fabricated, 2 corrected |
| 2 | DriftPaca | `explore` + 8-item checklist | 1 | 6 | 108 s | 31.5k | $0.0065 | 8/8 resolved, all correct; 0 fabricated, 3 corrected |
| 3 | DriftPaca | `bash: grep -rn "setState(" lib/` (19 files, 431 KB) → auto-promoted | 3 | — | 121 s | 84.1k | $0.0179 | 19/19 files cited, precision 1.00; 1 quote UNVERIFIED |
| 4 | claude-sqlite-plugin (48 files) | `explore` + 8-item checklist | 1 | 6 | 120 s | 28.7k | $0.0058 | 8/8 resolved, all correct; 0 fabricated, 0 corrected |
| 5 | claude-plus-plus (2,124 TS in `src/`, 30 MB) | `explore` + 8-item checklist | 1 | 6 | 182 s | 48.7k | $0.0089 | 8/8 resolved, all correct; 0 fabricated, 2 corrected |
| 6 | claude-plus-plus | `explore` + 5-item checklist, 2 items known not to exist | 1 + 2 (escalation) | 7 / 6 / 5 | 65 s | 112.5k | $0.0202 | 4/5; both unresolved items correctly reported absent; 0 fabricated |
| 7 | claude-plus-plus | `bash: grep -rn "dashboard" src/` (24 files, 943 KB) → auto-promoted | 3 | — | 29 s | 77.1k | $0.0170 | 24/24 files cited, precision 1.00; no markers |

"tokens" is the explorer usage the extension reported back to pi (input + output, cache reads excluded); "wall" is tool-call to tool-result in the session file. Run 1 used the registry package 0.1.0 (byte-identical to `main` at the time); runs 2–7 used this branch, built and installed from the local checkout.

### Per-turn anatomy of run 1b

| turn | what | elapsed |
|---|---|---|
| 1–7 | 18 tool calls (2–3 per turn: `ls`, `grep`, `read`, `find`), 4–8 s each | 43 s total |
| 8 | the report: 567 input tokens, **1,606 output tokens, 123 s** | 123 s |

The exploration is not the slow part. Output generation on this provider route ran at roughly 13 tokens/s, so the report turn alone exceeded the old cap. `prompts/explorer.md` said "wall-clock is set by how many turns you take, not how much you read"; for this model that was false, and the prompt now says so and asks for a tighter `## Key Code` section (`f5058b3`).

## 2. Findings

### 2.1 Deadline measured the wrong thing — **Fixed**

`timeoutMs` was a wall-clock cap of 120 s applied from spawn. Run 1 shows it firing on an explorer that was streaming its answer. pi's JSON mode emits a `message_update` per text delta (2,253 of them in run 1b), so a live explorer is never silent for long. The deadline is now two timers: `idleTimeoutMs` (60 s, reset on every stdout/stderr chunk) catches a stalled provider call or a hung process; `timeoutMs` (300 s) is the backstop. Error text names which fired and the turn it fired in.

### 2.2 A half-written report was thrown away — **Fixed**

`extractFinalText` only read `message_end` messages, so the streamed text of an in-progress report was lost on kill. `processLine` now accumulates `text_start`/`text_delta`/`text_end` into `Accumulator.streaming`; on timeout or abort, if no complete report exists and the streamed text contains a `## ` section, it is returned with `partial: true`. `synthesize` delivers it under `# Explorer: … — PARTIAL (killed while writing; incomplete)`, re-anchored like any other report, and also lists it under `## Not Covered` as partially covered. `hasFindings` counts a non-empty partial, so auto-promotion prefers a verified partial report plus the spill path over nothing. Narration without a section is not salvaged (`tests/explorer-run.test.ts`, "does not salvage streamed narration").

### 2.3 Failure text invited a retry — **Fixed**

Run 1, second call: the model's recorded reasoning was that it should simply call again. `synthesize` now appends, whenever anything failed: *Do not repeat this explore call unchanged — the failure is not transient. Narrow `scope`, split the brief into a shorter `checklist`, or read the files named above directly.* `## Not Covered` lines carry the turn and phase (`timed out after 300s while writing its report (turn 8); partial report salvaged`).

### 2.4 Default pi sessions have no `grep`/`find`/`ls` — **Open, documented**

`dist/core/agent-session.js:2210`: the default toolbelt is `read, bash, edit, write`. The README's auto-promotion section describes three triggers as peers; for a default user only `bash` exists. The 2026-09-11 audit recorded the model "bypassing the hook with bash" and attributed it to model preference — the tool was not there to prefer. The README now says so. Nothing in the hook needs to change; the `grep`/`find` paths are correct when those tools are enabled, and the `bash` path promoted correctly on both repositories it was tried on (runs 3 and 7).

### 2.5 Explorers were not pinned to the session's provider — **Fixed**

`--model <id>` alone was passed. `deepseek/deepseek-v4.1-flash` is served by openrouter and by deepseek directly; pi's resolver happened to pick the configured provider here, but a bare id is ambiguous by construction. `resolveExplorerModel` now carries `ctx.model.provider` and `buildExplorerArgs` emits `--provider <p> --model <id>` for an inherited model; a configured `model` string is passed as written (`bdefbe3`).

### 2.6 Explorers loaded eleven user skills and every prompt template — **Fixed**

Known from the previous audit (2.6). This machine has 11 global skills; each explorer's system prompt carried all of them. `--no-skills --no-prompt-templates` are now passed. Context files (`AGENTS.md`) are still loaded on purpose; DriftPaca's is about installing on an iPhone, which is dead weight, but a repository's conventions are usually worth an explorer's while and the trust question is already documented.

### 2.7 The test suite wrote to the real temp directory — **Fixed**

334 `fx-matches-*.txt` files (500 bytes each) were in `$TMPDIR` before this session started, 42 more after four local test runs. `tests/setup.ts` points `TMPDIR` at a per-worker `mkdtemp` and removes it. Verified: 376 files before the isolated run, 376 after. The three field runs that promoted added three spill files (7.5 KB, 8.5 KB, 0.5 KB); those are by design.

### 2.8 Checklist: what was built, and what the runs showed — **New**

`explore({ question, checklist: [...] })`. Every explorer gets the numbered list in its task text and must end with a `## Checklist` section of `[x]`/`[ ]` lines. `src/checklist.ts` parses it (by shape, like `citations.ts`), matches lines to items by echoed text first and by number otherwise, and any `[x]` across reports wins. The tool result gains a `## Checklist coverage` section and `details.checklist`. Unresolved items are re-dispatched once, round-robin over at most `maxFanout` explorers, each told what the first wave established (its resolved lines and its `## Files Retrieved` entries). There is never a third wave.

Observed across runs 2, 4, 5, 6:

- Four single-explorer checklists of 8, 8, 8 and 5 items: 29 of 29 verdicts were correct against ground truth, counting the two "does not exist" items in run 6 as correctly unresolved. Repository size (48 files to 2,124) did not change the turn count: 6, 6, 6, 7.
- The explorer paraphrases the item before answering ("File path where agent events are persisted on disk — src/…" for "The file path where…"), so text matching fell through to index matching every time; both keys are needed. The paraphrase is now stripped from the note when it is made mostly of the item's words (`39bb9c3`).
- In run 6, the wave-2 explorer for item 3 marked it `[x]` while proving the negative with five citations, and the wave-1 explorer marked item 5 `[ ]` while proving the same kind of negative. The prompt did not define which was right. It now does: `[x]` is "answered with evidence, including evidence that the thing does not exist"; `[ ]` is "could not determine". Under that rule a well-cited negative is not re-dispatched, which is the cheaper and more useful behaviour.
- The escalation wave's two explorers were dispatched in parallel and the whole two-wave call took 65 s — faster than several single-wave runs, which says more about provider variance than about the design. Cost was $0.020, the highest of any `explore` call here.
- A checklist line's `file:line` is not re-anchored; only fenced excerpts are. Every checklist citation in these runs was spot-checked by hand and was right, but that is a property of this model, not of the verifier. Recorded in the README as a limitation.

### 2.9 Auto-promotion output is larger than what it replaces — **Open, measured**

Run 3: the raw `grep -rn` output was 7,486 bytes; the promoted result was 24,177 characters. Run 7: 8,453 bytes became 21,089. The previous audit predicted this (2.13). The direct effect on the main agent's context is negative every time; the benefit is entirely counterfactual (the main agent not then reading 431 KB or 943 KB of matched files), and that counterfactual is still unmeasured. On a slow provider it has a second cost: asked to echo run 3's result back, the main agent spent 3.5 minutes generating 24 KB. A compact mode — `## Files Retrieved` plus `## Checklist` only, excerpts on request — would make the direct effect positive; not built.

### 2.10 Explorers open with narration — **Open, cosmetic**

Every one of the seven explorer reports began with "I have everything needed." before `## Files Retrieved`, against a prompt that says "Respond with exactly these sections and nothing else." Harmless to the parsers, wasteful in the main agent's context, and it lands under the `# Explorer:` heading. `synthesize` could drop text before the first `## `; not done, because a report with no sections at all would then vanish and the previous audit's 2.5 already covers that failure.

### 2.11 Bucket labels named one directory for a bucket spanning several — **Fixed**

Run 7: "8 files under src/memdir" headed a report whose files were mostly in `src/services`. Buckets are bin-packed by directory group and routinely mix. `describeBucket` now lists up to three directories (`ec5c1e9`).

### 2.12 Citation fidelity, this model, three languages — **Measured**

Across seven explorer reports on Dart, TypeScript and SQL: 1 quote marked UNVERIFIED (run 3, `lib/Widgets/memory_bottom_sheet.dart:132`, two field declarations that are not at that line or anywhere in the file), 7 anchors silently corrected, 0 misattributed, 0 unparsed. The verifier caught the one fabrication and labelled it in the delivered text. The previous audit's numbers were one model on TypeScript; this is a second model and it held up on Dart and SQL as well as TypeScript, which is the first evidence the widened header set (`--` for SQL) does its job in the field.

### 2.13 Smaller notes

| | finding | status |
|---|---|---|
| a | `pi install /path` records `../../fast-explorer` in `~/.pi/agent/settings.json` and loads the checkout directly; `npm run build` is the whole update path now. The registry package was removed. | done, this machine |
| b | Explorer processes do not show `--mode json` in `ps` on macOS, and `pgrep -f` matches the sampling shell's own command line. Process-count monitoring was abandoned; the session file's `details.live` and per-explorer `usage.turns` are the reliable record. | note |
| c | `herdr agent prompt --wait` returned "done" immediately when the previous turn was already done and the new prompt had not yet produced activity; `agent wait` after a non-blocking prompt behaves the same. Poll the session file instead. | note |
| d | The main agent, asked to reply with a 24 KB tool result verbatim, took 3.5 min. Not the extension's defect; evidence for 2.9. | note |

## 3. Fixes on this branch

| commit | change |
|---|---|
| `d9a0627` | design spec |
| `bdefbe3` | `--provider` from the session model; `--no-skills --no-prompt-templates` |
| `c7babf4` | idle deadline + hard cap; streaming buffer; partial salvage; `timeoutMs` 300 s, `idleTimeoutMs` 60 s |
| `142a560` | partial reports delivered as marked findings; retry guidance; phase in `## Not Covered` |
| `f5058b3` | `checklist` parameter, prompt section, parser, coverage, one escalation wave; prompt asks for tighter `## Key Code` |
| `1e2a0d4` | tests isolated from the real temp directory |
| `549af34` | README; version 0.2.0 |
| `39bb9c3` | `[x]` defined as answered-with-evidence; paraphrase stripped from notes |
| `ec5c1e9` | bucket labels name every directory |

State: 499 tests across 23 files, `tsc` and `typecheck:tests` clean, `dist/` built from `ec5c1e9` and loaded by pi from `/Users/songli/fast-explorer`.

## 3b. Independent review of this branch

The diff was reviewed by a separate agent that executed the branch's `dist/` to reproduce each claim. It confirmed the suite and typechecks and found three defects that mattered, all fixed in the last commit on the branch:

1. **The salvage gate did not fire in the field scenario.** It was keyed on "no final text", but pi's tool turns carry narration text beside their tool calls ("Let me grep for the config keys." was the last complete text in run 1), so the gate never passed. The test stub had omitted the narration. Gate is now keyed on shape — streamed text is a report and the last complete text is not — and the stub carries narration.
2. **Checklist matching scanned the whole line**, so one item's answer, which naturally mentions related items, could claim another item as resolved — and a wrongly resolved item is never escalated. Matching is now anchored at the start of the line, where the contract puts the item.
3. **Coverage was computed from reports `synthesize` discards** (output cap, error stop), producing "no findings" next to "2/2 resolved". Coverage now uses exactly the reports the caller receives.

Also fixed from the review: deadlines could fire during the one-second post-exit drain and relabel a complete report as stalled; a user abort during a promoted sweep could replace the grep result with a salvaged fragment (the abort now leaves the original result, and a partial must carry a citation or quote to count at all); retry guidance written for `explore` was emitted on the auto-promotion path; `idleTimeoutMs: 0` was accepted and killed every explorer silently; a second-wave explorer's positional lines could land on item 1; the checklist was uncapped; the README still said skills were inherited. Final state: 499 tests, typechecks clean.

## 4. Open recommendations, in order

1. **Compact promotion output** (2.9). The one measured cost that is negative on every run.
2. **Re-anchor checklist citations** (2.8). `file:line` on a `[x]` line should go through the same verifier as a fence header; today it is trusted.
3. **Strip leading narration** (2.10), guarded by "only if a `## ` section follows".
4. **Measure the counterfactual** — what the main agent does with the raw match list when not promoted — before claiming the context win on the `bash` path. Runs 3 and 7 give the two inputs; the unpromoted arm was never run.
5. **Decide what `grep`/`find` promotion is for** given 2.4: either document `--tools read,grep,find,ls,bash,edit,write` as the recommended session toolbelt, or accept that `bash` is the product.

## 5. Reproducing

Session files: `~/.pi/agent/sessions/--Users-songli-DriftPaca--/2026-09-12T14-39-59-*.jsonl` (run 1), `…T15-18-24-*.jsonl` (runs 2–3), `--Users-songli-claude-sqlite-plugin--/2026-09-12T15-33-16-*.jsonl` (run 4), `--Users-songli-claude-plus-plus--/2026-09-12T15-36-30-*.jsonl` (runs 5–7). The by-hand run 1b is in `~/.claude/jobs/477c4df2/tmp/explorer-q1.ndjson` with per-line timestamps. The analyzer that produced the table reads a session file and calls `dist/citations.js` on every `details.results[].report`; it is not part of this repository.
