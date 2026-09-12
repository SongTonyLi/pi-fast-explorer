# pi-fast-explorer

An extension for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that moves broad code-reading off the main agent's context and onto parallel read-only subagents.

## What it does

When a pi agent needs to understand code spanning many files, it reads them one at a time into its own context — and every one of those tokens is then carried through every later turn of the session until compaction throws them away. The cost is not only the tokens: a context full of half-relevant file contents is also a context the model has to reason around. pi's per-call truncation bounds a single result but has no notion of how many results accumulate, and auto-compaction fires only near the end of the window, by which point the sweep has been paid for many times over.

fast-explorer fans that reading out to explorer subagents. Each explorer is a separate `pi` process with its own context window, restricted to `read`, `grep`, `find` and `ls`. The main agent gets back cited findings — `file:line`, plus verbatim excerpts of the code that matters — instead of the file contents. The explorer's own reading happens in a subprocess whose context is discarded when it exits, so it never enters your session at all.

Quoted excerpts are checked against the files on disk before they reach you. A correct quote carrying a wrong line number is re-anchored automatically; content the cited file does not contain is marked on the block rather than silently dropped or silently kept.

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

That is the convention pi's own examples use: extensions are auto-discovered from `~/.pi/agent/extensions/`, and a subdirectory there is loaded when it declares `pi.extensions` in its `package.json`, which this package does.

**Symlink the package root, not `dist/`.** The extension reads its explorer prompt from `../prompts/explorer.md`, relative to the file pi loaded it as — and pi does not consistently dereference a symlink before resolving that. A package-root symlink is correct either way, because `prompts/` sits next to `dist/` on both sides of the link. A symlink to `dist/` is not: the prompt path fails to resolve, and pi appends a missing prompt path to the system prompt as literal text rather than failing — so every explorer would run without its output contract and return unparseable reports, with nothing in the logs to say why.

To try it for a single session without installing anything globally, point `-e` at a checkout you have built:

```bash
pi -e /path/to/fast-explorer
```

To remove it: `rm ~/.pi/agent/extensions/fast-explorer`.

## How it triggers

### The `explore` tool

The model calls it when it knows a sweep is coming.

```ts
explore({
  question: string,      // what you need to find out
  checklist?: string[],  // specific things to locate or answer — see Checklists
  questions?: string[],  // sub-questions, one per explorer — NOT recommended, see below
  scope?: string,        // glob or directory to limit the search
  fanout?: number,       // lower the number of explorers for this call
})
```

**Omit `questions` and you get exactly one explorer**, working on `question` alone. There is no planner subagent that decomposes the question for you.

`scope` is appended to each brief as "Limit your search to: …" — an instruction to the explorer, not an enforced filter. `questions` is truncated to `maxFanout` entries, and `fanout` is clamped into `[1, maxFanout]`, so a call can only ever narrow the fan-out, never widen it past the configured ceiling.

The tool returns the concatenated explorer reports. Explorers that failed, timed out or produced nothing are listed by name under a `## Not Covered` heading rather than dropped, so the main agent can see which part of the tree is unverified. Explorer token usage and cost are reported back to pi, so they appear in session totals.

While an explorer is running, its tool calls stream into the `explore` tool row (Ctrl+O expands the full trace). A below-editor widget lists live explorers. `/explorers` opens a terminal selector over this session's running and recent explorers so you can pick one and read what it is doing. The inspector shows tool calls; checklist coverage is in the tool result, not the inspector.

### Checklists

When you know the specific things you need — files, call sites, values, decisions — pass them as `checklist`. Every explorer gets the whole list in its task text and is required to end its report with a `## Checklist` section: one line per item, `[x]` with a `file:line` when resolved, `[ ]` with what was searched when not. A `[x]` means answered with evidence, and a well-cited "this does not exist" counts as an answer; `[ ]` means the explorer could not determine it. The extension parses that section and appends a `## Checklist coverage` summary to the tool result, so the main agent sees at a glance which items are answered; the same verdicts are in the result's `details.checklist`.

