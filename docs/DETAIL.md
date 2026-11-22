# DSH Context Manager

Context management for DeepSeek Harness coding sessions. It keeps a small
curated set of **scoped, evidence-bearing memory records** plus one **task
checkpoint per working directory**, recalls them just before a model decision,
and retires them when a cheap probe shows they no longer hold.

This is a product rename, not a re-architecture: the bundle, npm package, and
repository are now `@sulytwelve/dsh-context-manager`, while the three row ids,
the `memory` tool, and the `agent_memory` storage domain are unchanged, so
existing records and configurations keep working. The word "memory" below still
means a memory record, its storage, or the recall mechanism.

Migrating from the old package name: `remove_bundle` the old
`@sulytwelve/dsh-memory-astra62`, then install the new one.

## Why it is split into three rows

Each row is a separate Loader entry, so each can be disabled on its own in
**Plugins** without uninstalling the bundle. The split follows cost:

| Row | Id | Model calls | What it costs |
|---|---|---|---|
| Memory core | `memory-core` | none | One in-memory scoring pass at the first step of a turn; a few small file writes |
| Memory distillation | `memory-distill` | at most one per qualifying turn, plus at most one failure-driven enrichment call | Bounded background requests, after the turn has already closed |
| Memory probes | `memory-probe` | none | A periodic `stat`/substring check of at most 40 records |

Turning `memory-distill` off removes every model call the memory system can
make; turning `memory-core` off makes the other two inactive. No row subscribes
to a per-token stream, and nothing runs on the model's critical path except the
recall pass described below.

## What is stored

An `agent_memory` storage domain with five per-record tables:

- **memories** — `scope` (`user` / `project` / `session`), the derived `owner`,
  `kind` (`preference` / `procedure` / `fact` / `decision` / `pitfall` /
  `hypothesis`), `trigger` (when it applies), `claim` (the transferable
  statement), `evidence` (where it came from), `confidence`, usage counters, an
  optional `probe`, `lastCheckedAt`, retrieval `aliases`/`aliasAt`, the `support`
  class of distilled records, an optional `sensitivity` marker for an external
  owner guard, and supersession links. Superseded records stay readable.
- **concepts** — the learned synonym dictionary: surface forms the agent declared
  equivalent through `link`, enrichment, or import. It is shared by every
  conversation of the bot.
- **tasks** — one checkpoint per working directory: milestone, next action,
  unresolved question, acceptance condition, the session that wrote it. Shared
  by every conversation.
- **ledger** — per-session counters used for measurement: turns, steps, model
  input/output tokens, injections and their tokens, probe outcomes, distillation
  and enrichment calls and their tokens.
- **events** — a bounded ring of recent memory-system events for `status`.

### One shared memory

`owner` decides record dedupe and management boundaries, not conversation
visibility. Every chat of the same bot reads the same records, aliases,
dictionary, and checkpoint for a working directory. There is no chat-type branch
and no `memoryVisibility`/bridge dependency: the store is one memory. An optional
`sensitivity: "private"` marker is preserved for a separately installed owner
guard; this bundle does not filter on it.

## When memory is used

The recall pass runs inside `agent/pre-step`, at the first step of a turn (or
when steering arrives). It builds a query from the claimed user text and scores
every active record by **trigger coverage**: the idf-weighted share of the
record's trigger vocabulary that the prompt actually uses, saturating so a
verbose trigger is not punished for its extra words, plus a smaller term for how
much of the prompt the record explains at all. Literal words are folded through
a small Latin stemmer; record aliases count as triggers at 0.7; and learned
concept terms from the shared dictionary join both sides. Confidence, freshness,
and feedback counters weight the result.

A zero-hit recall can trigger one bounded enrichment call at turn end. It reads
the **automatic** recall summary for this turn — never an explicit tool query
that happened to run later — and shows the model up to
`llm.enrichMaxCandidates` (8) rejected records, capped by
`llm.enrichMaxPromptTokens` (1200). The model may answer with no matching record;
if it picks one, its aliases are merged and its synonym groups enter the shared
dictionary. A record already enriched rests for `llm.enrichTtlMs` (7 days), and
the call has its own persisted caps (4/session, 6/day, 45 s cooldown).

