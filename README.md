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

- **Semantic recall without a vector database.** Retrieval still scores
  idf-weighted trigger coverage, but the vocabulary is no longer only
  literal. Latin words fold to a shared base form (`backups` → `backup`),
  records carry agent-written retrieval aliases (matched at a lower weight
  than the literal trigger), and a **learned concept dictionary** connects
  wordings that mean the same thing (`密码库` = `vaultwarden`). Nothing
  semantic is hardcoded: the dictionary starts empty and is written at
  runtime by the agent — explicitly with `memory{op:"link"}`, automatically by
  the failure-driven enrichment — and it is inspectable and editable. The
  claim only adds supporting vocabulary, so a precise trigger is not diluted
  by a long explanation. `docs/SEMANTIC-RETRIEVAL.md` has the design and the
  reserved vector-tier seam.
- **One bot, one memory.** Every conversation — private or group — reads and
  writes the same records, aliases, dictionary, and checkpoint. There is no
  chat-type dependency, no bridge, and no transport patch. An optional
  `sensitivity` marker is left for a separately installed owner guard.
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
| `memory-distill` | `…/distill` | at most **one** call per qualifying turn (writes 0–2 records), **on in the shipped bundle patch**; plus at most one failure-driven enrich call after a zero-hit recall | One bounded background request per qualifying turn, plus one only after recall actually missed; both after the turn already closed |
| `memory-probe` | `…/probe` | none | A periodic `stat` / substring check of at most 40 records |

`memory-distill` ships enabled because a memory system that never learns
anything new is only half a system; set `llm.enabled: false` in its config to
make the whole bundle model-call-free. That default lives in the shipped
`cordis.patch.yml`; the module's own fallback keeps the model call off, so a row
mounted without the patch never spends a request. Turning `memory-core` off
makes the other two inactive (they inject its store service) and stops all
injection.

## Install

**Before you install — what it costs and which switches matter.** The `memory`
tool schema is about 540 tokens in every request while `memory-core` is enabled
(cached after the first request). Recall and probes never call a model.
`memory-distill` is the only model caller and ships on: each qualifying turn may
spend **one** bounded request (at most 2 records per turn, 2 calls per session,
12 per day, one per 2-minute cooldown), and after a recall that produced zero
hits it may spend **one** small enrichment request (own caps: 4 per session,
6 per day, 45 s cooldown) that writes retrieval aliases and synonym groups. For
a **zero-extra-model-request** install, set `llm.enabled: false` in the
`memory-distill` row config before the first session — recall, probes, and
turn-end checkpoints keep working.

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
`github:Sulytwelve/dsh-context-manager#v1.7.0` work the same way. The manager
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
  optional `probe`, `lastCheckedAt`, retrieval `aliases`/`aliasAt`, and
  supersession links. An optional `sensitivity` marker is kept for an external
  owner guard; this row shares every record across conversations.
- `concepts` — the learned synonym dictionary: shared surface forms the agent
  declared equivalent through `link`, enrichment, or import. One bot, one
  dictionary.
- `tasks` — one checkpoint per working directory: milestone, next action, open
  question, acceptance condition. Shared by every conversation.
- `ledger` — per-session turns, steps, provider-reported input/output tokens,
  injection tokens, probe outcomes, distillation and enrichment calls.
- `events` — a bounded ring of recent memory-system events.

## What the model sees

At the first step of a turn, `memory-core` builds a query from the user's text,
scores every active record inside the caller's owner, drops anything below
`minRelevance`, probes the due records among the top results under a five-probe
budget, and packs the survivors into `tokenBudget` (220 tokens by default).
Scoring sees literal words, folded Latin stems, agent-written aliases at 0.7
weight, and shared concept groups, so a wording learned in any conversation can
surface the record in any other. The packet is appended as **one synthetic user
message** whose source is `{ kind: "memory-recall", form: "recall" }`, so it is
durable, attributable, and visible in the transcript:

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

Release history: CHANGELOG.md.

## The tool

One tool, `memory`, with operations `recall`, `write`, `forget`, `status`,
`report`, `export`, `import`, `checkpoint`, `resume`, `probe`, `feedback`,
`set_status`, `set_confidence`, `link`.

