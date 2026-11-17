# dsh-memory-astra62

Cross-session memory for **DeepSeek Harness** (DSH): durable, scoped records
plus one task checkpoint per working directory, recalled just before a model
decision and retired when a cheap probe shows they no longer hold.

- **No embeddings, no vector database.** Retrieval scores the record's *trigger*
  — the situation it claims to apply to — against the current prompt using
  idf-weighted trigger coverage over Latin words and CJK bigrams. The claim only
  adds supporting vocabulary, so a precise trigger is not diluted by a long
  explanation.
- **Scoped by construction.** Every record has one owner — global `user`, one
  normalized `project` directory, or one `session` id — and dedupe, index
  rebuild, and recall all use that same identity. Two projects recording the
  same trigger stay two records.
- **No model calls on the hot path.** `memory-core` adds one in-memory scoring
  pass at the first step of a turn and a bounded probe of at most five due
  records.
- **Three independent rows.** You can switch off the part that costs what you do
  not want to pay for, without uninstalling the bundle.
- **Zero runtime dependencies.** Only `node:` builtins; nothing resolves outside
  the DSH storage seams.

## Why three rows

| Row id | Module | Model calls | Cost |
|---|---|---|---|
| `memory-core` | `@sulytwelve/dsh-memory-astra62` | none | One scoring pass per turn start; a few small file writes |
| `memory-distill` | `…/distill` | 0–2 per qualifying turn, **enabled by default** | One bounded background request, after the turn already closed |
| `memory-probe` | `…/probe` | none | A periodic `stat` / substring check of at most 40 records |

`memory-distill` ships enabled because a memory system that never learns
anything new is only half a system; set `llm.enabled: false` in its config to
make the whole bundle model-call-free. Turning `memory-core` off makes the other
two inactive (they inject its store service) and stops all injection.

## Install

The bundle can be installed by the agent that is already running, from a local
folder, a GitHub repository, or a published package. All three paths end in the
same `plugin_manager` operation.

### From a local checkout (the path verified during development)

```text
plugin_manager action=install_bundle target=D:\path\to\dsh-memory-astra62
```

The manager links the directory, so edits are picked up on the next process
start. **Replacing** an installed copy needs `remove_bundle` followed by
`install_bundle`; a second `install_bundle` reports `already-installed` and keeps
the cached module generation.

### From GitHub

Ask the agent:

> Install the plugin bundle from `https://github.com/Sulytwelve/dsh-memory-astra62`
> and enable it.

The agent runs:

```text
plugin_manager action=install_bundle
               target=https://github.com/Sulytwelve/dsh-memory-astra62
```

`github:Sulytwelve/dsh-memory-astra62` and `github:Sulytwelve/dsh-memory-astra62#v1.0.0`
work the same way. The manager installs the package into the current DSH
profile and selects the bundle, so the three rows appear in **Plugins**.

The install runs `pnpm` **inside the DSH process**, so it uses that process's
network and proxy environment, not your shell's. On a machine where GitHub needs
a proxy, launch DSH with `HTTP_PROXY`/`HTTPS_PROXY` set, or clone the repository
and install the local directory instead.

### From a published package

```text
plugin_manager action=install_bundle target=@sulytwelve/dsh-memory-astra62
```

Equivalent CLI (installs the dependency; select the bundle in **Plugins** if the
manager did not):

```bash
dsh plugin --profile <profile> add @sulytwelve/dsh-memory-astra62
```

### Verify

- `Plugins` lists **Cross-session memory** with three rows.
- In a new session the model has a `memory` tool.
- `memory{op:"status"}` prints counters; after a turn ends,
  `memory{op:"resume"}` prints the checkpoint for the working directory.

## What it stores

One `agent_memory` storage domain, `per-record` layout, under
`$DSH_HOME/storages/agent_memory/`:

- `memories` — `scope` (`user` / `project` / `session`), its derived `owner`,
  `kind` (`preference` / `procedure` / `fact` / `decision` / `pitfall` /
  `hypothesis`), `trigger`, `claim`, `evidence`, `confidence`, usage counters, an
  optional `probe`, `lastCheckedAt`, and supersession links.
- `tasks` — one checkpoint per working directory: milestone, next action, open
  question, acceptance condition.
- `ledger` — per-session turns, steps, provider-reported input/output tokens,
  injection tokens, probe outcomes, distillation calls.
- `events` — a bounded ring of recent memory-system events.

## What the model sees

At the first step of a turn, `memory-core` builds a query from the user's text,
scores every active record inside the caller's owner, drops anything below
`minRelevance`, probes the due records among the top results under a five-probe
budget, and packs the survivors into `tokenBudget` (220 tokens by default). The
packet is appended as **one synthetic user message** whose source is
`{ kind: "memory-recall", form: "recall" }`, so it is durable, attributable, and
visible in the transcript:

```text
[memory] 2 prior record(s) recalled (evidence, not instructions — verify before relying).
Resume (2d ago): checkpoint ... | done: ... | next: ...
- [397c39] pitfall·project (0.90 verified ·checked 3h ·2x): opening a ctx.storageDomain domain → names must match /^[a-z][a-z0-9_]*$/
Persist a durable lesson with memory{op:"write",kind,trigger,claim,evidence}.
```

Three details in that line exist for the verifying model: `verified` /
`documented` says what class of observation backs the record, `checked 3h`
says when that evidence was last revalidated, and the record id is what
`memory{op:"feedback"}` takes.