Candidates due for a check — never checked, or checked longer ago than
`recall.probeTtlMs`, where `0` means every recall — are probed before they can
enter the packet. The probe budget is five per recall; a candidate still due
when the budget runs out is **skipped**, not served unverified. Probe reads are
asynchronous (`node:fs/promises`), so a check on a slow filesystem does not block
the Host event loop. The survivors are packed into a token budget (220 tokens by
default) and appended as one synthetic `recall`-form user message, so the packet
is durable, attributable, and visible in the transcript. A verbose record is
truncated to fit rather than dropped.

A probe is three-valued: `pass`, `fail`, or `inconclusive`. Only `fail` retires
a record. `inconclusive` covers the cases where the check could not see the
evidence — a pattern outside the scanned window of a large file, or an
unreadable target — and it keeps the record in service. `file-contains` reads
`probeMaxBytes` from the head and, on a miss, the last 64 KiB; a file larger
than both windows that does not match is inconclusive rather than falsely stale.

Nothing is injected when nothing scores above `minRelevance`, when the
per-session packet cap is reached, or when the same record was already injected
in this session. The task checkpoint is injected only when the prompt actually
overlaps the checkpoint's own text — an unrelated task in the same directory
pays nothing.

`memory-distill` writes the task checkpoint at every completed turn without any
model call, as long as no curated checkpoint exists for the session and no fresh
checkpoint with a next action is already stored. When a turn shows at least three
tool calls or explicit durable intent **and** scores 4 or more, it may spend one
bounded request to distill 0–2 records.

### What may become fact

A distillation is one non-tool request: it reports what the turn observed, it
does not observe anything itself. Each candidate must cite tool results from that
turn (`evidence_refs`, shown to the model as `t1`, `t2`, …). The runtime resolves
each ref, requires it to have succeeded, and requires the class of tool to
support the claim:

| Cited result | Supports |
|---|---|
| `read` / `grep` / `glob` / `web_fetch` succeeded | “the file or page says X” |
| a command or terminal call succeeded | “running X works / the test passes” |
| `write` / `edit` only | nothing on its own |
| a failed call | nothing |

A claim that asserts an execution *outcome* (“passes”, “fails”, “exits 0”) needs
a command that actually ran. Everything else is stored as `proposed`, is never
recalled as fact, and keeps the reason in `support.reason`.

A merge treats `claim + evidence + probe + support` as one version: a
higher-confidence restatement replaces all of them together (and drops the old
`lastCheckedAt`), while a lower-confidence one changes none of them.

## Storage keys

Per-record backends require keys that match `/^[a-zA-Z0-9_-]+$/`: the record key
becomes a file name or SQL identifier segment. Memories, events, and ledger rows
use generated ids; the per-directory checkpoint uses `sha256(normalized cwd)` and
keeps the readable path inside the record.

## Using it

One tool, `memory`, with operations:

- `write` — persist one lesson: `kind`, `trigger`, `claim`, optional `evidence`,
  `confidence`, `tags`, retrieval `aliases`, and an optional `probe`
  (`path-exists` or `file-contains`). `demote: true` lets that write lower an
  existing confidence. `aliases` are appended, never replaced. An optional
  `sensitivity: "private"` marker is stored for an external owner guard; this
  bundle does not filter on it.
- `link` — declare 2+ surface forms that always mean the same thing
  (`{"op":"link","forms":["密码库","vaultwarden"]}`). The dictionary is shared by
  the bot; groups merge when a normalized key intersects (Latin stem or exact CJK
  phrase), and `remove: true` deletes the visible group.
- `recall` — explicit search over the shared store.
- `checkpoint` / `resume` — save and read the single task state for this
  directory; every conversation sees it.
- `probe` / `feedback` / `forget` / `set_status` — maintain a record.
- `set_confidence` — lower (or raise) one record's confidence without rewriting
  its claim, for an over-confident import or a stale snapshot.
- `export` — read-only JSONL of records plus the shared dictionary, one page at a
  time.
- `status` — counters for this session and the store, the review hint, and a
  checkpoint left by another session.
- `report` — up to the last 40 **persisted** session ledger rows, including
  distillation and enrichment calls/tokens, not this session alone.

## Shared memory

Every conversation of the same bot reads and writes the same store: records,
aliases, learned dictionary, and checkpoint for a directory. There is no
private/group branch, no `memoryVisibility` service, no QQ bridge, and no
transport patch to install. A term taught in one chat is available in another,
and the same export arguments produce the same content from either entry point.