`export` prints JSONL — a header line, then one line per record, then the shared
concept rows — sorted by owner, dedupe key, and id so two exports of an unchanged
store are identical apart from `generatedAt`. It is read-only and paginated
(`owner`, `scope`, `status`, `limit`, `offset`, default page of 100). Each record
line carries its `id` and `dedupeKey`; records with retrieval aliases carry them,
and an optional `sensitivity` marker is preserved. The learned concept dictionary
rides along as `type: "concept"` rows in **every** export: it belongs to the bot,
not to one owner or conversation, so the same arguments produce the same content
from any entry point. This is a **snapshot of the memory records plus the shared
dictionary**, not a complete backup of the plugin's data: checkpoints, the ledger,
and the event ring are not exported. For a full-domain backup, stop DSH and copy
`$DSH_HOME/storages/agent_memory/` (see **Backup and restore** below).

By default an export is scoped to the calling session's owners (its `user`
records, its project, and its session). `all: true` is the explicit operator-wide
path for migration. There is no per-conversation private/group filtering: a
record marked `sensitivity: "private"` is still exported, because this row has one
shared store. An external owner guard can filter it before the tool is used.

`import` reads that JSONL back (`path` relative to the working directory, or
inline `payload` up to 8 MB) and maps rows to records by owner + `dedupeKey`. A
newer `updatedAt` wins; an older or equal row is skipped, so importing an
unchanged export twice changes nothing. Import never demotes local state:
confidence keeps the higher value and status keeps the stronger one. A row with
a missing `updatedAt`, or one more than a day in the future, is rejected: it
would win the newer-wins comparison forever and no later import could correct it.
Ids must be storage-safe, owner and scope must agree, and a locally matched
record is never reparented. Claim, evidence, probe, support, and check time are
applied as one version: a newer claim does not inherit an older probe's
evidence. Wrong `format`, or a row missing id/dedupeKey/trigger/claim, is
rejected rather than partially applied; damaged JSONL lines are reported by line
number. On a same-version store with valid rows, `export → import → export`
reproduces the record layer.

Import is a write-class capability: the same caller can already call `write`, so
treat an imported file as untrusted input. Confidence still only falls by an
explicit `set_confidence` or a `write` with `demote: true`.

Because `owner` embeds the normalized working directory, importing on a machine
whose checkout path differs does not merge into the local project: the rows land
under the new owner. Re-map or re-scope deliberately when migrating across
machines or directories.

Id-based mutations (`forget`, `set_status`, `set_confidence`, `probe`,
`feedback`) are owner-scoped: a record from another project or session is
reported as unknown and is never changed; `supersedes` must point into the same
owner. `user` records are shared across one data root — the deployment model is
**one bot, one shared memory**.

`report` ends with the last recall's rejection summary — reason counts
(no-overlap, below-threshold, probe-failed, probe-budget, token-budget,
packet-limit) and the three highest-scoring rejected candidates. It also shows
the session's enrichment calls and tokens; `status` shows the same per-session
counters.

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

// restore that JSONL (file or inline); idempotent and never demoting
{"op":"import","path":"D:/backup/context-manager-export.jsonl"}

// optional marker for an external owner guard; the core store is shared
{"op":"write","kind":"preference","scope":"user","sensitivity":"private",
 "trigger":"handling his personal photos",
 "claim":"Never touch his personal photos without asking first."}

// teach the dictionary: these forms always mean the same thing
{"op":"link","forms":["密码库","vaultwarden","bitwarden"]}

// remove a learned group that turned out wrong
{"op":"link","forms":["vaultwarden"],"remove":true}

// measurement
{"op":"report"}
```

## Shared memory

One bot has **one memory**. Private chats and group chats read and write the
same records, aliases, learned dictionary, and checkpoint for a directory. A
term taught in one conversation is available in every other; no chat-type API,
QQ bridge, `memoryVisibility` service, or transport patch is required, and the
plugin never waits for an upstream chat plugin to expose that metadata.

`sensitivity: "private"` is kept only as an optional **content marker** for a
future, separately installed owner guard. This bundle does not filter on it:
core recall, export, and checkpoints are identical from every conversation. An
owner guard can be added later as a plugin-over-plugin without changing this
bundle's source; it can read the marker and the rendered ` private` tag and
withhold those records from callers other than the owner. Until such a guard is
installed, treat the store as readable by everyone who can talk to the bot.

Migration note: records and checkpoints written by 1.6.x under a private
classification are now read as shared; the old `sensitivity` value is preserved
as a marker, and old per-session private checkpoint keys are no longer consulted
(the single shared checkpoint for the directory is used).

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
      enrich: true           # zero-hit recall -> one bounded alias/synonym call
      enrichMaxPerDay: 6     # its own caps; a record enriched once rests 7 days
      enrichMaxCandidates: 8 # rejected records shown to the model
      enrichMaxPromptTokens: 1200
- id: memory-probe
  config:
    intervalMs: 900000       # sweep cadence
    recheckMs: 3600000       # minimum age before a record is re-checked
```

