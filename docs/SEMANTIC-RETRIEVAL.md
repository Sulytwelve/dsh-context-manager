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
   (frequent concepts self-dampen). Groups merge when a normalized key
   intersects — the Latin stem (`backups`/`backup`) or the exact CJK phrase, so
   two genuinely different Chinese phrases are not guessed to be synonyms.
   `link{remove:true}` deletes a visible group. The dictionary is **shared by
   every conversation of the bot**: there is no private/group split and no
   chat-type API involved. A fresh install starts with an **empty** dictionary
   — the first reworded miss is the price of not shipping guesses.

3. **Per-record aliases (agent-written, failure-driven).** Every record can
   carry `aliases`: other short wordings for the situation its trigger
   covers. They come from `write{aliases}`, from import, and from the
   enrichment call below. In scoring, an alias-only match contributes a
   trigger hit at **0.7 weight**. That is enough to surface a record the literal
   trigger would hide, but it does not guarantee order: confidence, freshness,
   and feedback are multipliers, so a strongly preferred aliased record can
   still rank above a weak literal one. Aliases merge, never replace; `aliasAt`
   timestamps the last growth.

## The failure-driven call

`memory-distill` (the only model-calling row) listens at turn end. If this
turn's last **automatic** recall produced **zero hits** against non-empty
candidates — the exact signature of the reported failure — it spends one
bounded call whose prompt contains the failed user question and up to eight
rejected candidates (also capped by a prompt-token ceiling). The model may
answer that none applies; if it picks records, aliases are merged for those
records, and when it is confident, up to two shared synonym groups enter the
dictionary. Rules:

- the automatic recall summary is saved per session and consumed once, so an
  explicit `memory{op:"recall"}` later in the same turn cannot replace the
  user's wording;
- budgets are its own and persisted before the request (≤4/session, ≤6/day,
  45 s cooldown, `llm.enrich: false` disables);
- a record enriched once is not re-billed within a 7-day cooldown
  (`aliasAt`);
- with `llm.enabled: false` the whole layer is inert and the dictionary is
  exactly what the agent wrote through `link`/`write`.

Cost profile: zero while matching works; one small call the *first* time a
wording family misses and the target is inside the candidate window; then free
for that learned wording. If the target is outside the window, the call cannot
learn it — use `link` or `write{aliases}` explicitly. This is the deliberate
answer to "自动蒸馏白耗 token" — enrichment never runs on a schedule, only on
evidence that retrieval actually failed.

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
  bounded by the distill row — and it is inspectable (`status`, `export`) and
  editable (`link`) by the very agent that uses it.

Nothing in 1.7.0 implements vectors; this section exists so the seam is
designed, not discovered later.