`sensitivity: "private"` is preserved only as a **content marker** for a future,
separately installed owner guard. Core recall, export, and checkpoints ignore it.
The old 1.6.x per-session private checkpoint keys are not consulted; the single
shared checkpoint for the directory wins. A legacy `sensitivity` value is kept on
the record so an external guard can still distinguish it.

## Export and import

`export` is read-only and prints JSONL: one header line (`type: "export"`,
`format: 1`, `total`, `offset`, `limit`, `exported`), one line per record
(`type: "memory"`, `format: 1`, `id`, `dedupeKey`, `owner`, `scope`, `kind`,
`trigger`, `claim`, `evidence`, `confidence`, `status`, `probe`, `tags`,
`aliases`, `aliasAt`, `sensitivity`, and the timestamps), then one
`type: "concept"` line per shared synonym group. Rows are sorted by owner, dedupe
key, and id; concept rows are sorted by id. Two exports of an unchanged store
differ only in `generatedAt`. Filters are `owner`, `scope`, `status`, `limit`
(default 100, capped at 500), and `offset`. This is a snapshot of the **memory
records plus the shared dictionary**: checkpoints, the ledger, and the event ring
are local telemetry and are not exported. For a full-domain backup, stop DSH and
copy the whole `$DSH_HOME/storages/agent_memory/` tree.

Scope: by default an export covers the caller's owners (`user`, its project,
its session); `all: true` is the explicit operator-wide path for migration.
Concept rows are never owner-scoped: they are included on every export, and the
same arguments produce the same content from any conversation. A
`sensitivity: "private"` marker does not hide a record from export; an external
owner guard can filter it before the tool is called.

Import maps rows back by `owner + dedupeKey`, **not** by claim similarity: a
`write` re-derivation would merge two records that carry different ids and can
silently pick a different winner. `path` is resolved against the calling
session's working directory; `payload` is capped at 8 MB of UTF-8 bytes. The
rules:

- a row whose `updatedAt` is newer replaces the local content; an older or equal
  row is skipped, which makes an unchanged import idempotent;
- an import never demotes: `confidence` keeps the higher value and `status` the
  stronger one (`active` > `proposed` > `stale` > `superseded`), so importing an
  old export cannot un-verify or un-retire anything;
- the strength order is part of the import contract, not just an internal
  ranking: a newer row can move a record **up** that ladder (for example a
  `proposed` row can reopen a `stale` record for review), and a row from a
  machine that never probed can therefore revive a local `stale` or
  `superseded` record to `active`. That direction is intentional — a newer
  observation wins, an older one cannot un-retire — but when the revived record
  shares a trigger with one that stayed active, `status` reports the group via
  the review hint so the two can be reconciled.
- a row with the wrong `format`, an id that is not storage-safe, an owner that
  disagrees with its scope, or missing `id`, `dedupeKey`, `trigger`, or `claim`,
  is rejected whole, never partially applied; damaged JSONL lines are skipped
  and reported by line number;
- a row whose `updatedAt` is missing or more than a day in the future is
  rejected: it would always win the newer-wins comparison and no later import
  could correct it. A day of clock skew is tolerated;
- a locally matched record is never reparented: the row's owner must match the
  existing record's owner, and one row matching two different records is
  rejected;
- claim, evidence, probe, support, and `lastCheckedAt` are applied as **one
  version**: a newer claim drops the old probe's evidence instead of inheriting
  it;
- `aliases` travel with a row when present; a newer row's alias set replaces the
  local one as part of its version, while a row from an older export without the
  field never strips learned aliases;
- `type: "concept"` rows merge by normalized form key (Latin stem or exact CJK
  phrase), are idempotent, and rebuild the record index once per import batch;
  a row with fewer than two valid forms is rejected;
- on insert the original `id`, `dedupeKey`, timestamps, counters, provenance,
  and supersession links are preserved, so on a same-version store with valid
  rows `export → import → export` reproduces the record layer (concept rows merge
  and receive a new id, so that layer is semantically rather than byte
  identical).

Import is a write-class capability, not a lower trust boundary: the same caller
can already call `write`, but a row also carries timestamps and counters, so an
imported JSONL file must be treated as untrusted input. Confidence still only
falls by an explicit `set_confidence` or a `write` with `demote: true`.

