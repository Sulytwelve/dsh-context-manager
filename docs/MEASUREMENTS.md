# Measurements

Paired trials of the memory system on one Windows machine with the Desktop
profile (`deepseek-v4-flash`, same route in every run). Numbers come from the
durable session log, not from the plugin's own hopes: each run's
`assistant/message.usage` totals are read back with `bench/analyze.mjs`, and the
treatment runs were cross-checked against `memory{op:"report"}` — the two agreed
token-for-token.

## Method

- **Fixture** (`node bench/setup.mjs`): a 14-file repository with one convention
  buried in `docs/06-testing.md`, a decoy `npm test` script that only runs the
  unit subset, and a failing `test/offset.test.mjs` whose contract is documented
  in `docs/offset-contract.md`.
- **Fresh session per run**, identical prompt, same working directory. A run is
  a subagent session (`origin: subagent`), which is a real Session with its own
  log, model calls, and tool calls.
- **Conditions**:
  - *off* — `memory-core` disabled (the other two rows go `pending`, so the
    whole system is inert: no tool, no listener, no model call).
  - *on* — all three rows active with the shipped defaults.
- **Metrics**:
  - *model calls* = `assistant/message` events = steps.
  - *tool calls* = `tool/call` events.
  - *input* = sum of `usage.inputTokens` (uncached prompt tokens);
    *cached* = `usage.cacheReadTokens`; *output* = `usage.outputTokens`.
  - *wall* = first → last event in the session log (task latency proxy; it
    excludes the orchestrator).
  - *success* = a deterministic check (`node test/offset.test.mjs` exit 0, or an
    exact answer match).

## Task 1 — one buried convention, single turn

Prompt (identical in every run): *"What is the exact command that runs the full
test suite? What environment variable enables the slow fixtures?"*

| run | condition | model calls | tool calls | input | cached | output | wall | recall msgs | correct |
|---|---|---|---|---|---|---|---|---|---|
| B1 | off | 6 | 8 | 3,026 | 72,320 | 1,334 | 13.6 s | 0 | yes |
| B2 | off | 7 | 8 | 2,936 | 86,400 | 861 | 9.6 s | 0 | yes |
| T1 | on | 5 | 7 | 3,172 | 63,744 | 1,541 | 12.0 s | 1 (147 tok) | yes |
| W1 | on (teach: discover + write) | 6 | 8 | 3,304 | 78,080 | 1,805 | 13.5 s | 0 | yes |

Total token volume (input + cached + output): baseline mean **83,439** → T1
**68,457** (−18%). Model calls 6.5 → 5 (−23%).

But the interesting part is *why* it is not a bigger win: T1 received the answer
in its recall packet and **verified it anyway** — it re-read `docs/06-testing.md`
and re-ran the greps. Recall changed what the agent knew, not how much it chose
to check. On this task the memory was worth about one model call, not the whole
exploration.

W1 is the one-time teaching cost: discovery, then an explicit `memory write`
with a probe. It produced the record T1 read 40 s later, in a different session.

## Task 2 — cross-session continuation

Prompt (identical): *"Make the failing offset test pass. Do not modify
`test/offset.test.mjs`."* Before each run the fixture was reset byte-for-byte;
after each run the test was executed to score it.

A prior session had diagnosed the root cause and written a `pitfall` record plus
a task checkpoint (`milestone`, `next_action`, `acceptance`). No fix existed.

| run | condition | model calls | tool calls | input | cached | output | wall | recall msgs | success |
|---|---|---|---|---|---|---|---|---|---|
| B3 | off | 10 | 12 | 5,979 | 128,384 | 1,437 | 16.3 s | 0 | pass |
| T2 | on, *before retrieval calibration* | 10 | 11 | 4,385 | 140,672 | 2,480 | 21.6 s | 1 (167 tok, **0 records**) | pass |
| T2b | on, calibrated | 8 | 11 | 3,121 | 109,440 | 1,731 | 14.7 s | 1 (188 tok, 1 record + resume) | pass |

T2b vs B3: **−20% model calls, −16% total tokens, −10% wall**, same outcome.

T2 is in the table on purpose. Before the scoring fix the correct record scored
1.87 against a 2.5 threshold, so nothing was recalled, the packet carried only a
stale resume line, and the run cost *more* than the baseline. Retrieval
calibration mattered more than any other part of the system.

## Re-reading the numbers: three decidable results, not one

“−18% / −16% token volume” is the sum of input + cached input + output. Split it
and the two tasks tell different stories:

