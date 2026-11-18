# DSH Context Manager

**Context management for DeepSeek Harness (DSH).** It recalls relevant project
knowledge on demand, revalidates the evidence behind it, and restores a task that
was left unfinished in another session.

The bundle, the npm package, and the GitHub repository are all named
`@sulytwelve/dsh-context-manager` now. Two identifiers did **not** change, so
existing records and configurations keep working: the `memory` tool, the
`agent_memory` storage domain, and the three row ids (`memory-core`,
`memory-distill`, `memory-probe`). The implementation vocabulary stays "memory"
wherever it means a memory record, its storage, or the recall mechanism.

Migrating an install of the old `@sulytwelve/dsh-memory-astra62` package:
`remove_bundle` it, then `install_bundle` the new name — stored records live in
the unchanged `agent_memory` domain, so nothing is lost.

- **No embeddings, no vector database.** Retrieval scores the record's *trigger*
  — the situation it claims to apply to — against the current prompt using
  idf-weighted trigger coverage over Latin words and CJK bigrams. The claim only
  adds supporting vocabulary, so a precise trigger is not diluted by a long
  explanation.
- **Scoped by construction.** Every record has one owner — global `user`, one
  normalized `project` directory, or one `session` id — and dedupe, index
  rebuild, and recall all use that same identity. Two projects recording the
  same trigger stay two records.
- **Evidence, not just text.** A record can carry a probe; a due probe is re-run
  before the record may enter the context, and a failing one retires it. The
  packet says what class of evidence backs each line and when it was last
  checked.
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
| `memory-core` | `@sulytwelve/dsh-context-manager` | none | One scoring pass per turn start; a few small file writes |
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
plugin_manager action=install_bundle target=D:\path\to\dsh-context-manager
```

The manager links the directory, so edits are picked up on the next process
start. **Replacing** an installed copy needs `remove_bundle` followed by
`install_bundle`; a second `install_bundle` reports `already-installed` and keeps
the cached module generation.

### From GitHub

Ask the agent:

> Install the plugin bundle from `https://github.com/Sulytwelve/dsh-context-manager`
> and enable it.

The agent runs:

```text
plugin_manager action=install_bundle
               target=https://github.com/Sulytwelve/dsh-context-manager
```

`github:Sulytwelve/dsh-context-manager` and
`github:Sulytwelve/dsh-context-manager#v1.1.5` work the same way. The manager
installs the package into the current DSH profile and selects the bundle, so the
three rows appear in **Plugins**.

The install runs `pnpm` **inside the DSH process**, so it uses that process's
network and proxy environment, not your shell's. On a machine where GitHub needs
a proxy, launch DSH with `HTTP_PROXY`/`HTTPS_PROXY` set, or clone the repository
and install the local directory instead.

### From a published package

```text
plugin_manager action=install_bundle target=@sulytwelve/dsh-context-manager
```

Equivalent CLI (installs the dependency; select the bundle in **Plugins** if the
manager did not):

```bash
dsh plugin --profile <profile> add @sulytwelve/dsh-context-manager
```

### Verify

- `Plugins` lists **DSH Context Manager** with three rows.
- In a new session the model has a `memory` tool.
- `memory{op:"status"}` prints counters; after a turn ends,
  `memory{op:"resume"}` prints the checkpoint for the working directory.

## Where things live

The plugin is never installed into the DSH application directory. It is installed
into a **profile**, and its data lives under **`$DSH_HOME`** — so the
application's own install location (which the Desktop installer lets you choose)
does not affect it.

