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
  `file-contents`).
- `recall` — explicit search over the store.
- `checkpoint` / `resume` — save and read the task state for this directory.
- `probe` / `feedback` / `forget` / `set_status` — maintain a record.
- `status` — counters for this session and the store.

## Limitations

- Retrieval is lexical, not semantic. A record whose vocabulary does not overlap
  the user's wording will not surface; write triggers in the words you would use
  to ask for it.
- Recall is free of I/O only while no probe is due; a due probe reads its target
  file, bounded by `probeMaxBytes`. Five probes per recall and 40 per sweep are
  hard caps.
- A probe only expresses the checks the recorder declared. Records without a
  probe are never automatically invalidated.
- Distillation is a single non-tool model call; it cannot read files. Its output
  is evidence-checked only against the turn's own tool results — a candidate that
  cites nothing, cites a failed call, or makes a behavioural claim without a
  command that ran stays `proposed`.
- Self-reported confidence is not calibrated; a record written with
  `confidence: 0.9` by the model is trusted the same way as one written by hand.
- Measurement counters are per process until flushed at turn end; a hard crash
  can lose the current turn's counters.
- Disabling `memory-core` leaves existing data on disk (re-enabling resumes it)
  and makes `memory-distill` and `memory-probe` inactive until it returns.