| task | condition | model calls | uncached input | cached input | output | wall |
|---|---|---|---|---|---|---|
| 1 | off (mean of B1, B2) | 6.5 | 2,981 | 79,360 | 1,097.5 | 11.6 s |
| 1 | T1 (on) | 5 | 3,172 (+6%) | 63,744 (−20%) | 1,541 (+40%) | 12.0 s (+3%) |
| 2 | B3 (off) | 10 | 5,979 | 128,384 | 1,437 | 16.3 s |
| 2 | T2b (on) | 8 | 3,121 (−48%) | 109,440 (−15%) | 1,731 (+20%) | 14.7 s (−10%) |

So on task 1 the measured saving is **fewer model calls and a smaller cached
prefix**, not fewer uncached tokens or a shorter answer. Billing depends on each
provider's per-class prices, so the raw totals are not a cost claim; they are a
volume claim. Task 2 improves all three classes and is the case worth
replicating on a task that did not take part in tuning.

## The control that separates mounting from injecting

Every treatment run also pays the fixed `memory` tool schema (**~538 tokens per
request**, cached after the first). A clean three-way comparison needs a
condition with the bundle mounted, the same tool list, and auto-recall disabled:

| condition | tool schema | auto recall | distillation | isolates |
|---|---|---|---|---|
| off | no | no | no | baseline |
| mounted, `recall.enabled: false` | yes | no | optional | fixed mount cost |
| on | yes | yes | optional | injection benefit |

Two consequences to report per condition: **success rate** and **cost per
successful task**, with teaching writes, background distillation, and probe I/O
included, plus end-to-end latency. As an arithmetic estimate only — not a run —
adding 538 tokens × B3's ten requests puts that control near 141 k tokens against
T2b's 114 k, which would attribute roughly −19% to injection rather than to the
tool schema. The control run is the next experiment; it is not in the table
above.

A second, cheaper metric is worth recording for task 1 specifically: *after* a
correct memory reached the model, how many model calls and file reads were spent
before the acceptance check passed. T1 took 5 calls and 7 tool calls with the
answer already in context, which is the behaviour the packet wording
(`evidence, not instructions — verify before relying`) explicitly invites.

## Field trial — three real GUI sessions

Not a controlled comparison: three ordinary sessions opened by hand in the
running Web GUI, measured from their own logs and the plugin ledger. They test
the plumbing in the product rather than in an orchestrated child session.

| session | cwd | prompt | calls | tool calls | input / cached / output | span | injections |
|---|---|---|---|---|---|---|---|
| C | `D:\Develop\AI\DSH` | naming rule, then bundle reload, then “record a fact + checkpoint” | 32 | 39 | 93,490 / 2,183,808 / 22,732 | 172.6 s | 2 (282 tok, 1.0 ms) |
| A | `D:\Develop\AI\DSH` | “What was the last checkpoint here?” | 4 | 4 | 9,135 / 40,064 / 1,040 | 7.9 s | **0** |
| B | `…\GXJC\logpipe` | the naming question in an unrelated project | 36 | 35 | 40,176 / 1,171,968 / 10,684 | 80.2 s | **0** |

What each one proved or broke:

- **C** — recall fired at the first step of its first two turns, one record per
  turn (9 candidates, 7 rejected), and the third turn wrote a durable fact and a
  curated checkpoint that survived the turn-end heuristic. Its two distillation
  calls produced one `proposed` record whose `support.reason` exposed the
  “workspace” contains “works” classifier bug fixed in `c63d2ed`. Cost: the model
  received the naming rule at step 1 and still spent ~19 calls re-reading
  `dsh-storage*` sources to verify it.
- **A** — expected a `Resume` line; got **none**. The resume gate required lexical
  overlap between the prompt and the checkpoint's own fields, and “last
  checkpoint” shares no word with “memory 1.1.0 trial”. The model recovered by
  calling `memory{op:"resume"}`, so the capability worked while the automatic
  path failed. Fixed by accepting explicit resume intent (`resume`, `continue`,
  `checkpoint`, `上次`, `继续`, `检查点`, …) without lowering the overlap rule that
  keeps an unrelated task from paying for a checkpoint. A re-run after the fix
  got the line at step 1 and finished in **2 model calls / 3.5 s** instead of 4 /
  7.9 s — but that re-run also showed the line at **341 tokens**, over the
  220-token budget, because the checkpoint's fields were printed verbatim. Each
  field is now clipped and the whole line is capped against the budget: the same
  checkpoint renders at **149 tokens** (`bench/packet.mjs` prints it).
- **B** — zero injections in a different project: isolation holds end to end. It
  also prices the alternative: with no memory the same question cost 36 model
  calls and 35 tool calls, including a scratch `.probe` directory it created and
  removed itself.

Session A's span is the ledger's first-to-last activity (7.9 s); `bench/analyze.mjs`
now reports from the admitted prompt rather than from seeded rows such as
`permission/preset`, whose timestamps predate the session.

