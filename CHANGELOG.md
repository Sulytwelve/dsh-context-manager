# Changelog

All notable changes to `@sulytwelve/dsh-context-manager` (formerly
`@sulytwelve/dsh-memory-astra62`). Versions are Git tags; the tag is the release.

## 1.4.1

- Docs: a complete backup requires a private conversation (a public export
  reports `privateOmitted` and leaves those rows out); the import revival edge is
  spelled out — the status strength order (`active` > `proposed` > `stale` >
  `superseded`) is part of the import contract, so a newer row from a machine
  that never probed can revive a local `stale`/`superseded` record to `active`,
  and the duplicate then surfaces in the review hint; the QQ bridge is a
  snapshot read at start and on each new session's first step, not a live
  watcher. Two regression cases pin the ladder (a newer active row revives a
  superseded record; a newer proposed row reopens a stale one as proposed).

## 1.5.0

- **The bridge is live.** The QQ-prefs bridge no longer reads the file only at
  start and on a new session's first step: it re-reads when the file's
  mtime/size changes (checked once per step), so a session created after boot is
  mapped before its first recall and a mid-session change is picked up on the
  next step. It remains off by default and is still a foreign-file read.
- **The transport patch ships.** `integrations/dsh-qqbot-memory-visibility.patch`
  is a validated, fail-soft patch for the MIT-licensed `@tencent-connect/dsh-qqbot`
  that calls `memoryVisibility` after a session is created, resumed, or re-forked
  — the durable replacement for the bridge. `integrations/README.md` documents
  applying it. Once it lands, the bridge can be deleted.

## 1.4.0

- **Import.** `memory{op:"import"}` reads export JSONL from `path` or inline
  `payload`, maps rows to records by `owner + dedupeKey`, and is idempotent: an
  unchanged export imported twice changes nothing. A newer `updatedAt` wins, an
  older or equal row is skipped, and an import never demotes local state —
  confidence keeps the higher value, status keeps the stronger one. Wrong
  `format` or a row missing id/dedupeKey/trigger/claim is rejected whole; damaged
  JSONL lines are reported by line number. `export` → `import` → `export` is
  identical (ids, keys, timestamps, provenance preserved).
- **`report` explains rejections.** The last recall's rejection summary is
  printed as reason counts (no-overlap / below-threshold / private /
  probe-failed / probe-budget / token-budget / packet-limit) plus the three
  highest-scoring rejected candidates. A private-gated candidate is named only
  as "withheld" in a public session.
- **Docs.** Added this changelog and annotated `docs/prompt.md` with the design
  baseline it was written against.

## 1.3.3

- **Hot-reload fix.** Editing `cordis.patch.yml` re-applies the row while the
  previous instance still holds the storage domain; the new `open()` lost the
  race (`domain 'agent_memory' is already open`) and the tool vanished. The
  disposer now returns the close promises, and `openDomainWithRetry` retries
  only an `already-open` rejection for up to two seconds. A permanent conflict
  logs one degraded line instead of failing the row.

## 1.3.2

- A write acknowledgment mentions privacy only when the record is actually
  private (1.3.1 appended the sentence to every write).

## 1.3.1

- **Fail-closed audience gate** (field-audit T4). `write` accepts
  `sensitivity: "private" | "public"`. Automatic recall, explicit `recall`, and
  `export` all withhold private content outside a private conversation and
  report counts only. The `visibility` tool op was removed: text cannot widen
  its own audience; transports declare visibility through `memoryVisibility`,
  and a public declaration wins over a conflicting private one. Legacy personal
  preferences (`scope: user`, `kind: preference`, no field) are private until
  reviewed; a checkpoint with no classification is withheld from other sessions.
  The QQ bot prefs bridge is opt-in (`recall.visibilityBridge`).
- `status` reports visibility, private-record count, withheld records, and a
  withheld checkpoint, without ids or excerpts.

## 1.3.0

- **Read-only export.** `memory{op:"export"}` prints stable JSONL (header + one
  line per record) with `format: 1`, `id`, `dedupeKey`, `owner`, claims, probes,
  and timestamps; paginated by owner/scope/status/offset, and intentionally
  excludes the ledger and event ring. The `dedupeKey` is the field import maps
  on.

## 1.2.0

- **Probes are three-valued.** `runProbe` returns pass / fail / inconclusive;
  only `fail` retires a record. `file-contains` reads the head and, on a miss,
  the last 64 KiB, so a match in the tail is found and a larger file is
  inconclusive instead of a false negative that the sweep could never clear.
- **Confidence can come down.** `memory{op:"set_confidence"}` and
  `write{demote:true}` lower a value without rewriting the claim; ordinary
  restatements still only raise it.
- **Checkpoint and budget visibility.** A skipped turn-end checkpoint emits
  `checkpoint-skipped`; `status` names another session's checkpoint. The daily
  distillation budget is rebuilt from the ledger on start.
- **Portability and hardening.** `normalizeCwd` folds case only on Windows and
  macOS; user-scope probes must be absolute; each row checks the host surface it
  needs and logs one "DSH version incompatible" line; `test/` ships in the
  package.

## 1.1.9

- `status` ends with a read-only review hint: scope+trigger groups that hold more
  than one active record, with their ids. It is a fact to inspect, not a
  conflict verdict, and it changes no state.

## 1.1.8

- README documents where the plugin, its data, and the desktop profile actually
  live, including install-path differences between CLI and the desktop app.

## 1.1.7

- npm package renamed to `@sulytwelve/dsh-context-manager` (row ids, the
  `memory` tool, and the `agent_memory` storage domain are unchanged).

## 1.1.6

- The two subpath rows have their own display name and icon.

## 1.1.5

- Repositioned as "DSH Context Manager"; repository renamed in place.

## 1.1.4

- README summarizes the measured results (the audited baseline).

## 1.1.3

- `recall.enabled: false` really disables the recall listener instead of only
  being printed at boot.

## 1.1.2

- The resume line is capped against the packet token budget.

## 1.1.1

- Resume intent no longer requires lexical overlap with the checkpoint;
  distillation's outcome classifier is word-bounded (`workspace` is not a
  "pass").

## 1.1.0

- Scope isolation (owner per record), fair probe scheduling, and evidence-checked
  distillation.