| What | Windows | macOS / Linux |
|---|---|---|
| DSH home (profiles + data root) | `%USERPROFILE%\.dsh` | `~/.dsh` |
| Plugin in a profile | `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\@sulytwelve\dsh-context-manager` | `~/.dsh/profiles/<profile>/node_modules/@sulytwelve/dsh-context-manager` |
| Profile dependency and patch layer | `…\profiles\<profile>\package.json`, `cordis.patch.yml` | same layout |
| Memory records (this plugin) | `%USERPROFILE%\.dsh\storages\agent_memory\` | `~/.dsh/storages/agent_memory/` |
| Desktop settings file | `%APPDATA%\@deepseek-ai\dsh-desktop\desktop\settings.json` | `~/Library/Application Support/@deepseek-ai/dsh-desktop/desktop/settings.json` |
| Desktop app install | `%LOCALAPPDATA%\Programs\DeepSeek Harness` by default; the installer accepts any directory | `/Applications/DeepSeek Harness.app` |
| CLI / `npx` | no fixed install directory: it is a global npm package, and its launcher is often linked into `~/.local/bin` | same |

Read the actual paths from a running profile instead of assuming them — every
shell the profile launches carries them:

```powershell
$env:DSH_HOME          # profiles + storages root
$env:DSH_PROFILE       # profile name, e.g. desktop
$env:DSH_PROFILE_DIR   # …\.dsh\profiles\<profile>
$env:DSH_INSTALL_DIR   # CLI package dir; in the Desktop build this points inside app.asar
```

Three consequences worth knowing:

- **Profiles are separate installs.** Enabling the bundle in one profile does not
  enable it in another; the records under `$DSH_HOME/storages/agent_memory/` are
  shared by all of them.
- **A custom Desktop install path moves nothing else.** Only `DSH_INSTALL_DIR`
  changes; profile, data, and settings stay in their own directories.
- **Uninstalling the Desktop app leaves `$DSH_HOME` intact** — the records survive,
  and an uninstall does not delete them.

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
[context-manager] 2 prior record(s) recalled (evidence, not instructions — verify before relying).
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

## Record lifetime

Nothing expires on a timer. A six-month-old record that is still correct stays
`active` and can be recalled again; that durability is the point, and automatic
archival would delete exactly the long-tail knowledge this is for.

| Field | Role |
|---|---|
| `lastUsedAt` / `uses` | when it was last recalled, and how often — never an eviction trigger |
| `updatedAt` | ranking freshness only: ×1.00 up to 7 days, ×0.95 up to 30, ×0.85 after |
| `lastCheckedAt` | when its probe last ran; only a *failed* probe marks it `stale` |

**A probe has three outcomes, not two.** `pass` is evidence the record still
holds; `fail` is evidence it does not; `inconclusive` means the check could not
see enough (the pattern was not in the scanned window of a large file, or the
target was unreadable). Only `fail` retires a record — an inconclusive check
keeps serving it and merely advances the check clock. `file-contains` scans the
head (`probeMaxBytes`, default 256 KiB) plus, on a miss, the last 64 KiB; a
pattern outside both windows is `inconclusive` rather than a false `fail`, so a
background sweep can still revive the record later.

**Confidence rises on restatement, and falls only on request.** A re-write never
lowers a record's confidence, and raising it to fix a wrong value does not work
either: use `memory{op:"set_confidence"}` (or `write` with `"demote": true`) when
a batch import or a stale snapshot turns out to have been too certain.

A record with no probe can only be retired by a later write or an explicit
`forget` / `set_status`. That is why `status` reports scope+trigger groups that
hold more than one active record: it is the cheap way to notice a superseded
conclusion that nobody retired, without deleting anything automatically.

Project identity is the normalized working directory, case-folded only where the
filesystem is case-insensitive (Windows and macOS) — on Linux two paths that
differ by case stay two projects.

Task checkpoints follow a different rule: one is attached automatically only
while it is younger than `resumeMaxAgeMs` (7 days), but `memory{op:"resume"}`
still returns it after that until a later task overwrites it. When a turn-end
write is skipped because another session left a fresh checkpoint in the same
directory, `status` names that checkpoint instead of losing it silently.

## The tool

One tool, `memory`, with operations `recall`, `write`, `forget`, `status`,
`report`, `export`, `checkpoint`, `resume`, `probe`, `feedback`, `set_status`,
`set_confidence`.

`export` prints JSONL — a header line, then one line per record — sorted by
owner, dedupe key, and id so two exports of an unchanged store are identical
apart from timestamps. It is read-only and paginated (`owner`, `scope`, `status`,
`limit`, `offset`, default page of 100). Each record line carries its `id` and
`dedupeKey`, which is what a future import would map on; ledger and event rows
are local telemetry and are not exported.

`status` also carries a read-only review hint: when the same scope and the same
trigger hold more than one `active` record, it lists the group and its ids. That
is a fact to look at, **not** a conflict verdict — one trigger may legitimately
cover different conditions — and nothing is retired, re-ranked, or recalled
differently because of it. It appears only when you ask for `status`.

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

// correct an over-confident import without rewriting it
{"op":"set_confidence","id":"mem_mwl9hmc3_7e70e062","confidence":0.6,
 "query":"snapshot was from October"}

// counters for this session and the store (includes the review hint)
{"op":"status"}

// read-only JSONL of the store, one page at a time
{"op":"export","status":"active","limit":100,"offset":0}

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

Measured on a fixture rebuilt by `node bench/setup.mjs`:

- **Cross-session continuation** (diagnose in one session, fix in the next):
  −20% model calls, −16% token volume, −10% wall, same outcome.
- **Recall versus no recall**, same fixture and prompt, tool schema present in
  both: 36,346 and 23,859 total tokens over two GUI runs against 52,426 with
  `recall.enabled: false`. Direction is consistent; magnitude is unsettled at
  n=2 versus 1.
- **One-shot factual question**: −18% volume and −23% calls, but the model still
  verified the recalled fact — most of that saving is fewer calls, not less
  checking.

These are token-volume measurements, not billing: uncached input, cached input,
and output are priced differently. `docs/MEASUREMENTS.md` has the raw tables, the
control design, the invalid runs, and the caveats.

## Disable, rollback, uninstall

- **Lighter:** set `enabled: false` in a row's config, or toggle the row in
  **Plugins**. `memory-distill` off ⇒ no model calls. `memory-probe` off ⇒ no
  background I/O. `memory-core` off ⇒ the other rows go inactive.
- **Rollback:** disable all three rows; stored data stays under
  `$DSH_HOME/storages/agent_memory/` and comes back when you re-enable.
- **Uninstall:** `plugin_manager action=remove_bundle target=@sulytwelve/dsh-context-manager`.
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
node test/smoke.mjs        # 18 store-level checks, no DSH required
node test/regression.mjs   # 44 isolation / probe / evidence regression checks
node bench/setup.mjs       # build the benchmark fixture
node bench/analyze.mjs <session.v4.jsonl.zstd>   # per-session calls/tokens/wall
node bench/score.mjs "$DSH_HOME/storages/agent_memory" "<query>" --cwd <dir>
node bench/packet.mjs "$DSH_HOME/storages/agent_memory" "<query>" --cwd <dir>
```