Items the first explorer leaves unresolved are re-dispatched **once**, to up to `maxFanout` fresh explorers. Each is told what the first wave established — its resolved items and the files it retrieved — and is handed only the unresolved items, keeping their original numbers. This is the "explore once, fan out only for what is missing" design that fan-out's measured failure argued for: a second-wave explorer is filling gaps in a map it has been shown, not covering a slice blind. There is never a third wave; what the second leaves unresolved is reported as unresolved. Set `escalateUnresolved` to `false` for one wave only.

A checklist line's `[x]` is the explorer's own claim. The `file:line` on it is not re-verified — only fenced excerpts under `## Key Code` are checked against disk — so treat a resolved item as a pointer to go and read, and the quote next to it as the evidence.

### Auto-promotion

A `tool_result` hook watches successful `grep`, `find` and `bash` results and converts sweeps into parallel exploration without being asked. Note that a default `pi` session enables only `read`, `bash`, `edit` and `write` — `grep`, `find` and `ls` exist but are off unless you pass `--tools` — so for most sessions the `bash` trigger is the one that fires. This path matters more in practice than the tool does, because the common failure is the model *not* knowing a sweep was coming.

It promotes when the result looks like a sweep **and** there is enough material to be worth the overhead — two separate gates:

- **Is it a sweep?** At least `autoPromote.minFiles` distinct matched files (breadth), or at least `autoPromote.minMatches` total matches across at least 3 files (density). The 3-file floor keeps one file with a thousand matches treated as the narrow search it is.
- **Is it worth it?** The matched files' sizes must total at least `minTotalBytes`. Below that floor, letting the main agent read them directly is both faster and higher fidelity.

Shell results must additionally *look like this repository*: the output has to parse as `path:line:text`, nearly all the parsed paths must resolve to real files, and a sample of the cited lines is read back off disk and compared against the files' real content. That second check is what stops compiler and linter diagnostics — which also emit `path:line: message` about real files — from being promoted as though they were searches. Detection is by output shape throughout; nothing here parses commands, so nothing rots when a tool rewords its output or someone uses a grep clone this extension has never heard of.

When both gates pass, the matched paths are bucketed by directory, one explorer runs per bucket, the raw search text is written to a spill file in the OS temp directory with mode `0600`, and the tool result the model sees is replaced by the synthesized findings followed by the spill path. **If every explorer failed, the hook returns nothing and your original search result is left exactly as it was** — whatever went wrong, the worst case is that you paid for explorers and still got your grep output, rather than paying for explorers and losing it.

Auto-promotion is a trade, not a free win: a grep the model intended as a quick existence check becomes several seconds of exploration and a model call per bucket. Set `autoPromote.enabled` to `false` to keep only the explicit `explore` tool, or `autoPromote.bash` to `false` to keep the hook for the structured tools only.

### `questions` is measured, and not recommended

Fan-out was benchmarked against a single explorer and it lost, twice over. On questions one explorer already covers, four explorers cost substantially more for identical recall and consistently *worse* precision — four explorers cite more files and dilute the ones that matter. On a question built specifically to be the case fan-out exists for, with an answer genuinely spanning separable subsystems and hand-written sub-questions aimed at each, fan-out cost more than a single explorer and **found less**, repeatedly missing a ground-truth file that one of its own sub-questions pointed squarely at.

The diagnosis is partition blindness, measured rather than predicted: each explorer covers its slice and stops, so the connective tissue between subsystems is exactly what falls through. The concurrency pool is not at fault — it measured near its theoretical ceiling.

So there is currently **no measured case in which `questions` pays**, and the tool description, the `promptGuidelines` and the parameter description all say so. The path is kept rather than removed, because one separable question is thin evidence for deleting tested, working code and the same machinery is what a sequential-escalation design would run on — but it is not recommended anywhere, and a call that supplies `questions` is a bet against the only measurement there is.

## Read-only guarantee

