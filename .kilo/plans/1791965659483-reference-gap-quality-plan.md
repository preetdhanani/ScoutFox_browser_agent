# Plan: Close the verified gaps - reach reference-level performance on the current architecture

## Status of prior phases (complete, evidence on disk)

- Phase 1 analysis: DONE. 27 fact files (1,011 facts), 11 compare files (126 raw gaps), 22 skeptic files (47 verdicts, 0 refuted). Outputs in `docs/reference-gap/`.
- Phase 1 synthesis: DONE. `GAP-REPORT.md`, `gaps.json` (106 merged gaps: 2 P0, 19 P1, 71 P2, 14 P3), `REFERENCE-MAP.md`.
- Phase 2 roadmap: DONE. 21 self-contained tickets in `docs/reference-gap/tickets/`, independent review passed (`tickets/REVIEW.md`, 6 corrections applied), `ROADMAP.md` written with waves and dependencies.
- Interactive review aid: `docs/reference-gap/gap-explorer.html` (served at http://127.0.0.1:8643/gap-explorer.html).
- Owner decision (2026-10-14): quality first, speed wins ride along; the current architecture stays.

## What was found, in one view

| Theme | Gaps | The one-line why it matters |
| --- | --- | --- |
| Honest outcomes | 16 | Runs that did not finish render as a green Done card - the trust-deciding screen lies. |
| Planning, memory, continuity | 27 | The agent forgets across steps, sites and tasks; the plan gate exists in code but never for the user. |
| Reliability, model strategy, observability | 34 | Provider failures, restarts and silent downgrades are handled blind - the weakest engineering area. |
| Safety and approvals | 13 | Buy, sign-up and submit controls can run without a confirm card, and approval cards hide what you approve. |
| Perception and element access | 8 | The agent sees less than you do: prices in div/span, elements past the first 120, iframes. |
| Action truthfulness | 8 | Clicks and scrolls report success without checking that anything changed. |

- The two P0s: `stop-early-reported-as-success` (a multi-shop comparison can stop after shop 1 and show Done) and `page-text-extractor-whitelist` (prices inside div/span never reach the model - the core task goes blind).
- The reference is not flawless: 12 of 47 claims about it came back weak or not found; it has no answer audit and no price parser; ScoutFox is already ahead in 11 places (evidence ledger, occlusion probe, bounded runs, checkpoints, test depth).

## Why the gaps exist - the architecture diagnosis

Six root causes, each mapped to the module that owns it. This is why the gaps cluster the way they do.

1. Perception was built as one shot with a small window. `src/content/domCompressor.ts` lists the first 120 elements in DOM order with no marker, `src/content/pageText.ts` reads only a tag whitelist, and there is no find helper. The reference instead ships a full accessibility tree with announced caps plus a cheap side-model find call. The current architecture absorbs the fix: perception is a pure layer below the graph, so a find verb and tree pagination change no graph node.
2. The execute layer is fail-soft where the reference is fail-loud. `src/background/browser/execute.ts` defaults effect to `dom_changed`, `input.ts` silently falls back from CDP to synthetic events, and nothing sets `StepFailure.fallbackUsed`. Root cause: an early design choice to keep the loop moving. The fix is contained in `browser/*` plus test updates that currently pin the fallbacks as intended.
3. The terminal-state contract was never finished. `state.ts:290` documents that `partial_result` is never a Done, yet `orchestrator.ts` compileNode trusts the reflect fast path and `sidepanel.js` renders every answer without an audit as green Done. The states exist; the compile and render halves of the contract do not. This is contract completion, not redesign - which is why it is Wave 1.
4. Memory and state wiring is half-done. The graph builds per-site memory blocks (`siteIn.recap`, `earlierSites`, `visitedRecent`, `blocked`, `priorFindings` at `orchestrator.ts:717-729`) that the worker never passes to the prompt builder, and the per-turn reset list misses findings, approvals and domain grants. The fields exist in state; the wiring was left undone.
5. The LLM boundary has no error taxonomy. `llm/index.ts:60-70` throws a plain `Error` with the HTTP status only inside the message text, so `recovery.ts` cannot distinguish 401 from 429 from context overflow; retries are 3 attempts with under 1 s of backoff. Root cause: a many-provider design with a lowest-common-denominator error model. The fix is one typed `ProviderError` at the boundary - a contained, architecture-compatible change.
6. The risk gate is real but incomplete, and approvals are auto. `agent/risk.ts` classifies semantically and fails closed (a strength), but the coverage misses common purchase, submit and account-creation controls; `AgentRunner.ts:1063-1080` auto-approves every plan and replan, so the human gate is a no-op. Completing coverage and making scope growth visible are ticket-sized changes.

Architecture compatibility verdict: 19 of the 21 P0/P1 tickets complete existing contracts or wire existing state. Two add a mechanism inside the architecture (the find verb; the `ProviderError` type). None requires touching the LangGraph shape. The true architecture changes - native tool calling, conversation continuity, vision - are exactly the 8 `needs_strong_model` gaps parked in Track B, which matches the owner's quality-first instruction.

## The plan - four waves, quality first (owner-confirmed)

### Wave 1 - honesty, safety, perception truth (17 tickets, all model-independent)

Why this order: every other improvement is unmeasurable while the result screen can lie, so the trust chain lands first; perception truth follows because the agent can only act on what it sees; safety rides in the same wave because the tickets share files and review attention.

1. `page-text-extractor-whitelist` (P0) - the extractor rewrite; everything downstream reads its output.
2. `silent-truncation-no-marker` - markers on the cap sites that survive the rewrite.
3. `stop-early-reported-as-success` (P0) - engine side: compile computes partial from per-site statuses, pending sites are marked skipped.
4. `partial-runs-render-as-done` - the panel partial card; same wave, after the engine flag exists.
5. `subgoal-done-bypasses-answer-audit` - close the verb loophole around the audit.
6. `per-turn-state-leak` - reset findings, approvals and domain grants per task.
7. `memory-blocks-not-rendered` - wire the built memory blocks into the prompt.
8. `risk-gate-coverage-holes` - purchase, submit and account-creation controls.
9. `confirm-card-blind-approval` - show what the user approves, including JavaScript.
10. `replan-domain-auto-approved` - a replan that adds a domain needs a human gate.
11. `plan-silently-rewritten-by-code` - cap alignment, namedByUser derivation, override notice.
12. `llm-retry-blind-and-short` - typed `ProviderError`, class-aware retry with real backoff.
13. `cdp-synthetic-fallback` - fail loud, mark synthetic, effect probe on synthetic actions.
14. `signature-too-coarse-false-stuck` - stop counting normal scrolling as a loop.
15. `element-window-dom-order-unmarked` - announce the cut, keep user-named elements.
16. `selector-only-addressing` - clickable details, styled labels, role options.
17. `no-recorded-real-page-corpus` - recorded real pages so extractor and perception fixes are provable (L effort, tests only, may run in parallel or last).

Speed bonus in this wave: the `stacked-post-click-waits` P2 fix (skip waiting for a load event that has already passed, 4-9.5 s per step today) rides along with the browser-layer tickets since the same files are open.

### Wave 2 - reach and memory (4 P1 tickets that also help small models)

1. `find-elements-beyond-window` - the find verb plus side prompt, implemented together with the element-window ticket.
2. `in-run-memory-window` - scale memory with effort tier, fold line for long runs.
3. `planner-fallback-invented-plan` - single owner of the planner parse-failure path (repair retry, visible pause or banner).
4. `tab-set-invisible-closed-tab-fatal` - the model sees tabs; closing the working tab pauses instead of killing the run.

Why here: these need the Wave 1 ground truth (marked caps, honest compile) to be testable, and they are the gaps that most affect small local models.

### Wave 3 - polish (71 P2 gaps, unverified)

- Batched by theme from `GAP-REPORT.md`, cheapest impact first.
- Each gap gets a quick skeptic re-check (lisa-flash search, lisa-pro verdict) before its fix, because none were verified.
- Includes the 24 original P0/P1 claims the skeptics downgraded to P2.

### Track B - after quality (8 needs_strong_model gaps)

- Native tool calling and schema for cloud providers; conversation continuity across steps; the screenshot and vision path; batching nudge; tier detection; examples and format rules; English-only heuristics.
- Why parked: they need a stronger model or vision to pay off, and two of them (native tools, continuity) are the only real architecture changes in the whole set.

## Execution mechanics (unchanged, proven in Phases 1-2)

- One ticket per subagent run, briefed only by its ticket file; mechanical edits on lisa-flash (`gap-reader`), design and debugging on lisa-pro (`gap-judge`).
- Subagent work runs through the CLI runtime (`kilo run -m iisys/lisa-pro --auto`) because the desktop session cannot register the custom agents; smoke-tested and working.
- Tests first with a negative control (the new test must fail on unfixed code), then the fix, then `npm run typecheck`, `npm test`, `npm run test:e2e`.
- `PROGRESS.md` is the checkpoint after every ticket; `/gap-continue` or "continue" resumes from disk state; nothing finished is redone.
- Merge-conflict control: the memory tickets run consecutively; the compile-touching tickets (stop-early, subgoal-done) run consecutively.

## Product decisions resolved at ticket time (recommended defaults)

1. Plan approval: keep auto-approval as default, add the visible replan-domain gate (ticket 10). Revisit as a setting later.
2. Injection defence: build the "page text is data, not instructions" framing in Wave 3 (cheap prompt change), defer full escaping.
3. Site blocklist: ship the mechanism plus a small default list (banking, payments, health, adult).
4. execute_js: opt-in, default off, like the reference - decided with ticket 9.
5. Verification knobs: implement the cheap ones (second source, cross-check), delete the vision promise from effort.json until Track B.
6. Two-site cross-check: report a plain difference with no downgrade (the current semantics punish the cheaper shop).
7. Real-page corpus: build in Wave 1 as planned; it is the only ticket that makes perception fixes provable against real sites.

## Validation

- Per ticket: typecheck, unit tests, e2e smoke, negative control green.
- Per wave: full suite plus one manual run of a real task in the loaded extension.
- After Wave 1 specifically: manually stop a run mid-way, hit a blocked site and force a step cap - no green Done card may appear for an unfinished run; run a price-comparison task on a div/span-heavy shop and confirm the price reaches the answer.
- After Wave 2: run the same task on an Ollama 8B model and on a cloud model, compare step quality and memory behaviour.

## Risks

- Token budget: run tickets in small batches (2-3 concurrent CLI sessions maximum), checkpoint per ticket, resume with `/gap-continue`.
- The corpus ticket is the only L-effort item: pre-approved to split into recorder-plus-corpus and CI-alarm halves if it stalls.
- Test updates that pin today's wrong behaviour (input fallbacks, stop-early partial false) must be changed in the same ticket as the fix, never silently deleted.

## Out of scope

- Replacing LangGraph, the stateless-step design, or the provider layer.
- Native tool calling, conversation continuity and vision (Track B, after quality).
- Any reference code or prompt text copied into the repo.