Two layers set these values. The shipped bundle patch is authoritative for an
installed bundle: `llm.enabled: true`, `threshold: 4`. The module's own fallbacks
— used only when a row is mounted without that patch — keep the model call off
(`enabled: false`, `threshold: 3`), so a bare row cannot spend a request by
accident. The table and examples above describe the bundle.

Run `memory{op:"status"}` after a day and read `probeSkipped`: a non-zero value
means the five-probe recall budget is binding, not that the checks failed.

## Measurement

`memory{op:"report"}` returns up to the last 40 **persisted** session ledger
rows: steps (= model calls), provider-reported input/output tokens, injected
tokens, distillation and enrichment calls and their tokens, and the session
span. It is not "this session only" — use `memory{op:"status"}` for the current
session's counters plus store-wide totals.

Measured on a fixture rebuilt by `node bench/setup.mjs` (bench scripts are
source-checkout only):

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
and output are priced differently. They are from the v1.1.4–v1.2.0 line and were
not re-measured for 1.6.1 or 1.7.0; the scenario is recall without due probes.
`injectionMs` includes recall attempts that injected nothing.
`docs/MEASUREMENTS.md` has the raw tables, the control design, the invalid runs,
and the caveats.

## Backup and restore

Two different operations:

- **Record snapshot:** `memory{op:"export"}` prints JSONL for inspection and
  migration. It contains the memory records plus the shared concept dictionary —
  no checkpoints, ledger, or event ring. Import it back with
  `memory{op:"import"}`; on a same-version store with valid rows,
  export → import → export reproduces the record layer, while concept rows merge
  by form.
- **Full domain backup:** stop DSH, copy the whole
  `$DSH_HOME/storages/agent_memory/` tree, and restore it with DSH stopped. This
  is the only way to preserve checkpoints and telemetry. Exports are already
  complete for records and the dictionary; no private-conversation step is
  needed.

## Disable, rollback, uninstall

- **Lighter:** set `enabled: false` in a row's config, or toggle the row in
  **Plugins**. `memory-distill` off ⇒ no model calls. `memory-probe` off ⇒ no
  background I/O. `memory-core` off ⇒ the other rows go inactive.
- **Rollback:** disable all three rows; stored data stays under
  `$DSH_HOME/storages/agent_memory/` and comes back when you re-enable.
- **Uninstall:** `plugin_manager action=remove_bundle target=@sulytwelve/dsh-context-manager`.
  Remove the storage directory too if you want the records gone.

## Requirements and limits

- The plugin's own engine floor is **Node ≥ 20** for the shipped test suites and
  standalone use. The DSH installation that runs it has its own Node requirement
  (the desktop app bundles a runtime; a CLI install follows the CLI package's
  `engines`).