Explorers are spawned with `--tools read,grep,find,ls`. `bash` is absent, as are `edit` and `write`. This is structural, not prompt-level: an explorer cannot modify the repository or run a command regardless of what its briefing says, what a file it reads tells it to do, or how it is prompt-injected. The capability cost is low, because pi's `grep` is ripgrep-backed and needs no shell.

That is a guarantee about *capability*, not about output. An explorer's prose reaches the main agent unverified; only quoted code is checked against disk.

Explorers also run with `--no-extensions`, backed up by a `PI_FAST_EXPLORER_NESTED` environment guard. **Do not remove either.** Without them each explorer loads this extension, its own searches trip the auto-promotion hook, and each of those spawns another wave — the failure mode is a fork bomb. Neither `-p` nor `--no-session` stops extension discovery; `--no-extensions` is what does, and the environment guard covers the explicit `-e` loads it cannot reach.

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
  "timeoutMs": 300000,
  "idleTimeoutMs": 60000,
  "escalateUnresolved": true
}
```

| Key | Meaning |
|---|---|
| `model` | Model id for explorers. `null` inherits the dispatching session's model, which is the default because a weaker model deciding what matters in unfamiliar code is the largest quality risk here. Setting it to a cheaper model is where the cost saving lives. |
| `thinking` | Thinking level passed to each explorer (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Off by default even when the model is inherited: retrieval is not reasoning, and per-turn latency dominates wall-clock. |
| `maxFanout` | Maximum explorers per call. Must not exceed `concurrency`. |
| `concurrency` | Ceiling on explorers running at once, extension-wide. |
| `maxTurnsPerExplorer` | Turn budget written into each explorer's task text. pi has no turn-limit flag, so this is **advisory** — an explorer can and sometimes does exceed it, and nothing here prevents that. It was lowered once and raised back after a lower budget was measured turning successful runs into failures; lowering it again was tried against fresh measurement and bought nothing. The pressure to finish fast lives in `prompts/explorer.md`. |
| `minTotalBytes` | Byte floor below which exploration is skipped and the original result is left alone. |
| `autoPromote.enabled` | Turns the whole `tool_result` hook off without affecting the `explore` tool. |
| `autoPromote.bash` | Whether `bash` results that parse as search output are promoted too. Separate from `enabled` because the risk profile differs: a `grep` result is a search by construction, while a `bash` result is whatever the model ran, so promoting it rests on inferring intent from output shape. |
| `autoPromote.minFiles` | Breadth threshold — distinct matched files. |
| `autoPromote.minMatches` | Density threshold — total matches, requires at least 3 files. |
| `timeoutMs` | Hard wall-clock cap per explorer. The backstop, not the working deadline: it was 120 s and was measured killing a healthy explorer that had finished reading and was 123 s into writing its report. On expiry the child gets `SIGTERM`, then `SIGKILL` after a grace period. |
| `idleTimeoutMs` | Kill an explorer that has produced no output for this long. pi streams a `message_update` per token, so a live explorer is never silent for long; silence is a stalled provider call or a hung process, and that is what a deadline should catch. |
| `escalateUnresolved` | Whether checklist items the first wave leaves unresolved are re-dispatched once. See Checklists. |

`maxFanout > concurrency` is rejected: fanning wider than the concurrency limit produces two waves and roughly doubles wall-clock for no benefit.

### How config is loaded

Config is read at every `session_start`, from two files, both optional, both containing the keys above at the top level (no wrapper key):

| Layer | Path | Read when |
|---|---|---|
| Defaults | — | always |
| User | `~/.pi/agent/fast-explorer.json` | always |
| Project | `<project>/.pi/fast-explorer.json` | **only when the project is trusted** |

Project overrides user; both override defaults. `autoPromote` merges key by key, so setting only `minFiles` in one layer leaves `enabled` and `minMatches` from the layer below.

**Why the project file is trust-gated.** `<project>/.pi/fast-explorer.json` lives inside the repository, so in a freshly cloned, untrusted checkout it is attacker-controlled content. `model` would redirect every explorer to a model of the repository's choosing, and `timeoutMs` could stall the session — neither with any prompt to the user. The project layer is therefore skipped entirely until you trust the project. The user file is always read.

**Invalid config is reported and ignored, not silently replaced.** Unknown keys, wrong types and out-of-range values fail the whole load with a message naming the file and the key; the previously resolved config stays in effect. A typo does not end the session, and it does not quietly reset your settings to the defaults either.

## When not to use it

- **Fewer than a handful of files.** Each explorer pays a fixed cost — process spawn, system prompt, tool definitions, `AGENTS.md` — and over-fanning a small job is pure loss.
- **Under the byte floor.** Below `minTotalBytes` of candidate files, reading directly is faster and loses nothing.
- **You already know the exact file and line.** Read it.
- **Edit-heavy work.** Explorers cannot edit. Exploration that only precedes a one-line change was probably not worth a subprocess.
- **Interactive debugging.** When you need to iterate against real output, a summarized index of the code is the wrong shape, and explorers have no `bash` to reproduce anything with.

## What it trades

**It is slower and costlier per sweep than letting the main agent read the files itself, and it does not make the agent faster.** That is measured, not estimated. Making the main agent faster was an explicit goal of the original design, with a falsifiable acceptance test attached; the test was run, it failed, and the goal was retired rather than restated more weakly. Across every benchmark sweep the unaided baseline was faster at the median on every question, in both explorer configurations. The penalty is per *turn* rather than per run — an explorer takes about as many turns as the baseline and each turn costs more, because the explorer prompt asks for many concurrent searches and a structured, cited report — so no turn budget reaches it.

**What you buy with that is context.** The latency and the cost are paid once, at the moment of the sweep. The tokens are paid on every turn after it: a baseline sweep leaves the file contents it read in the main agent's context, to be re-sent with every subsequent request until compaction throws them away — and that compaction is itself a multi-second synchronous stall you have brought forward. An explorer report is a small fraction of that, and it is all the main agent ever carries. The reduction was measured at more than an order of magnitude on every question, by a margin far wider than the acceptance criterion asked for, and it is the only effect here large enough to clear the run-to-run noise by that much.

**You also get more consistent recall on focused questions**, where an unaided baseline's results swung run to run and a single explorer's were reliably at ceiling — plus citations that are mechanically verified before they reach you. Precision goes the other way: an explorer cites more files than it strictly needs to, because it is asked to over-report rather than under-report, so you will read some citations that turn out not to matter.

**The recall advantage does not extend to broad questions.** On the one benchmark question whose answer spans several subsystems, the unaided baseline matched a single explorer exactly, while being faster and cheaper. The extension bought nothing there except a smaller context and citations.

So: if your sessions are short and latency is what you feel, this is a bad trade. If they are long and the context window is what runs out first, it is a good one.

## Limitations

The ones you are most likely to hit. The full list, with the mechanism and the evidence behind each, is in [the limitations audit](docs/LIMITATIONS-AUDIT.md).

- **It does not make the agent faster.** See above. This was a goal, it was tested, and it failed.
- **`questions` / fan-out is not recommended.** It cost more and found no more, including on the case built to favour it.
- **Partition blindness.** Splitting work across explorers cuts cross-file relationships: one explorer sees the caller, another the callee, and neither notices that they disagree. Directory-grouped bucketing reduces it; no partition scheme eliminates it. The `## Architecture` and `## Not Covered` sections of each report are a mitigation, not a fix.
- **Recall is a median, not a guarantee.** Parallel LLM calls give different answers across runs. A single `explore` call is a sample, not a measurement.
- **Quote verification is looser on comments than on code.** It is deliberately indentation-insensitive, and comment-only quotes can survive edits that a code quote would not. Trust a code excerpt's verification more than a prose one's.
- **Verification only covers blocks the parser can see.** A quote inside a fence the model never closed is marked `UNCHECKED` rather than silently passed — but it is not verified either. Everything measured about contract compliance is a property of one model on a TypeScript corpus.
- **The turn budget is advisory.** pi exposes no turn-limit flag, so `maxTurnsPerExplorer` is a sentence in the task text, not a mechanism. Explorers exceed it. The only hard stops are `idleTimeoutMs`, `timeoutMs` and the model's own context limit.
- **Explorers inherit the repository's `AGENTS.md`.** Skills and prompt templates are not loaded (`--no-skills --no-prompt-templates`), but context files are, and pi loads them regardless of project trust — so in an untrusted clone the repository's own instructions are in every explorer's system prompt.
- **`concurrency` is an extension-wide ceiling, not a per-call one.** Both entry paths draw on the same budget, so a batch of promotable searches serializes rather than running wide.
- **A report cut off by a deadline is delivered as partial, not dropped.** If an explorer is killed while writing, the text it had streamed is verified like any other report and delivered under a heading marked PARTIAL, and the same area is listed under `## Not Covered` as partially covered. Only text that has reached a `##` section is salvaged; mid-sentence narration is not.
- **Checklist verdicts are the explorer's own.** The `file:line` on a `[x]` line is not re-anchored; only fenced excerpts are. See Checklists.
- **Spill files are never deleted.** A long session leaves a trail of `fx-matches-*.txt` in the OS temp directory, because the model may still want to read one at any later point.
- **In headless mode, config warnings are invisible.** `ctx.ui.notify` is a no-op with no UI (`--mode json`, `-p`), so an invalid config file is ignored silently — in exactly the contexts where nobody is watching. It still fails safe.
- **Signals reach only the direct child.** Timeout and abort signal the spawned `pi` process; grandchildren it started are not signalled.
- **Windows is unverified.** Nobody has run this on Windows, and there is a specific reason to think it may not work there at all — explorers are spawned with `shell: false` against what npm installs as a `pi.cmd` shim. See the audit.
- **Auto-promotion has run end to end once per path and is not benchmarked.** The seam is exercised and unit-tested on both sides, but nobody has scored a promoted result the way the benchmark scored `explore`.
- **One model, one corpus.** Everything measured here used a single model against a single private repository. None of it should be assumed to transfer.

