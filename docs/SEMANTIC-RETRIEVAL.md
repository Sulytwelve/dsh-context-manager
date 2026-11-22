# Semantic retrieval: design and the vector seam

The operator's live test that drove this release, four reworded queries
against a real store:

| Query | Result on 1.6.1 |
|---|---|
| 代理重启怎么弄 | 3/3 correct |
| 玩客云 ssh 连不上 | 3/3 correct |
| 热点连不上 | 2 correct, 1 unrelated |
| **密码库备份在哪** | **0/3 — the vaultwarden record was not recalled**; R2 backup, encrypted photos, and old Hermes data were |

The failure was structural, not a tuning bug: retrieval scored literal
trigger overlap (idf-weighted coverage over Latin words and CJK bigrams), so
any record whose wording did not share a surface form with the question was
invisible. The fix had one hard rule from the author: **the dictionary is
never hardcoded in the package — the agent writes it.**

## The three layers

1. **Generic morphology (built in).** Latin tokens fold to a shared base form
   (`stemLatin` in `lib/lexicon.js`): `backups` → `backup`, `restarting` →
   `restart`, `proxies` → `proxy`. Words whose final *s* is part of the
   singular (`alias`, `status`, `basis`) stay whole. This is rule-based text
   normalization, applied identically to queries, record text, and learned
   forms — it contains no knowledge about what any word *means*.

2. **The learned concept dictionary (agent-written).** A `concepts` table in
   the `agent_memory` domain holds synonym groups: sets of surface forms the
   agent declared equivalent. Written through
   `memory{op:"link", forms:["密码库","vaultwarden","bitwarden"]}`, grown by
   import, and — automatically — by layer 3. Both sides of recall pass through
   the built index (`buildConceptIndex`): a query carrying `密码库` and a
   record carrying `vaultwarden` both emit the same concept token, which then
   scores like any other trigger term under the existing idf machinery
   (frequent concepts self-dampen). Groups merge when they share a form, so
   the table stays a partition of the learned vocabulary;
   `link{remove:true}` deletes. A fresh install starts with an **empty**
   dictionary — the first reworded miss is the price of not shipping
   guesses.

3. **Per-record aliases (agent-written, failure-driven).** Every record can
   carry `aliases`: other short wordings for the situation its trigger
   covers. They come from `write{aliases}`, from import, and from the
   enrichment call below. In scoring, an alias-only match counts as a trigger
   at **0.7 weight** — enough to surface a record the literal trigger would
   hide, never enough to outrank a literal match. Aliases merge, never
   replace; `aliasAt` timestamps the last growth.

## The failure-driven call

`memory-distill` (the only model-calling row) listens at turn end. If this
turn's last recall produced **zero hits** against non-empty candidates — the
exact signature of the reported failure — it spends one bounded call whose
prompt contains the failed question and the top rejected records, and writes
back aliases for those records plus, when the model is confident, up to two
store-wide synonym groups. Rules:

- the query that missed is remembered (in memory) so the call learns from the
  user's actual wording, not a guess;
- budgets are its own and persisted before the request (≤4/session, ≤6/day,
  45 s cooldown, `llm.enrich: false` disables);
- a private record's text is never sent to a call made from a public
  conversation — the audience rule outranks the repair;
- a record enriched once is not re-billed within a 7-day cooldown
  (`aliasAt`);
- with `llm.enabled: false` the whole layer is inert and the dictionary is
  exactly what the agent wrote through `link`/`write`.

Cost profile: zero while matching works; one small call the *first* time a
wording family misses; free forever after. This is the deliberate answer to
"自动蒸馏白耗 token" — enrichment never runs on a schedule, only on evidence
that retrieval actually failed.

## The reserved vector seam

This design keeps the two standing promises (zero runtime dependencies; no
model calls on the recall path) while leaving a defined place for a true
vector tier, should measurements ever demand one:

- **Storage.** The record schema is additive (the domain declares fields and
  drops unknown ones on read, so a new field is a one-line schema addition).
  A vector tier would declare a `vectors` field computed exactly where the
  enrichment call runs today — the existing off-hot-path, budgeted,
  failure-aware hook after each turn.
- **Scoring.** Recall builds its candidate list in one pure in-memory pass;
  a provider would mix a cosine score into `score` alongside
  `triggerScore`/`queryCoverage`/alias coverage, with the same saturation and
  threshold machinery.
- **Why not yet.** A local embedding model costs a runtime dependency plus a
  model download at install; a remote embedding API costs a network call
  per write and per query. Both break a promise the README makes today. The
  learned dictionary approximates the same connections at a cost already
  bounded by the distill row — and it is inspectable (`status`,
  `export all:true`) and editable (`link`) by the very agent that uses it.

Nothing in 1.7.0 implements vectors; this section exists so the seam is
designed, not discovered later.