- DSH **0.2.2-rc.3+** with the storage hub, the JSON storage backend, and the
  `storage-domain` form mounted (all in the shipped `dsh-base` profile).
  Verified: Windows 11 + DSH `0.2.2-rc.5` (this release's suites on Node 24) and
  a Linux host (review) on Node 20.20.2 / 24.22.1. macOS is untested.
- Retrieval is lexical **plus learned semantics**. A record whose wording does
  not overlap the question still misses its *first* recall. The failure-driven
  enrichment shows the model up to 8 rejected candidates; if the target is in
  that window and the model picks it, later queries can match through the learned
  aliases or synonym group. If the target is outside the window, use
  `memory{op:"link"}` or `write{aliases}` explicitly. With the model call off,
  the dictionary is whatever the agent wrote through `link` and
  `write{aliases}`. The fix accumulates only where recall actually failed.
- Recall does no I/O **unless a probe is due**. A due probe reads the target file
  asynchronously, bounded by `probeMaxBytes`, so a slow network filesystem delays
  that recall but does not block other sessions.
- Packet size is enforced with the same estimator that renders it, against both
  the per-packet budget and the session's remaining allowance; the 220-token
  default is a ceiling, not a prediction.
- A probe expresses only the checks the recorder declared. Records without a
  probe are never invalidated automatically.
- Distillation and enrichment are non-tool model requests; neither can read
  files. Distillation may only promote a candidate to `active` when the candidate
  cites tool results from that turn, those results succeeded, and the class of
  result supports the claim. Unsupported candidates are stored as `proposed` and
  never recalled as fact.
- The tool schema is ~540 tokens in every request while the row is enabled
  (cached after the first request). That is the fixed cost of having the
  capability at all; `memory-distill` and `memory-probe` add nothing to it.

## Development

```bash
npm test                    # the three shipped suites
node test/smoke.mjs         # 18 store-level checks, no DSH required
node test/regression.mjs    # 115 isolation / probe / budget / import / semantic checks
node test/tool.mjs          # 12 tool-entry checks against a minimal fake Host

# Benchmarks are source-checkout only (not shipped in the npm package):
node bench/setup.mjs        # build the benchmark fixture
node bench/analyze.mjs <session.v4.jsonl.zstd>   # per-session calls/tokens/wall
node bench/score.mjs "$DSH_HOME/storages/agent_memory" "<query>" --cwd <dir>
node bench/packet.mjs "$DSH_HOME/storages/agent_memory" "<query>" --cwd <dir>
```

The suites are run locally before a release (`npm test`); this repository does
not use hosted CI workflows. They validate storage keys and the domain schemas
the way the JSON backend does, and `test/tool.mjs` exercises the registered tool
through a minimal host.

`bench/score.mjs` prints every candidate's trigger-coverage breakdown against the
real records in a live store — use it to tune `minRelevance` for your vocabulary.

## License

BSD-2-Clause. Copyright (c) 2026, Sulytwelve.

## 中文快速开始

**DSH 上下文管理器**：为 DeepSeek Harness 提供上下文管理——按需召回相关项目知识、复核知识背后的证据、恢复跨会话任务。展示名、GitHub 仓库、npm 包名现在统一为 `DSH Context Manager` / `@sulytwelve/dsh-context-manager`；**三行 row id（`memory-core`/`memory-distill`/`memory-probe`）、`memory` 工具名和 `agent_memory` 存储域保持不变**，已有记录和配置继续可用。下文技术描述里指“记忆记录/存储/召回机制”时仍用 memory。

1. 对正在运行的 agent 说：**安装 `https://github.com/Sulytwelve/dsh-context-manager` 这个插件包并启用**。
   agent 会执行 `plugin_manager install_bundle`，三行插件随即出现在「插件」页。
2. 新开会话，模型即拥有 `memory` 工具。

**装之前先知道的成本**：`memory-core` 的 `memory` 工具 schema 常驻约 540 token/请求（首次后会缓存）；召回与探针不调模型。`memory-distill` 出厂是开的，每个符合条件的回合最多 1 次有界调用（每会话 2 次、每天 12 次、2 分钟冷却），零命中召回后再多一次有独立预算的 enrichment 调用。想要**零额外模型调用**，先把它配置里的 `llm.enabled` 设为 `false`——召回、探针和 turn-end checkpoint 都不受影响。

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
- **共享记忆**：私聊和群聊读写同一份记录、别名、词典和 checkpoint；不需要聊天类型接口，也不需要 bridge 或 transport patch。`sensitivity: "private"` 只作为未来外置 owner guard 的内容标记，本 bundle 不按它过滤。
- **语义召回**：`{"op":"link","forms":["密码库","vaultwarden","bitwarden"]}` 声明同义词组——词典由 Agent 在运行时写入，插件**不带任何内置词表**；某次 recall 零命中时，`memory-distill` 会花一次有界模型调用，把最多 8 条被拒候选展示给模型，自动为其中匹配的记录补别名、为整个库补同义组（`llm.enrich`，默认开；设 `false` 关闭）。只有目标进入候选窗口且模型选中时才可能学会；没进入就用 `link`/`write` 显式补。设计细节与预留的向量接口见 `docs/SEMANTIC-RETRIEVAL.md`。
- 想完全关掉后台模型调用：把 `memory-distill` 的 `llm.enabled` 设为 `false`（此时词典只能靠会话里的 `link`/`write` 主动写）。
- 想整体停用：逐个关闭三行，或 `remove_bundle`；数据保留在 `$DSH_HOME/storages/agent_memory/`。
- 查看**当前会话**的计数与状态：`{"op":"status"}`。`{"op":"report"}` 汇总的是最近最多 40 条**已持久化的会话账本**（含历史会话），不是只统计本次会话。