## Measurements, and why there are no numbers here

Every claim above about speed, context, recall and precision came out of a benchmark suite that ran three arms — an unaided baseline, one explorer, and four explorers on hand-written sub-questions — against a real codebase, several runs per question, scored against ground-truth file sets established by exhaustive search rather than by running this extension.

**Neither the harness nor its result artifacts are published.** Every sweep ran against a private third-party repository: the harness names files and symbols from that corpus, and the artifacts quote its source. There is no benchmark command in this repository and no way to reproduce any of it from a clone. Because a figure nobody can check is worth less than a plain statement of what was found, this README gives the findings and leaves out the numbers.

The numbers are kept, each with the run and field it came from, in two internal records — both of which state plainly that their own sources are unpublished:

- [**The design spec**](docs/superpowers/specs/2026-09-10-fast-explorer-design.md) — the design and the reasoning, the measurements in full, and the goals that were falsified and retired rather than quietly dropped.
- [**The limitations audit**](docs/LIMITATIONS-AUDIT.md) — a claim-by-claim check of which published figure matched which artifact, including the ones that did not, plus the complete limitations list.

One finding is worth surfacing even without its numbers. Five consecutive sweeps agreed with each other on the latency result and were internally consistent; a sixth, differing only in interleaving the arms instead of running them in per-question blocks, moved the result substantially — and against the extension. Every latency ratio published before that was **withdrawn rather than superseded**, because a confound that is possible and uncontrolled invalidates a measurement whether or not it can be shown to have been active. Cross-run consistency is evidence that a harness is deterministic. It is not evidence that the harness is measuring the thing named in the column header.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest (489 tests)
npm run typecheck:tests
```

Unit tests cover the gates and the helpers. Nothing in this repository measures whether exploration is any *good* — that was the benchmark's job, and the benchmark is not here.

## License

MIT
