# Design a token-efficient coding agent

Design a long-running coding agent that uses an LLM such as DeepSeek for reasoning and tool selection. Assume I will build it myself. Choose components that fit my runtime and explain the interfaces I need to implement. If I have supplied a codebase, inspect its actual storage, tool, event, and model-call contracts before naming integration points. Otherwise describe those interfaces in provider-neutral terms.

Optimize for **independently verified task completion per token**, with explicit targets for success rate and latency. Account for costs across sessions, including learning a fact, keeping it current, and using it later. A small edit should usually need one short decision. An unfamiliar debugging task should get enough investigation to establish the cause and verify the fix. Give me an implementable design and an evaluation plan. Full source code is optional unless I ask for it.

## Decide when the model earns a call

Build the control loop around the next consequential decision. Define observable conditions for acting, retrieving, probing, reasoning more deeply, remembering, and stopping. For each move, specify who chooses it, what it costs, and what result changes the next move.

- **Act** when the target, preconditions, permissions, and acceptance check are known. Let the runtime execute a bounded sequence such as checking expected bytes, applying an edit, and running a focused test. Return control to the model at the first unexpected result. Include a recovery rule for interruption between the edit and the test.
- **Retrieve** when prior intent, a project convention, or unfinished work could change the decision. Start with exact identifiers, paths, and lexical retrieval over short descriptions of when a memory applies. Use realistic vocabulary, including mixed-language queries if relevant. Explain which measured misses would justify semantic retrieval.
- **Probe** when the uncertainty has an observable answer. Prefer the cheapest observation that separates plausible next actions. Give the predicted outcomes before spending on an expensive experiment. Bound file reads and return compact results with references to full artifacts.
- **Reason deeply** when the remaining difficulty is inferring a correct action from available evidence. Route on ambiguity, reversibility, consequences, and failed predictions. Describe separate controls for foreground task reasoning and background learning. Map each to the selected provider's supported settings and account for required tool-call history. Return to the fast path after the decision.
- **Remember** when a finding has a likely future trigger and would cost something to rediscover, or when the user states a durable preference. Save an unfinished task's next action and acceptance condition even when the turn yields no reusable lesson.

Avoid an extra planning, routing, or reflection call for each routine action. Explain where a deterministic rule suffices and where model judgment pays for itself.

## Make memory durable, scoped, and inexpensive to question

Design four logical collections. They can share one storage engine.

| Collection | Information to retain |
|---|---|
| Memories | Owner, kind, retrieval trigger, claim, evidence reference, evidence type, optional validation probe, last check time, lifecycle state, feedback, and replacement history |
| Task checkpoints | Task identity, workspace, milestone, outstanding question, next action, acceptance condition, and pending operation if applicable |
| Usage ledger | Per-session model calls, token categories, retrieval and probe outcomes, packet size, background work, and latency |
| Events | Bounded diagnostic history sufficient to explain an injection, rejection, invalidation, or promotion |

Use the same owner identity for writes, deduplication, index rebuilds, and reads. Distinguish user-wide, project, and session knowledge. Define project identity for worktrees and nested directories, how old records acquire an owner, and what happens when identity cannot be recovered. Two projects using the same trigger for slightly different test commands must retain their own commands after restart.

Keep the claim, supporting evidence, validation probe, and evidence type together as one version. A weak restatement must preserve the stronger version's evidence. Keep incompatible claims distinguishable until authoritative evidence resolves them. Distinguish hypotheses, active records, stale records, and superseded versions. Treat recalled text as attributed historical evidence. User corrections and current observations can supersede it.

Provide explicit memory operations for writing, retrieving, checking, correcting, retiring, and giving feedback, plus checkpoint and resume. Protect a curated checkpoint from an automatic turn-end summary. Explain how concurrent tasks in one directory avoid overwriting each other's next action.

## Keep recall and learning off the critical path where possible

Define a cheap recall hook before the first relevant decision. Rank scoped candidates by trigger overlap, use the claim as secondary vocabulary, and explain how feedback and freshness affect ranking. Budget the **whole rendered packet**, including framing, evidence markers, and resume text. Start with a tunable target such as 220 tokens. Preserve the next action and acceptance condition when truncating. Deduplicate within a session, bound total injections, and emit nothing on an unrelated turn. An explicit request to resume must work even if its wording shares no terms with the checkpoint. Define how context compaction affects deduplication when earlier evidence disappears from the active window.

Support cheap probes such as checking a path or a bounded substring. Track validation time separately from edit or usage time. Zero TTL should force a check even within the same clock tick. If the foreground probe allowance runs out, skip candidates still due for validation. In the background, process the least recently checked records first and advance the check time on success as well as failure. A restored fixture can revive a stale record. State exactly what a passing probe establishes about the claim.

At turn end, update checkpoints deterministically where possible. Make optional model-assisted distillation bounded and asynchronous. As initial settings, consider requiring both a high-value turn and either several tool calls or explicit durable intent. Specify call caps, cooldowns, and token ceilings. One distillation request may propose several candidates. Require each candidate to cite identifiable results from that turn. Resolve those references, check success and relevance, and match the evidence type to the claim. Reading a test command in a guide supports what the guide says. Claiming that the test passed requires the corresponding execution result. Keep unsupported candidates provisional.

Give automatic recall, background validation, and distillation independent switches. Explicit memory lookup must remain available when automatic injection is disabled. Verify switches through the messages and calls actually observed. Include a cold-restart strategy for budgets, stale memory, and interrupted writes.

## Show the design working

Give two worked traces. Label illustrative numbers and measured results distinctly.

1. A user asks to correct a typo in CLI help. Show the minimum evidence packet, the guarded edit and check, how many model decisions it takes, and whether anything earns a durable write.
2. A parallel importer intermittently skips records after restart. Assume replay is acceptable and omission is not. Include a stale clue, a cheap discriminating experiment, the observation that warrants deeper reasoning, and an invariant the fix must preserve. Show a session interruption, the checkpoint used to resume, verification against the original failure, and the precise lesson worth storing.

For each trace, show where the runtime can continue independently and what would force it to stop. During context overflow, preserve the user contract, pending actions, unresolved alternatives, and evidence needed to verify completion. Explain how to reconcile an operation with the live environment before retrying it.

## Measure whether the design pays for itself

Compare three conditions on identical fixtures and starting memory snapshots: memory disabled, memory mounted with explicit lookup only, and memory mounted with automatic recall. Run all three through the same session type, model, tool environment, and acceptance checks. Interleave repeated trials, record cache conditions, identify runs by session ID, and verify treatment assignment from actual injections. Log voluntary lookups in the explicit-only group. Test evidence markers separately if claiming a benefit from the markers themselves.

Report task success, verified credit per total token across all attempts, cost per successful task, calls, and median and tail latency. Separate uncached input, cached input, output, and background costs. Count reasoning tokens according to provider accounting without double-counting. Measure time from the user request to verified completion. Include teaching and maintenance costs over repeated sessions. Report sample counts, variability, and the scope of any performance claim.

Exercise unrelated prompts, cross-project collisions, session isolation after reopening storage, a long checkpoint, an explicit resume query with no lexical overlap, an exhausted probe budget, and a stale record behind more healthy records than one sweep can check. Inject a crash between action and acknowledgment. Include a task whose success is independently testable after a later session resumes it. Reciting a seeded checkpoint tests delivery; fixing a failing test after resumption tests usefulness.

Deliver a coherent architecture, a compact runtime decision procedure, the minimum data schemas, the two traces, the main engineering trade-offs, and a staged implementation and evaluation plan. Identify the smallest version worth shipping and the evidence that would justify each subsequent layer.
