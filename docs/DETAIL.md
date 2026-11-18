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
| Memory distillation | `memory-distill` | 0–2 per qualifying turn (opt-in) | One bounded background request, after the turn has already closed |
| Memory probes | `memory-probe` | none | A periodic `stat`/substring check of at most 40 records |

Turning `memory-distill` off removes every model call the memory system can
make; turning `memory-core` off makes the other two inactive. No row subscribes
to a per-token stream, and nothing runs on the model's critical path except the
recall pass described below.

## What is stored

An `agent_memory` storage domain with four per-record tables:

- **memories** — `scope` (`user` / `project` / `session`), the derived `owner`,
  `kind` (`preference` / `procedure` / `fact` / `decision` / `pitfall` /
  `hypothesis`), `trigger` (when it applies), `claim` (the transferable
  statement), `evidence` (where it came from), `confidence`, usage counters, an
  optional `probe`, `lastCheckedAt`, the `support` class of distilled records, and
  supersession links. Superseded records stay readable.
- **tasks** — one checkpoint per working directory: milestone, next action,
  unresolved question, acceptance condition, the session that wrote it.
- **ledger** — per-session counters used for measurement: turns, steps, model
  input/output tokens, injections and their tokens, probe outcomes, distillation
  calls and their tokens.
- **events** — a bounded ring of recent memory-system events for `status`.

### One isolation identity

`owner` is `user`, `project:<normalized cwd>`, or `session:<session id>`. Write
time dedupe, index rebuild, and recall all compare that one string, so a record
cannot be merged, ranked, or served outside the boundary it was recorded in. A
restatement in project B can no longer fold into project A's record and inherit
its wording with B's evidence. Records written before the field existed derive
their owner from `cwd`/`sessionId`, so an upgrade re-scopes rather than drops
them.

## When memory is used

The recall pass runs inside `agent/pre-step`, at the first step of a turn (or
when steering arrives). It builds a query from the claimed user text and scores
every active record by **trigger coverage**: the idf-weighted share of the
record's trigger vocabulary that the prompt actually uses, saturating so a
verbose trigger is not punished for its extra words, plus a smaller term for how
much of the prompt the record explains at all. Confidence, freshness, and
feedback counters weight the result.

Candidates due for a check — never checked, or checked longer ago than
`recall.probeTtlMs`, where `0` means every recall — are probed before they can
enter the packet. The probe budget is five per recall; a candidate still due
when the budget runs out is **skipped**, not served unverified. The survivors are
packed into a token budget (220 tokens by default) and appended as one synthetic
`recall`-form user message, so the packet is durable, attributable, and visible
in the transcript. A verbose record is truncated to fit rather than dropped.

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
  `confidence`, `tags`, and an optional `probe` (`path-exists` or
  `file-contains`). `demote: true` lets that write lower an existing confidence;
  `sensitivity: "private"` keeps it out of automatic recall.
- `recall` — explicit search over the store.
- `checkpoint` / `resume` — save and read the task state for this directory.
- `probe` / `feedback` / `forget` / `set_status` — maintain a record.
- `set_confidence` — lower (or raise) one record's confidence without rewriting
  its claim, for an over-confident import or a stale snapshot.
- `export` — read-only JSONL of the store, one page at a time.
- `status` — counters for this session and the store, the review hint, and a
  checkpoint left by another session.
- `report` — the per-session token/call/latency ledger.

## Private records

`user` scope is global, so a preference recorded in a one-to-one conversation
would otherwise be injected into any other conversation, including a shared one.
The gate is fail-closed and structural rather than advisory:

- `write` accepts `sensitivity: "private" | "public"` and stores it on the
  record; sensitivity is independent of owner scope;
- automatic recall drops private records unless the session is declared private
  (`recall.gatePrivate`, default on), and counts them in the ledger;
- an explicit `recall` obeys the same boundary: in a public conversation it
  returns the suppressed count only, never ids, triggers, or text. The fix is to
  switch the conversation to private, not to call the tool harder;
- `export` likewise omits private rows outside a private conversation and
  reports `privateOmitted`;
- `status` reports session visibility, private-record count, records withheld in
  this session, and whether a checkpoint was withheld — counts only;
- `reviewGroups` (the duplicate hint) excludes private records in a public
  session, so their ids and triggers do not reach a shared transcript;
- a checkpoint written in a private session is stored under a session-specific
  key; a checkpoint whose classification is unknown (written before this
  release) is withheld as a whole from other sessions, because a task state is
  not partially trustworthy.