`bench/score.mjs` prints every candidate's trigger-coverage breakdown against the
real records in a live store — use it to tune `minRelevance` for your vocabulary.

## License

BSD-2-Clause. Copyright (c) 2026, Sulytwelve.

## 中文快速开始

**DSH 上下文管理器**：为 DeepSeek Harness 提供上下文管理——按需召回相关项目知识、复核知识背后的证据、恢复跨会话任务。展示名、GitHub 仓库、npm 包名现在统一为 `DSH Context Manager` / `@sulytwelve/dsh-context-manager`；**三行 row id（`memory-core`/`memory-distill`/`memory-probe`）、`memory` 工具名和 `agent_memory` 存储域保持不变**，已有记录和配置继续可用。下文技术描述里指“记忆记录/存储/召回机制”时仍用 memory。

1. 对正在运行的 agent 说：**安装 `https://github.com/Sulytwelve/dsh-context-manager` 这个插件包并启用**。
   agent 会执行 `plugin_manager install_bundle`，三行插件随即出现在「插件」页。
2. 新开会话，模型即拥有 `memory` 工具。

**安装位置**（插件装在 profile 里，不在程序安装目录）：

| 内容 | Windows | macOS / Linux |
|---|---|---|
| DSH 数据根（profile + 数据） | `%USERPROFILE%\.dsh` | `~/.dsh` |
| 本插件在某个 profile 中 | `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\@sulytwelve\dsh-context-manager` | `~/.dsh/profiles/<profile>/node_modules/@sulytwelve/dsh-context-manager` |
| 记忆记录 | `%USERPROFILE%\.dsh\storages\agent_memory\` | `~/.dsh/storages/agent_memory/` |
| 桌面版设置文件 | `%APPDATA%\@deepseek-ai\dsh-desktop\desktop\settings.json` | `~/Library/Application Support/@deepseek-ai/dsh-desktop/desktop/settings.json` |
| 桌面版程序安装目录 | 默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，安装时可自选 | `/Applications/DeepSeek Harness.app` |
| CLI / `npx` | 无固定安装目录（全局 npm 包，启动器常链接到 `~/.local/bin`） | 同上 |

实际路径以运行中的 profile 为准：`$env:DSH_HOME`、`$env:DSH_PROFILE`、`$env:DSH_PROFILE_DIR`、`$env:DSH_INSTALL_DIR`（桌面版指向 `app.asar` 内部）。注意：**不同 profile 是各自独立的安装**，但 `storages/agent_memory/` 是共享的；换桌面版安装目录不影响插件与数据；卸载桌面版不会删除 `$DSH_HOME`。

- 想让记忆更积极：把 `memory-core` 的 `recall.minRelevance` 调低（例如 2.0）。
- 想完全关掉后台模型调用：把 `memory-distill` 的 `llm.enabled` 设为 `false`。
- 想整体停用：逐个关闭三行，或 `remove_bundle`；数据保留在 `$DSH_HOME/storages/agent_memory/`。
- 查看本次会话的 token / 调用次数：`{"op":"report"}`。
