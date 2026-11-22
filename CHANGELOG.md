# Changelog

All notable changes to `@sulytwelve/dsh-context-manager` (formerly
`@sulytwelve/dsh-memory-astra62`). Versions are Git tags; the tag is the release.

## 1.7.0

Semantic retrieval: wordings that mean the same thing now find each other, and
the vocabulary connecting them is written by the agent at runtime — nothing
semantic is hardcoded in this package.

- **Learned concept dictionary.** A new `concepts` table plus
  `memory{op:"link", forms:[...]}`: the agent declares surface forms that
  always mean the same thing (`密码库` = `vaultwarden`). Groups merge when they
  share a form, `remove: true` deletes the group holding a form, and both the
  query and every record pass through the learned index — so a reworded
  question reaches the record in either language or phrasing. The dictionary
  survives restarts and migrates through export/import (`type: "concept"` rows
  on `all: true` or a private export; a default public export reports
  `conceptsOmitted`).
- **Failure-driven alias enrichment.** When a turn's last recall produced zero
  hits against non-empty candidates, one bounded model call (in the distill
  row, off the hot path, with its own persisted budget — ≤4 per session, ≤6
  per day, 45 s cooldown) asks the model to write retrieval aliases for the
  top rejected records and confident synonym groups for the store. The same
  wording misses once, then matches forever, on a recall path that never
  calls a model. Private records are never sent to a call made from a public
  conversation; `llm.enrich: false` keeps the row to distillation only.
- **Record aliases.** `write` accepts `aliases` (merged, never replaced).
  Alias-only matches count as triggers at 0.7 weight — enough to surface,
  never enough to outrank a literal trigger match. `aliasAt` drives the
  re-enrich cooldown; aliases travel through export and import.
- **Latin stem folding.** Generic morphology, not a dictionary:
  `backups` → `backup`, `restarting` → `restart`, while `alias`, `status`,
  `dns` stay whole; applied consistently to queries, records, and learned
  forms so both sides always fold the same way.
- **Rejection diagnostics.** The last recall's rejection summary keeps the
  failed query and the hit count (in memory only), which is how the
  enrichment learns from the exact wording that missed.
- Docs: `docs/SEMANTIC-RETRIEVAL.md` describes the three layers and the
  reserved seam a vector tier would plug into. Suites are now 18 + 132 + 13
  checks.

## 1.6.1

Security and correctness pass from an external review of 1.6.0.

- **Checkpoints persist again.** The task schema did not declare `sensitivity`,
  so the domain's read-boundary schema parse dropped it and every public
  checkpoint reopened as "unknown" (withheld); the private checkpoint key also
  contained `|`, which the JSON backend rejects as an unsafe path segment, so no
  private checkpoint could be written. Both fixed; the test harness now enforces
  the backend's key rule and the domain schemas.
- **Diagnostics follow the audience.** `status` is session-scoped and, outside a
  private conversation, shows only events explicitly marked public; legacy
  free-text events are treated as unknown and hidden. Write, probe, inject,
  distill, and checkpoint-skip events carry their audience. The `gatePrivate`
  config switch is gone: automatic and explicit recall use one fail-closed rule.
- **The packet budget is enforced by the estimator.** The resume line was
  clipped by a Latin-character ratio, so a Chinese checkpoint produced a
  395-token packet against a 220-token budget. Clipping, the session remainder,
  and the final body are measured with the same estimator; only rendered records
  are marked injected.
- **Owner-scoped management.** `forget`/`set_status`/`set_confidence`/`probe`/
  `feedback`, `supersedes`, and `export` respect the caller's owner; `export`
  gains `all: true` for the operator-wide path. Writes from a private
  conversation default to private.
- **Import is validated.** Paths resolve against the working directory, size is
  checked in bytes before reading, ids/owners/scopes/probes are validated, and
  claim + evidence + probe + support + check time move as one version.
- **Probe scheduling.** The sweep filters the whole store by due state instead of
  the 5,000 most recently updated records; a stale record that fails again
  advances its clock; session-scope probes keep their directory; a late verdict
  for a replaced probe is ignored.
- **Distillation accounting.** The cooldown is enforced, the attempt is reserved
  and persisted before the request, the per-day counter and last-attempt time
  are recovered from the ledger, and per-row state is created inside `apply`.
- **Packaging and docs.** The shipped `bench:setup` script is gone (bench is
  checkout-only); CI runs Node 20/22/24 and re-tests the packed tarball; the
  README documents install-time cost/defaults, the two backup operations, the
  export scope, and verified Node/host combinations. New `test/tool.mjs` covers
  the tool entry; suites are now 18 + 104 + 10 checks.

## 1.6.0

- **Probe I/O is asynchronous.** `runProbe` now uses `node:fs/promises`; the
  recall path, the explicit `probe` op, and the background sweep all await a
  bounded read instead of blocking the Host event loop for up to 320 KiB per
  check. The QQ bridge's change stamp and prefs read are asynchronous too. The
  three-valued semantics are unchanged; one edge is more honest: a
  `path-exists` target that exists but cannot be read is `inconclusive`, not a
  false `fail`. The import file read is asynchronous as well.
- **Import is bounded by the clock.** A row whose `updatedAt` is missing or more
  than a day in the future is rejected: such a row would win the "newer wins"
  comparison forever, and no later import could correct it. A day of clock skew
  is tolerated, and plausibly dated rows still round-trip unchanged.
- **`resolveId` is one pass.** Record lookup by full id or unambiguous suffix no
  longer sorts the whole table up to three times; the store resolves it from the
  table keys, and the tool reads the follow-up record with `get`.
- **Docs match the code.** The README now says which layer owns each default:
  the shipped bundle patch (`llm.enabled: true`, `threshold: 4`) versus the
  module fallback (`false`, `3`) that applies only to a bare row.
- Housekeeping: removed the dead `state.lastTurn` field and the unused
  `sampleOf`; the per-turn sample map is bounded and dropped on
  `agent/disposed`; the resume-overlap (0.08), restatement (0.35), and scoring
  weights are documented at their call sites; the 3.6-chars/token estimator
  margin over the Host's 4-char heuristic is explained.
- CI: a GitHub Actions workflow runs `node test/smoke.mjs` and
  `node test/regression.mjs` on Node 20 and 22. Regression is now 82 checks.

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