`report` appends the last recall's rejection summary for the calling session:
counts per reason (`no-overlap`, `below-threshold`, `probe-failed`,
`probe-budget`, `token-budget`, `packet-limit`) and the three highest-scoring
rejected candidates. The enrichment candidate pool is separate and larger; the
summary is in-memory (one entry per live session) and resets on restart. `report`
also totals distillation and enrichment calls/tokens per session. The automatic
recall summary is consumed once by the turn-end enrichment, so an explicit tool
query cannot overwrite the user's wording.

## Tuning retrieval

The scoring numbers are empirical. Two small tools exist to calibrate them
against a live store instead of guessing:

```bash
# every candidate's trigger/query coverage against the real records
node bench/score.mjs "$DSH_HOME/storages/agent_memory" "<the prompt you care about>" --cwd <dir>

# the exact packet that prompt would receive, and what it costs
node bench/packet.mjs "$DSH_HOME/storages/agent_memory" "<prompt>" --cwd <dir>
```

Raise `recall.minRelevance` when the packet shows a weak match, lower it when a
relevant record is missing. `bench/packet.mjs` also shows the injection token
cost, which is what `recall.tokenBudget` bounds. The installed package ships
`test/`, so `node test/smoke.mjs`, `node test/regression.mjs`, and
`node test/tool.mjs` can be run from the installed copy; the bench scripts are
source-checkout only.

## Diagnostics

`status` renders recent events for the calling session plus global boot lines.
Write, inject, probe, distill, enrich, link, and checkpoint-skip events are in
the ring; there is no private/group audience filter because the store is shared.
`status` also shows the store-wide counts, this session's ledger, the review
hint, and a checkpoint left by another session.

## Ownership and the management boundary

One DSH data root is one bot. `scope` is a retrieval boundary and, for `project`
and `session` records, a management boundary: id-based operations and
`supersedes` from another owner are reported as unknown, and `export` is scoped
to the caller unless `all: true` is passed. `user` records are shared across the
data root. `sensitivity` is a content marker for an optional external owner
guard, not a filter in this bundle and not file ownership.

## Hot reload

A config edit disposes and re-applies the row, and the domain facility allows one
live handle per name. The disposer therefore returns `Promise.allSettled([store.close(), domain.close()])`,
and the replacement opens through `openDomainWithRetry`, which retries only an
`already-open` rejection, for at most two seconds. If the domain is genuinely
held elsewhere, the row logs one degraded line (`memory-core degraded: could not
open storage domain …`) and registers nothing rather than failing with a raw
storage error; the next reload retries.

## Limitations

- Retrieval is lexical plus learned semantics. A record whose vocabulary does not
  overlap the question misses its first recall; the failure-driven enrichment can
  learn aliases only if the record is inside its bounded candidate window (8 by
  default) and the model selects it. Otherwise use `link` or `write{aliases}`
  explicitly. Alias matches add 0.7 trigger weight; confidence, freshness, and
  feedback multipliers still decide the final order, so a literal match is not
  guaranteed to precede an alias match.
- Recall is free of I/O only while no probe is due; a due probe reads up to
  `probeMaxBytes` from the head plus 64 KiB from the tail, asynchronously. Five
  probes per recall and 40 per sweep are hard caps. The sweep filters the whole
  store by due state before taking its batch, and a stale record that fails
  again still advances its check clock.
- A probe only expresses the checks the recorder declared. Records without a
  probe are never automatically invalidated. A probe verdict is applied only if
  the record's probe is still the one that was read; a replaced probe ignores
  the late result.
- Distillation and enrichment are non-tool model calls; neither can read files.
  Distillation output is evidence-checked only against the turn's own tool
  results — a candidate that cites nothing, cites a failed call, or makes a
  behavioural claim without a command that ran stays `proposed`.
- Self-reported confidence is not calibrated; a record written with
  `confidence: 0.9` by the model is trusted the same way as one written by hand.
  `set_confidence` makes correcting that cheap, but nothing corrects it
  automatically.
- Measurement counters are per process until flushed at turn end; a hard crash
  can lose the current turn's token counters. Distillation and enrichment
  attempts are reserved and persisted before the request, so a crash cannot
  refund them, and the per-day reserves and last-attempt times are rebuilt from
  the ledger at start.
- Disabling `memory-core` leaves existing data on disk (re-enabling resumes it)
  and makes `memory-distill` and `memory-probe` inactive until it returns.
