# Product Requirement Document (PRD)
## ScoutFox AI Browser Agent (Chrome Extension MVP)

> **Version**: 1.0.0  
> **Status**: Approved / Draft  
> **Target Audience**: Privacy-First Power Users, Developers, & Local AI Enthusiasts (Ollama / Open-Source 8B-32B LLMs)

---

## 1. Executive Summary & Niche Definition

### 1.1 The Niche & Problem Statement
Existing browser automation agents (like MultiON, Browser-Use, Stagehand) are predominantly built for massive cloud frontier models (GPT-4o, Claude 3.5 Sonnet). When users attempt to run these agents with small, locally-hosted models (such as **Llama 3.1 8B**, **Qwen 2.5 14B/32B**, or **Gemma 2 9B** via Ollama/vLLM), the agents fail due to:
1. **DOM Bloat & Token Overflow**: Raw HTML pages contain 100k+ tokens of scripts, SVGs, and hidden containers, overwhelming 8k-32k context windows.
2. **Strict Schema Fragility**: Small models struggle with strict multi-nested JSON function calling schemas.
3. **Privacy & Cost Concerns**: Users want local, offline web automation without sending sensitive session cookies or DOM content to remote cloud servers.

### 1.2 The Value Proposition
**ScoutFox AI Browser Agent** is a lightweight, privacy-first Manifest V3 Chrome Extension engineered specifically to run reliably on **local small models (8B–32B)** as well as low-cost cloud endpoints. 

By utilizing an **Indexed DOM Distillation Engine**, **Visual On-Screen Action Badges**, and a **Fault-Tolerant Action Loop**, ScoutFox enables small local models to browse, search, extract data, click, fill forms, and automate complex web tasks directly within Chrome.

---

## 2. Product Architecture & System Component Design

### Core Components
1. **DOM Distiller & Indexer (`content/domCompressor.js`)**: Traverses visible DOM, identifies interactive elements (`a`, `button`, `input`, `select`), tags them with single-token numeric IDs `[1]`, `[2]`, `[3]`, and outputs a clean, lightweight text snapshot (< 2,500 tokens).
   Each element now reports a best-effort accessibility role (e.g. "link," "checkbox," "combobox") instead of just its raw HTML tag, plus disabled/checked/expanded state, an explicit off-screen marker, and a short preview of typed values in ordinary text fields (never for password fields).
   *Planned (decided 2026-09-28, not built yet):* stable element IDs.
   The same element keeps the same ID across snapshots, and a stale ID gives a clear error.
   Today the ID map is cleared and numbering starts again at `[1]` on every snapshot.
2. **Visual Action Overlay (`content/actionExecutor.js`)**: Injects floating numeric badges on page elements so users see target elements in real-time, then executes the model's chosen action against the indexed element.
   This now includes a stale-element fallback (re-find a moved/re-rendered element by its id, CSS path, or tag plus visible text) and a `browser_batch` bulk-action mode that correctly reports partial success/failure with a readable message, instead of a blank all-or-nothing result.
   Real clicks are dispatched via `chrome.debugger` (CDP input events) with realistic mouse hold delays, pointer events, and animated visual cursor overlay with ripples and element highlighting in content scripts, falling back to synthetic DOM events if the debugger cannot attach.
3. **Multi-Provider API Client (`background/apiClients.js`, `src/background/llm/`)**: Universal client migrated to LangChain chat model packages behind the `ApiClients` surface, supporting Ollama (`http://localhost:11434`), OpenAI-compatible endpoints (Groq, LM Studio, vLLM, Llama API), OpenAI, Anthropic Claude, and Google Gemini.
   For Ollama, the main action call now sends a JSON schema in `format` with `think:false` (constrained decoding), so the model can only answer with a real action.
   A server older than 0.5 that rejects a schema falls back to `format:"json"`, and the other providers are unchanged.
