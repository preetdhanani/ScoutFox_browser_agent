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
   *Planned (decided 2026-09-28, not built yet):* real clicks through `chrome.debugger` (CDP input events) while a task runs.
   If the debugger cannot attach, it falls back to today's synthetic DOM events.
3. **Multi-Provider API Client (`background/apiClients.js`)**: Universal REST client supporting Ollama (`http://localhost:11434`), OpenAI-compatible endpoints (Groq, LM Studio, vLLM, Llama API), OpenAI, Anthropic Claude, and Google Gemini.
   For Ollama, the main action call now sends a JSON schema in `format` with `think:false` (constrained decoding), so the model can only answer with a real action.
   A server older than 0.5 that rejects a schema falls back to `format:"json"`, and the other providers are unchanged.
   *Planned (decided 2026-09-28, not built yet):* replaced by LangChain chat model packages.
4. **Fault-Tolerant Action Loop (`background/agentEngine.js`, `background/harness/`)**: Self-correcting execution loop with a JSON fallback parser and error recovery for 8B-32B small models.
   Hallucinated element IDs and unrecognized action verbs are now rejected as correctable parse errors instead of being silently "corrected" or failing a layer later.
   Restricted-page navigation (chrome://, the Chrome Web Store, etc.) is now blocked before it happens rather than discovered a step later, and the agent is now shown its own step-by-step plan and remaining step budget when choosing its next action.
   For Ollama, the system prompt is now a compact one (one line per action, no few-shot examples), and a reply that is one bare JSON object is parsed whole.
   The prompt for every other provider is unchanged.
   *Planned (decided 2026-09-28, not built yet):* replaced by a LangGraph.js graph (see section 3).

   **Reliability & honesty harness** (`background/harness/recovery.js`, `background/harness/outcome.js`):
   A failed LLM call is retried up to 3 attempts with a short backoff before the task is parked in a resumable `paused` state (naming the provider and attempt count) instead of dying as `idle`, so the existing Resume button picks up from the exact failed step.
   Hitting the step budget, an unstructured (non-JSON) model reply, and a finish with no answer are now each reported honestly - as an unfinished run, a distinctly labeled "Unconfirmed answer," or an honest no-answer - instead of looking like a normal completion.
   A new `ask_user` action lets the agent pause with a clarifying question the user can actually answer, via a new answer box in the side panel.
5. **Glassmorphism SidePanel UI (`sidepanel/`)**: Chrome Side Panel interface with Chat timeline, Provider settings (including a configurable LLM timeout), live DOM debug console, an inline answer box for the agent's clarifying questions, and distinct visual treatment for completed, unconfirmed, and failed/incomplete turns.
   *Planned (decided 2026-09-28, not built yet):* stays vanilla JS with the same messages, plus a new live graph view that shows the node the agent is in right now.

---

## 3. Next version (planned, decided 2026-09-28, revised 2026-09-29): LangGraph rework

> **Status**: Decided by Prit on 2026-09-28, and revised on 2026-09-29 after his design review.
> Only phase P0a is built: constrained decoding for Ollama in today's engine (see 3.3, item 17).
> Nothing else in this section is implemented.
> Everything in section 2 still describes the current code.
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
7. **Real clicks via `chrome.debugger`** (CDP `Input.dispatchMouseEvent` and similar), always on while a task runs.
   Chrome shows a yellow "is debugging this browser" bar; this is accepted.
   If the debugger cannot attach (for example, DevTools is open), it falls back to today's synthetic DOM events.
   This needs the `debugger` permission in the manifest.
   The debugger detaches after 30 minutes of pause.
8. **Approve plan first**: the agent shows its plan and the sites it will visit.
   The user approves once, then it runs (LangGraph `interrupt`).
   The plan card also shows the effort level and an estimate of the steps.
   A new task is refused while another one is paused.
9. **Build**: TypeScript + Vite (needed anyway to bundle LangGraph for MV3).
   CI must then zip the built output instead of the raw folders.
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
- Real clicks through `chrome.debugger` work, including React inputs, iframes and zoom.
  On a hidden tab they need focus emulation.
- Still to test: graph checkpoints of a subgraph with the custom saver (spike S5, the first task of phase P4).

### 3.6 Next step
The design is written and waits for Prit's review, and phase P0a is built.
Next comes phase P0, a build step with Vite and TypeScript, then the phases up to P3, and the graph itself from P4 on.
Every phase keeps the tests green, and the graph stays behind an engine switch until it works on real sites.

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

### 3.8 Current facts (checked 2026-09-29)
- `npm test`: 258 tests across 48 test files, all passing.
- `npm run check` runs `node --check` on 10 source files (see `package.json`).
- Today the extension has no build step: plain JS ES modules, loaded unpacked from the repo folder.
- CI (`.github/workflows/ci.yml`) zips the raw source folders; after the rework it must zip the built output.
- `manifest.json` does not have the `debugger` permission yet.