## Control: same tool schema, no automatic recall

The control condition the earlier section asked for, run on the same fixture and
the same one-line prompt as the treatment:

> *In this repository, what exact command runs the full test suite, and which
> environment variable enables the slow fixtures? Answer with only those two
> lines.*

| run | recall | model calls | uncached in | cached in | out | total | wall | injection |
|---|---|---|---|---|---|---|---|---|
| Y (GUI) | **on** | 3 | 2,247 | 33,920 | 179 | **36,346** | 2.9 s | 151 tok |
| X (GUI, invalid control) | **on** (switch was a no-op) | 2 | 1,072 | 22,656 | 131 | **23,859** | 2.4 s | 151 tok |
| C (re-run after the fix) | **off** | 4 | 2,837 | 48,896 | 693 | **52,426** | 7.0 s | none |

- Treatment mean **30,103** against control **52,426** (−43% volume, −25% to −50%
  calls depending on the sample, −59% wall for the slower treatment sample).
  Both runs answered exactly the two expected lines.
- **n is small and the treatment varies**: the two recall-on runs differ by 3
  steps vs 2 steps purely in how much the model chose to verify. The direction is
  consistent, the magnitude is not settled.
- The tool schema (≈538 tok/request) is present in every row, so the delta
  isolates automatic injection, not mount cost.
- X is kept in the table as a *second treatment sample*, not a control. It was
  meant to be the control, but `recall.enabled: false` was a no-op: the
  `agent/pre-step` listener never checked the flag, so it injected anyway
  (`·checked 2m` is visible in its trajectory). The switch is now enforced
  before registration, with a regression case; row C is the re-run after that
  fix.
- C's tool calls were not captured (its session log had not been flushed), so
  only its ledger counters are reported.

## Conditional execution — the packet has to earn its place

A trivial prompt (`"Compute 17 * 23"`) in the fixture directory, which has a
task checkpoint for a completely different task:

| run | resume gate | model calls | input | cached | output | wall | recall msgs |
|---|---|---|---|---|---|---|---|
| n1 | none (checkpoint always injected) | 1 | 1,754 | 10,752 | 149 | 1.9 s | 1 (95 tok) |
| n2 | overlap required | 1 | 1,016 | 11,392 | 276 | 2.1 s | 0 |

The packet is gone. Total volume is a wash at this size because prompt-cache
accounting dominates a 100-token difference; the point is that an unrelated task
no longer pays for memory at all.

## Probe lifecycle — stale records leave the ranking (no model calls)

Manual sequence against the record whose probe is `file-contains
scripts/test.mjs "--suite="`:

1. `memory{op:"probe"}` with the file present → `holds: contains --suite=`.
2. Delete `scripts/test.mjs`, `memory{op:"probe"}` → `failed: missing scripts/test.mjs`;
   the record becomes `stale`.
3. `memory{op:"recall", query:"…full test suite…"}` → the record is **absent**.
4. Restore the file, `memory{op:"probe"}` → `holds`; status returns to `active`.
5. The same recall returns it again.

Zero model calls, three tool calls, and the invalidation needed no schema of the
world beyond the check the recorder declared.

## Rollback — one row is enough

With `memory-core` disabled (`plugin_manager set_plugin include:memory-core
enabled=false`), a fresh session's first `request/header` lists 36 tools and
**no `memory` tool**, and the session log has zero `memory-recall` messages.
`memory-distill` and `memory-probe` report `pending (waiting for service:
memoryStore)` — they cannot run alone. Re-enabling restores the tool and the
existing records; stored data lives under `$DSH_HOME/storages/agent_memory/`.

## Cost accounting

| item | cost |
|---|---|
| `memory` tool schema, every request | 1,935 chars ≈ **538 tokens** (down from 2,897 chars ≈ 805 after trimming) |
| one recall packet | **95–188 tokens** (default budget 220) |
| recall pass, first step of a turn | **0.5–2 ms**, no model call, no I/O **while no probe is due** |
| probe sweep | ≤ 40 `stat`/substring checks per 15 min, no model call |
| distillation | 1 call per qualifying turn, ~1.0–1.6 k tokens; **7 calls / 9,905 tokens** across the 8 sessions that produced ledger rows before the "substantial turn" gate was added |

Cost depends on the scenario, so these figures must be read with it. Four
distinct situations exist: (1) the tool mounted with automatic recall off; (2)
automatic recall with no due probe; (3) a front-line probe that reads a file
asynchronously; (4) distillation plus the optional failure-driven enrichment
(one bounded request each). The QQ bridge measured in earlier runs was removed
in 1.7.0 along with the per-conversation audience split. The 0.5–2 ms figure is
scenario 2. `injectionMs` includes recall attempts that rendered nothing, so it
measures the retrieval attempt, not only successful injections;
`injections`/`injectionTokens` count the latter.