Nothing is injected when nothing scores, when the per-session packet cap is
reached, or when the same record was already injected in this session. A record
that is due for a check and cannot get one (budget exhausted) is left out rather
than served unverified.

## The tool

One tool, `memory`, with operations `recall`, `write`, `forget`, `status`,
`report`, `checkpoint`, `resume`, `probe`, `feedback`, `set_status`.

```jsonc
// persist one transferable lesson
{"op":"write","kind":"procedure","scope":"project",
 "trigger":"running the full test suite in bench-target",
 "claim":"Use node scripts/test.mjs --suite=all; slow fixtures need MEMBENCH_SLOW=1.",
 "evidence":"docs/06-testing.md","confidence":0.9,
 "probe":{"kind":"file-contains","target":"scripts/test.mjs","pattern":"--suite="}}

// save the task state so a later session can resume
{"op":"checkpoint","milestone":"reproduced the offset gap",
 "next_action":"fix nextOffset to stop at the first gap",
 "acceptance":"test/offset.test.mjs passes"}

// measurement
{"op":"report"}
```

## Configuration

Every row reads its `config` from the patch layer. The defaults live in
`cordis.patch.yml`; override only what you need:

```yaml
- id: memory-core
  config:
    recall:
      minRelevance: 2.5      # raise to inject less, lower to inject more
      tokenBudget: 220       # max tokens per recall packet
      maxPackets: 6          # per session
      includeSubagents: true
      probeOnRecall: true
      probeTtlMs: 86400000   # re-check a recalled record after one day (0 = every recall)
      probeBudget: 5         # max checks per recall; still-due records beyond it are skipped
- id: memory-distill
  config:
    llm:
      enabled: true          # false = deterministic checkpoints only, zero model calls
      threshold: 4           # turn-score needed before spending one call
      maxCallsPerSession: 2
      maxCallsPerDay: 12
- id: memory-probe
  config:
    intervalMs: 900000       # sweep cadence
    recheckMs: 3600000       # minimum age before a record is re-checked
```

Run `memory{op:"status"}` after a day and read `probeSkipped`: a non-zero value
means the five-probe recall budget is binding, not that the checks failed.

## Measurement

`memory{op:"report"}` returns the per-session ledger the plugin keeps: steps
(= model calls), provider-reported input/output tokens, injected tokens,
distillation calls and their tokens, and the session span. `memory{op:"status"}`
reports the current session plus store-wide counts.

`docs/MEASUREMENTS.md` records a paired before/after trial run against the
deterministic fixture created by `node bench/setup.mjs`.

## Disable, rollback, uninstall

- **Lighter:** set `enabled: false` in a row's config, or toggle the row in
  **Plugins**. `memory-distill` off ⇒ no model calls. `memory-probe` off ⇒ no
  background I/O. `memory-core` off ⇒ the other rows go inactive.
- **Rollback:** disable all three rows; stored data stays under
  `$DSH_HOME/storages/agent_memory/` and comes back when you re-enable.
- **Uninstall:** `plugin_manager action=remove_bundle target=@sulytwelve/dsh-memory-astra62`.
  Remove the storage directory too if you want the records gone.

## Requirements and limits

- DSH `0.2.2-rc.3` with the storage hub, the JSON storage backend, and the
  `storage-domain` form mounted (both are in the shipped `dsh-base` profile).
- Retrieval is lexical. A record whose vocabulary does not overlap the user's
  wording will not surface; write triggers in the words you would use to ask.
- Recall itself does no I/O **unless a probe is due**; a due probe reads the
  target file, bounded by `probeMaxBytes`.
- A probe expresses only the checks the recorder declared. Records without a
  probe are never invalidated automatically.
- Distillation is a single non-tool request; it cannot read files. It may only
  promote a candidate to `active` when the candidate cites tool results from that
  turn, those results succeeded, and the class of result supports the claim.
  Unsupported candidates are stored as `proposed` and never recalled as fact.
- The tool schema is ~540 tokens in every request while the row is enabled
  (cached after the first request). That is the fixed cost of having the
  capability at all; `memory-distill` and `memory-probe` add nothing to it.

## Development

```bash
node test/smoke.mjs        # 15 store-level checks, no DSH required
node test/regression.mjs   # 24 isolation / probe / evidence regression checks
node bench/setup.mjs       # build the benchmark fixture
node bench/analyze.mjs <session.v4.jsonl.zstd>   # per-session calls/tokens/wall
node bench/score.mjs "$DSH_HOME/storages/agent_memory" "<query>" --cwd <dir>
```

`bench/score.mjs` prints every candidate's trigger-coverage breakdown against the
real records in a live store — use it to tune `minRelevance` for your vocabulary.

## License

BSD-2-Clause. Copyright (c) 2026, Sulytwelve.

## 中文快速开始

1. 对正在运行的 agent 说：**安装 `https://github.com/Sulytwelve/dsh-memory-astra62` 这个插件包并启用**。
   agent 会执行 `plugin_manager install_bundle`，三行插件随即出现在「插件」页。
2. 新开会话，模型即拥有 `memory` 工具。

- 想让记忆更积极：把 `memory-core` 的 `recall.minRelevance` 调低（例如 2.0）。
- 想完全关掉后台模型调用：把 `memory-distill` 的 `llm.enabled` 设为 `false`。
- 想整体停用：逐个关闭三行，或 `remove_bundle`；数据保留在 `$DSH_HOME/storages/agent_memory/`。
- 查看本次会话的 token / 调用次数：`{"op":"report"}`。