4. **Fault-Tolerant Action Loop (`background/agentEngine.js`, `src/background/agent/`, `src/background/runner/AgentRunner.ts`)**: Self-correcting execution loop with a JSON fallback parser and error recovery for 8B-32B small models.
   Hallucinated element IDs and unrecognized action verbs are now rejected as correctable parse errors instead of being silently "corrected" or failing a layer later.
   Restricted-page navigation (chrome://, the Chrome Web Store, etc.) is now blocked before it happens rather than discovered a step later, and the agent is now shown its own step-by-step plan and remaining step budget when choosing its next action.
   For Ollama, the system prompt is now a compact one (one line per action, no few-shot examples), and a reply that is one bare JSON object is parsed whole.
   The prompt for every other provider is unchanged.
   A dual-engine switch behind `settings.engine` (`'legacy'` vs `'graph'`, defaulting to `'legacy'`) selects between the legacy `AgentEngine` loop and the new LangGraph-powered `AgentRunner` at full API parity.

   **Reliability & honesty harness** (`src/background/agent/recovery.ts`, `src/background/agent/outcome.ts`):
   A failed LLM call is retried up to 3 attempts with a short backoff before the task is parked in a resumable `paused` state (naming the provider and attempt count) instead of dying as `idle`, so the existing Resume button picks up from the exact failed step.
   Hitting the step budget, an unstructured (non-JSON) model reply, and a finish with no answer are now each reported honestly - as an unfinished run, a distinctly labeled "Unconfirmed answer," or an honest no-answer - instead of looking like a normal completion.
   A new `ask_user` action lets the agent pause with a clarifying question the user can actually answer, via a new answer box in the side panel.
5. **Glassmorphism SidePanel UI (`sidepanel/`)**: Chrome Side Panel interface with Chat timeline, Provider settings (including a configurable LLM timeout), live DOM debug console, an inline answer box for the agent's clarifying questions, and distinct visual treatment for completed, unconfirmed, and failed/incomplete turns.
   *Planned (decided 2026-09-28, not built yet):* stays vanilla JS with the same messages, plus a new live graph view that shows the node the agent is in right now.

---

## 3. Next version (planned, decided 2026-09-28, revised 2026-09-29): LangGraph rework

> **Status**: Decided by Prit on 2026-09-28, and revised on 2026-09-29 after his design review.
> Phases P0a, P0, P1, P2, the answer audit provenance gate with honest finish policy, P3 (real input, CDP trusted events, and perception), P4 (Spike S5, orchestrator graph, worker subgraph, AgentRunner at API parity with AgentEngine, and dual-engine switch), and P5 (Long-Horizon Worker) are built.
> Everything in section 2 describes the current code.
> The target audience and the local-first, small-model niche from section 1 stay the same.

### 3.1 Why the direction changed
The trigger was a failed long-horizon run: "find the Framework Laptop 16 base price on frame.work DE, idealo.de and geizhals.de, and report a table".
The run took about 66 actions and collected zero prices.
The agent looped frame.work -> idealo -> frame.work -> Google.
The causes, checked against the current code:
1. **Working memory is only about 2-3 actions.**
   `formatMessagesForLLM` in `background/agentEngine.js` sends `currentTurnHistory().slice(-8)`, and each step pushes about 3 entries (`step_start`, `agent_response`, `execution_result`).
   There is no place to save findings.
2. **Failures and self-heal redirects are hidden from the model.**
   They are pushed as `error` entries, and `error` entries are never sent to the model.
   The self-heal Google query is the whole task text.
3. **The plan is not honest.**
   `updatePlanProgress` advances the checklist on any navigate, type or click.
   That checklist is shown to the model, so it is told steps are done when they are not.
   The plan is also generic.
4. **No policy for blocked sites.**
   frame.work showed a Cloudflare challenge and idealo showed error pages.
   The agent retried frame.work about 12 times.
5. **Accidental finish.**
   The model (DeepSeek via AgentRouter) emitted its native DSML tool-call syntax.
   `parseResponse` stage 6 wrapped it into an "Unconfirmed answer" finish, which ended the run by accident.

The context window was not full (estimate: about 8-12k tokens per step).
The problem was too little memory and hidden harness behaviour, not overflow and not hallucination.

### 3.2 Decision
Rebuild the whole agent on LangGraph.js.
- Use the `StateGraph` API (nodes + edges + one shared state), imported from `@langchain/langgraph/web` (the browser entry point).
- Do not use the functional API (`task` / `entrypoint`), because of an open browser bug (langchain-ai/langgraphjs#879).
- Pass config into nodes explicitly, because browsers have no `AsyncLocalStorage` and `interrupt` needs it.
- Write a custom checkpointer that saves graph state to `chrome.storage.session`, so a paused task survives the MV3 service worker being stopped.
  Today `restoreState` turns a persisted `paused` task back into `idle`, so a paused task is lost when the worker restarts.

### 3.3 In scope (same iteration)
1. **Findings ledger ("notebook")**: a new `record_finding` action.
   Findings (source, price, shipping, delivery, URL, status found/blocked) live in graph state and are shown to the model on every step.
   Lists of visited and blocked URLs are shown too.
2. **Longer memory**: history is counted in steps, not in entries.
   A `summarize` node compresses old steps into one-line summaries.
   Error and self-heal events are shown to the model.
3. **Honest plan**: one plan step per source or sub-goal.
   A step is done only when its goal is really met (for example, a finding is saved), not when any action runs.
4. **Blocked-source policy**: detect challenge pages and error pages.
   After N tries, the source is marked blocked and the agent moves on.
   A partial result table that shows the gaps is allowed.
5. **Parser never auto-finishes on tool-call formats**: DSML, `<tool_call>` or `<function_calls>` output is parsed, or it is treated as a parse error and retried.
6. **Stable element IDs** (idea taken from Claude in Chrome): a `WeakRef` map, so the same element keeps the same ID across snapshots.
   A stale ID gives a clear error instead of a silent wrong click.
7. **Real clicks via `chrome.debugger`** (CDP `Input.dispatchMouseEvent` and similar), always on while a task runs (built in phase P3).
   Chrome shows a yellow "is debugging this browser" bar; this is accepted.
   If the debugger cannot attach (for example, DevTools is open), it falls back to synthetic DOM events.
   The `debugger` permission is present in `public/manifest.json`.
   The debugger detaches after 30 minutes of pause.
8. **Approve plan first**: the agent shows its plan and the sites it will visit.
   The user approves once, then it runs (LangGraph `interrupt`).
   The plan card also shows the effort level and an estimate of the steps.
   A new task is refused while another one is paused.
9. **Build** (the Vite part is built in phase P0, 2026-09-29): TypeScript + Vite (needed anyway to bundle LangGraph for MV3).
   `npm run build` writes `dist/`, and CI zips the built `dist/` instead of the raw folders.
   The TypeScript core in `src/` is built in phase P1, and the rest of the code moves in later phases.
10. **Side panel**: the UI stays vanilla JS with the same messages, plus a new live graph view that shows the node the agent is in right now.
11. **Python runner**: `python_runner/agent.py` also moves to LangGraph (Python) in this iteration.
12. **LLM calls**: switch to LangChain chat model packages, replacing `background/apiClients.js`.
    AgentRouter has no LangChain connector.
    The plan is `ChatOpenAI` with AgentRouter's base URL and headers; this must be verified early.
13. **Small local models**: small Ollama models must keep working, so actions stay JSON text (no native tool calling).
14. **Storage**: graph state and checkpoints are saved in `chrome.storage.session` (cleared on browser restart, same as today).
15. **Tests**: rewrite the existing suite for the graph, and keep what each test guards.
16. **LangSmith tracing**: off by default, opt-in in Settings (privacy and local-first promise).
17. **Constrained decoding for Ollama** (built in phase P0a, 2026-09-29): the action JSON schema goes to Ollama's `format`, with a compact prompt and no few-shot examples.
    Measured on qwen3.5:9b and gemma4:12b: 52 to 65% fewer prompt tokens, faster answers and no broken JSON.
    The rest of the small-model strategy is planned: the model only picks the next action, code does the rest (memory, checklist, budgets, checks), and each step offers only a small list of actions.
18. **One isolated worker per site**: every site runs as its own LangGraph subgraph with private context, its own success criteria and a step budget that code computes.
    The orchestrator only sees a short summary of each finished site.
    A site is done only when code sees its criteria met.
19. **Checks after every action**: a code step compares the page before and after (URL and page structure) and finds actions that changed nothing.
    A stuck detector stops loops: it bans the repeated action, then switches strategy, then marks the site partial or blocked.
    Failed attempts are kept in a per-site failure memory that the model sees.
20. **Replan**: after a site ends, a `reflect` step can continue, replan or stop early.
    Finished sites never change, and a new domain needs the user's approval again.
21. **Risk gate**: submitting a form, logging in, buying, and leaving the approved sites wait for the user's OK.
    The agent never types passwords, card numbers or one-time codes.
22. **Provenance**: every value in the final table carries its URL, the time and a page snippet that code found, never one written by the model.
23. **Effort levels**: Low, Medium and High first, and XHigh and Max later, after real-run data.
    A level sets the step budget per site, the retries, how strictly actions are verified, how hard the agent tries to get past blocked pages, when it reflects, and the evidence checks.
    The default is Medium.
24. **Step limit**: `settings.maxSteps` becomes a hard safety cap with a default of 250, and the effort level and the site budgets limit each task.
25. **Optional later phases**: parallel sites, and a rerun of only the partial sites at a higher level.

### 3.4 Out of scope for now (maybe later)
- Native tool calling.
- Screenshots and vision.
- Prompt caching.
- MCP server (`docs/mcp.md` stays a later vision).
- Error reporting and telemetry.
- React side panel.
- Treating page text as untrusted (prompt-injection hardening).
- On-page overlay with a Stop button.
- Stronger redaction (credit card numbers, one-time codes).

### 3.5 Early checks (done 2026-09-28)
- LangGraph runs inside a real MV3 service worker, built with Vite and without `eval`.
  Browsers have no `AsyncLocalStorage`, so `interrupt` needs a small helper, and a paused task resumed correctly after the worker was stopped by force.
- LangChain chat models work from the worker, including AgentRouter (`ChatAnthropic` first, with a hand-written fallback to the OpenAI format).
- Constrained decoding works on real local models, and it is built (phase P0a).
- Real clicks through `chrome.debugger` work, including React inputs, iframes and zoom, and are built (phase P3).
  On a hidden tab they need focus emulation.
- Graph checkpoints of a subgraph with the custom saver (`SessionStorageSaver`) are verified and built (spike S5 in phase P4).

### 3.6 Next step
The design is written and phases P0a, P0, P1, P2, the answer audit provenance gate, P3, P4, and P5 are built.
- P0a: constrained decoding for Ollama (see 3.3, item 17).
- P0 (build foundation, no behaviour change): Vite builds today's JS into `dist/` (`npm run build`), you load `dist/` in Chrome, and CI runs on Node 22.x and 24.x and zips the built `dist/`.
  It also added an opt-in browser smoke test (`npm run test:e2e`) and two test helpers (`fakeChrome` and `fakeStorageSession`).
- P1 (TypeScript core): `src/` holds the storage and logger, the action registry (`shared/actions.json`), the reply parser, the outcome and recovery rules, the checkpoint saver and the interrupt shim, with `fakeLlm` and `fakeDom` next to the two P0 helpers.
  The old engine calls the new parser and registry, and behaves as before except for these parser rules.
  Tool-call markup is never turned into an answer, nested JSON is read whole, and an element id is read strictly (`"12abc"` is not 12).
  The saver and the shim are tested but not used yet.
- P2 (LangChain providers): provider fetch logic moved to LangChain chat models behind the `ApiClients` surface (`src/background/llm/`).
  ChatOllama enforces action schema with `think:false`.
  AgentRouter falls back to OpenAI format on message endpoint errors.
  Abort signals strictly handle timeout, pause, and stop.
- Answer audit provenance gate and honest finish policy: answers are checked against the session ledger.
  Unverified claims or missing planned sites are refused or annotated.

- P3 (Perception and real input): `src/background/browser/cdp.ts` and `input.ts` dispatch CDP trusted events with realistic mouse hold delays, pointer events, visual cursor overlay with ripples, element highlighting, and fallback to synthetic DOM events.
- P4 (Graph runtime foundation and dual-engine runner): Spike S5 subgraph checkpointing with `SessionStorageSaver`, orchestrator graph (`src/background/graph/orchestrator.ts`), worker subgraph (`src/background/graph/worker.ts`), and `AgentRunner` (`src/background/runner/AgentRunner.ts`) at API parity with `AgentEngine`, selectable via `settings.engine` (`'legacy'` vs `'graph'`).
- P5 (Long-Horizon Worker): multi-site orchestration and dynamic scheduling in the orchestrator graph with offer synthesis and truth table compilation (`src/background/graph/orchestrator.ts`, `src/background/agent/findings.ts`).
  Multi-mode worker policy execution (browse, extract, answer, harvest).
  Light page signature hashing (`PageSig`) and DOM state comparison (`src/background/agent/stuck.ts`).
  Step and token budgeting with slack recycling across sites (`src/background/agent/budget.ts`).
  Blocked-site escalation ladder handling challenge/error pages (`src/background/agent/blockedPolicy.ts`).
  Loop and stuck detection across URL/element/text changes.
  Failure memory with signature banning (`src/background/agent/failureMemory.ts`).
  Finding provenance snippet extraction (`src/background/agent/planEvidence.ts`).
  Default `maxSteps` upgrade from 25 to 250 with one-time storage migration and UI input up to 1,000 (`src/shared/storage.ts`, `sidepanel/sidepanel.html`).

Every phase keeps the tests green, and the graph remains selectable behind `settings.engine` while real-site evaluation and remaining graph features continue.

### 3.7 How today's harness concepts map to the planned graph
This is a summary of the design, which still waits for Prit's approval.
- **Planner** -> `plan` node (one step per site, with success criteria) + approve-plan interrupt + `reflect` and replan.
- **Reasoner** -> `policy` node (the LLM, with a small action list per mode) + the parser.
  The parser never auto-finishes on tool-call formats, and unclear output is a parse error.
- **Executor** -> `risk` gate, `execute` (real clicks, stable element IDs) and `verify` (code checks after each action).
- **Memory** -> the shared graph state (findings with provenance, visited and blocked URLs, short site summaries) + the private context of each site worker.
- **Perception** -> `perceive` node (the `content/domCompressor.js` snapshot, page type and page signature).
- **Safety** -> approve-plan interrupt + risk gate + the existing restricted-URL gate + the existing redaction.
  Prompt-injection hardening is out of scope for now.
- **Recovery** -> the blocked-site ladder by effort level, `recover` (failure memory, retries, bans), stuck detection, and checkpoints with resume.

### 3.8 Current facts
- Automated test suite runs with `node --test` across unit and integration tests (see [DEVELOPMENT.md](DEVELOPMENT.md) for details).
- `npm run check` runs `node --check` on the 7 plain JS source files (see `package.json`).
  The TypeScript files are covered by `npm run typecheck`, which runs `tsc --noEmit` on `src/` (`tsconfig.json`) and on the tests with their helpers (`tests/tsconfig.json`).
- Today the extension is built with Vite (phase P0): `npm run build` writes `dist/`, and you load `dist/` unpacked in Chrome, not the repo folder.
  The shared core, provider integration, input dispatcher, and graph engine in `src/` are TypeScript (phases P1-P5).
  The providers run on LangChain behind `ApiClients` (phase P2).
  The background worker supports both legacy `AgentEngine` and graph `AgentRunner` behind `settings.engine`.
  The legacy engine, content scripts, and side panel are still plain JS ES modules.
- CI (`.github/workflows/ci.yml`) runs on Node 22.x and 24.x: `npm ci`, check, typecheck, test, build, evalscan and a zip of the built `dist/`.
- `public/manifest.json` includes the `debugger` permission for real CDP input events.