There is no host-side signal to infer "public conversation": `SessionHeader` has
`cwd`, `parentSession`, `isSeeded`, `origin` (`subagent`), `delegationDepth`, and
`agentPreset` — nothing about audience, and `CreateSessionOptions.meta` accepts
no extra field. The declaration therefore has to come from outside: the row
config (`recall.privateSessions` / `recall.publicSessions`) or the
`memoryVisibility` service exposed for transport plugins. A public declaration
wins over a conflicting private one, and unknown means public — the
asymmetric-cost choice: withholding a private record from a shared conversation
is cheap, leaking it is not. The tool has no operation to declare a conversation
private: user or model text cannot widen its own audience.

Migration defaults:

| Record | Default treatment |
|---|---|
| `sensitivity: "private"` | withheld everywhere except private conversations |
| `sensitivity: "public"` | shared |
| no field, `scope: user`, `kind: preference` | **private until reviewed** |
| no field, any other record | public |
| checkpoint, no `sensitivity` field | **withheld from other sessions** |

For `@tencent-connect/dsh-qqbot`, the scope is known internally
(`ChatScope = 'c2c' | 'group'`) but is not exposed: no service is registered and
session ids are random (`session-<uuid>`), so it cannot be read from the session
id. The plugin does persist the mapping in `~/.dsh-qqbot/model-prefs.json`
(`sessionIds: { "qqbot:<appId>:c2c:<peer>": "session-…" }`), and this plugin can
read it once per new session — `recall.visibilityBridge: true` opts in; it is
off by default because it reads another plugin's data file. The durable fix
belongs in the transport — one call after the session is created or resumed:

```js
agent.ctx.get?.('memoryVisibility')?.set(sessionId, scope === 'c2c' ? 'private' : 'public')
```

That call also covers sessions that `/new` has since re-keyed, which the prefs
file no longer lists.

## Export and import

`export` is read-only and prints JSONL: one header line (`type: "export"`,
`format: 1`, `total`, `offset`, `limit`, `exported`) then one line per record
(`type: "memory"`, `format: 1`, `id`, `dedupeKey`, `owner`, `scope`, `kind`,
`trigger`, `claim`, `evidence`, `confidence`, `status`, `probe`, `tags`, and the
timestamps). Rows are sorted by owner, dedupe key, and id, so two exports of an
unchanged store differ only in `generatedAt`. Filters are `owner`, `scope`,
`status`, `limit` (default 100, capped at 500), and `offset`. The ledger and
event tables are intentionally excluded: they are local telemetry, not memory.

Import is **not implemented**. The constraint that shapes it is that write-time
dedupe is derived from `owner + trigger + claim`, so re-running `write` for an
imported row can merge two records that carry different ids and can silently
pick a different winner. A future importer therefore has to use the exported
`dedupeKey` to map rows back to their original record instead of relying on
claim similarity; on a conflict the newer `updatedAt` wins, and it must never
demote `confidence` or `status` as a side effect of importing. Keeping the
`dedupeKey` in every export line is what makes that mapping possible.

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
`test/`, so `node test/smoke.mjs` and `node test/regression.mjs` can be run from
the installed copy.

## Hot reload

A config edit disposes and re-applies the row, and the domain facility allows one
live handle per name. The disposer therefore returns `Promise.allSettled([store.close(), domain.close()])`,
and the replacement opens through `openDomainWithRetry`, which retries only an
`already-open` rejection, for at most two seconds. If the domain is genuinely
held elsewhere, the row logs one degraded line (`memory-core degraded: could not
open storage domain …`) and registers nothing rather than failing with a raw
storage error; the next reload retries.

## Limitations

- Retrieval is lexical, not semantic. A record whose vocabulary does not overlap
  the user's wording will not surface; write triggers in the words you would use
  to ask for it.
- Recall is free of I/O only while no probe is due; a due probe reads up to
  `probeMaxBytes` from the head plus 64 KiB from the tail. Five probes per recall
  and 40 per sweep are hard caps.
- A probe only expresses the checks the recorder declared. Records without a
  probe are never automatically invalidated.
- Distillation is a single non-tool model call; it cannot read files. Its output
  is evidence-checked only against the turn's own tool results — a candidate that
  cites nothing, cites a failed call, or makes a behavioural claim without a
  command that ran stays `proposed`.
- Self-reported confidence is not calibrated; a record written with
  `confidence: 0.9` by the model is trusted the same way as one written by hand.
  `set_confidence` makes correcting that cheap, but nothing corrects it
  automatically.
- Measurement counters are per process until flushed at turn end; a hard crash
  can lose the current turn's counters. The distillation budget is rebuilt from
  the ledger at start, so a restart does not reset the daily cap.
- Disabling `memory-core` leaves existing data on disk (re-enabling resumes it)
  and makes `memory-distill` and `memory-probe` inactive until it returns.