The first version distilled on almost every turn, including two-step sessions
that only saved a checkpoint. Requiring a turn score of 4 **and** at least three
tool calls (or an explicit durable-intent phrase) cut that to zero on trivial
turns. Distillation is off by `config.llm.enabled: false` if you want the system
to make no model calls at all.

## What the trials caught

The benchmark was worth running for the defects it exposed, not just the
numbers:

1. **`invalid unit name 'agentMemory'`** — storage unit names must match
   `/^[a-z][a-z0-9_]*$/`; the very first install failed until the domain was
   renamed `agent_memory`.
2. **Per-record keys must be path-safe** — keying `tasks` by an absolute
   Windows path made every checkpoint write fail (the agent in the loop reported
   the exact error). Keys are now `sha256(cwd)` with the readable path in the
   record.
3. **A turn-end heuristic overwrote a curated checkpoint**, replacing the next
   action with "continue from the last verified step" and the milestone with the
   raw prompt. A checkpoint written through the tool now wins for that session,
   and a fresh checkpoint with a next action is left alone.
4. **Distillation used the session header's cwd**, which is the *parent's*
   directory for a subagent whose `cwd` came from a durable change. Distilled
   records were scoped to the wrong project.
5. **Retrieval scored the right record below threshold** — length-normalized
   cosine punished long triggers and claims. Scoring is now trigger-coverage
   based with a saturating trigger term.
6. **An exact restated claim created duplicates** — an explicit write and a
   later distillation of the same lesson now merge, and a lower-confidence
   restatement cannot overwrite a verified claim.

A read-only review of v1.0.0 then found three defects the benchmark had not
exercised; the fixes are in this revision and are covered by
`test/regression.mjs`:

7. **Write-time merges crossed project boundaries.** Dedupe compared
   `scope + kind + trigger` without the directory, so project A's record could
   absorb project B's wording while keeping A's `cwd`. Recall was correctly
   directory-filtered, which is exactly why the smoke test missed it. Records now
   carry one `owner` string (`user`, `project:<cwd>`, `session:<id>`) used by
   write, merge, index rebuild, and recall; legacy rows derive it from `cwd`.
8. **Probe timing used `updatedAt`, and the sweep starved.** A record written and
   recalled in the same millisecond skipped a zero-TTL check — that made
   `node test/smoke.mjs` fail 4 runs in 10 — and a passing background check never
   advanced anything the ordering looked at, so 40 healthy records could occupy
   the sweep forever. Checks now use `lastCheckedAt` (zero TTL = every time), the
   sweep sorts least-recently-checked first, and a candidate still due when the
   five-probe recall budget runs out is skipped instead of served unverified.
   Twenty consecutive runs of both suites now pass.
9. **Distillation could promote a guess.** Non-empty `evidence` text plus “the
   turn used tools” was enough for `active`, and a low-confidence restatement
   could swap `evidence`/`probe` while keeping the old claim. Candidates must now
   cite concrete tool results (resolved against the turn, required to have
   succeeded, and class-checked against the claim); unsupported candidates are
   stored as `proposed`. A merge replaces `claim + evidence + probe + support` as
   one version or not at all.

## Caveats

- Task 2 has one run per cell, Task 1 has two baseline runs and one treatment
  run. The deltas are large enough to be visible, not large enough for
  confidence intervals.
- The fixture is small; token totals are dominated by a handful of file reads.
- Prompt-cache behaviour varies between runs, so `input` and `cached` must be
  read together. Comparing only `inputTokens` overstates savings.
- The model is not seeded; a different sample could change the step counts.
- Distillation quality was measured by *records written*, not by downstream
  outcomes. A stale or wrong distilled record costs recall tokens until a probe
  or a human retires it.
- The correctness and packaging work in 1.6.1–1.7.0 (checkpoint persistence,
  owner scoping, import validation, probe scheduling, distillation accounting,
  shared memory, the learned dictionary, aliases, and failure-driven
  enrichment) is verified by the store-level, tool-entry, and packed-package
  suites, not by a new DSH benchmark run; no model tokens were spent
  re-measuring the tables above. The semantic features have no new benchmark:
  normal recall is still local and free, while enrichment is one bounded
  turn-end call and is not separately timed here.
- All benchmark runs are on one machine, one DSH version (`0.2.2-rc.3`), one
  provider. They are historical and are labeled as such: re-measure with the
  fixture builder in `bench/` (source checkout only) before comparing.
