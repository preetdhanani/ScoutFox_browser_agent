# 🛠️ Development & Chrome Publishing Guide

> Developer guidelines for building, testing, and submitting **ScoutFox AI Browser Agent** to the Chrome Web Store.

---

## 1. Local Development Workflow

### Setup
You need Node.js 22.18 or newer and Chrome.
Follow **Quick Setup** in [README.md](README.md): `npm ci`, `npm run build`, then **Load unpacked** on the `dist/` folder (not the repository folder).

### Extension Reloading
Chrome runs the built files in `dist/`, not the sources, so build again after every code change.
When modifying background scripts, content scripts, or sidepanel UI:
1. Run `npm run build`.
2. Go to `chrome://extensions`.
3. Locate **ScoutFox AI Browser Agent** (the `name` field in `public/manifest.json`).
4. Click the **Reload (🔄)** icon on the extension card.
5. If testing content script DOM changes, refresh the target web page tab as well.

### Scripts
| Script | What it does |
| --- | --- |
| `npm run build` | Builds the extension into `dist/` with Vite, then checks that `dist/` can be loaded (manifest paths, one-file worker, classic content scripts, that every function passed to `executeScript({ func })` uses only its own names and page globals, that zod's jitless flag is set before any library code, reserved `_` names, page references). Any bundler warning that is not on the short list in `vite.config.mjs` fails it. It prints the size of every file, raw and gzip. |
| `npm run check` | Runs `node --check` on the 7 plain JS source files listed in `package.json` (the `.ts` files are covered by `typecheck`). |
| `npm run typecheck` | Runs `tsc --noEmit` twice (TypeScript 7): over `src/` with `tsconfig.json`, and over the tests, their helpers and `src/` again with `tests/tsconfig.json`. |
| `npm test` | Runs the unit tests (`tests/**/*.test.js` and `tests/**/*.test.ts`) with `node --test`, no browser and no build step needed: Node runs the `.ts` files by stripping their types. |
| `npm run evalscan` | Fails when `dist/` calls `eval`, `new Function` or `Function()` (five hits are allowed, see "Worker Bundle and CSP" in section 3), so run `npm run build` first. |
| `npm run zip` | Zips the contents of `dist/` into `scoutfox-chrome-extension.zip` in the repository root, without sourcemaps, so run `npm run build` first. |
| `npm run test:e2e` | Builds, then runs the browser smoke test in Chromium against an offline mock model (needs a one-time setup, see "E2E Smoke" in section 3). |

### CI
`.github/workflows/ci.yml` runs on every push to `main` or `dev` and on every pull request into them, on Node 22.x and 24.x.
It runs `npm ci`, `npm run check`, `npm run typecheck`, `npm test`, `npm run build`, `npm run evalscan` and `npm run zip`.
On a push, the Node 22.x run uploads the zip as the `scoutfox-chrome-extension` artifact.
Flaky tests are fixed, never retried.

---

## 2. Testing Extension Logic

### Service Worker Logs
To inspect background service worker output:
1. Navigate to `chrome://extensions`.
2. Find the ScoutFox AI Browser Agent extension.
3. Click **service worker** link under "Inspect views".
4. Developer Tools console will open for the background worker.

The worker is one bundled file, `background/sw.js`, built from `background/background.js` and the modules it imports (`agentEngine.js`, `apiClients.js` and so on).
DevTools shows `background/sw.js`.
The code is not minified, so it stays readable, and the `//#region` comments in it name the original source file of most parts (a few small modules, such as the ones in `src/background/agent/`, sit inside a neighbour's region).
It is about 4.3 MB because the LangChain provider packages, answer audit, and LangGraph runtime are in it, see "Worker Bundle and CSP" in section 3.
The build also writes sourcemaps next to the files (`sourcemap: 'hidden'`), but they are kept only for `npm run evalscan`, which uses them to name the original file and line of a hit.
The built files have no `sourceMappingURL` line and the zip has no maps, so DevTools does not load them and debugging works on the built code.

### SidePanel UI Logs
Right-click anywhere inside the SidePanel UI and select **Inspect** to open DevTools for `sidepanel.html`.

---

## 3. Running the Automated Test Suite

### Test Suite
Run the full suite with:
```bash
npm test
```
This runs `node --test` on `tests/**/*.test.js` and `tests/**/*.test.ts` (2942 tests as of this writing).
None of it needs a real browser.

### Syntax Check
```bash
npm run check
```
Runs `node --check` across the 7 plain JS source files listed in `package.json`, catching a syntax error before it ever reaches a browser reload.

### Type Check
```bash
npm run typecheck
```
Runs `tsc --noEmit` in two projects.
`tsconfig.json` covers `src/`, the code of the extension.
It runs in the MV3 service worker, so it has the WebWorker lib and the `chrome` types, and nothing from Node or from a page: `Buffer`, `process`, `NodeJS.Timeout` and `document` do not compile there.
`tests/tsconfig.json` extends it for the tests, the test helpers and the Node scripts, which run in Node, and adds the `node` types.
`tests/tsconfigScopes.test.ts` checks both rules with the real compiler.

TypeScript files use erasable syntax only (no `enum`, `namespace` or constructor parameter properties) and explicit `.ts` extensions in imports, because Node runs them directly by stripping types.
Nothing in `tsc` or Vite enforces the extensions (they accept `./name` and `./name.js` for `name.ts`, and Node does not), so `tests/importSpecifiers.test.ts` reads every relative import and fails when it names a file that is not there exactly as written.

### Action Registry
Every verb the agent can use is defined once in `shared/actions.json`: name, category, tiers, policy modes, prompt line, schema and aliases.
`src/background/agent/actions.ts` reads it, and `src/background/agent/schemas.ts` builds the JSON schemas that go to Ollama in `format` and validates replies with `@cfworker/json-schema`, which never uses `eval`.
The engine's `KNOWN_ACTIONS` and its alias table (`click_element` to `click`, `done` to `finish`) come from the same file.
To add a verb, add its entry to the file and an example to `tests/shared/actions.test.ts`; `tests/shared/actionsRegistry.test.ts` checks the file itself.
`shared/fixtures/action-schemas.json` holds the exact schema and prompt bytes that go to Ollama, and `tests/actionRegistrySnapshot.test.js` compares them.
Change that fixture only when the model request is meant to change.

### Reply Parser
`src/background/agent/parse.ts` turns a model reply into an action, or into the parse error that the model sees on its next turn.
`repairJson.ts` (the string-aware brace scanner and the repair ladder for cut-off JSON), `sanitize.ts` (aliases, the verb check, element ids) and `toolCalls.ts` (tool-call markup) are its parts, and the engine's `parseResponse` only calls it.
Tool-call markup is detected first and never becomes an answer: it is converted into the action it asks for, or it is the tool-call parse error.
That covers DeepSeek DSML, Anthropic `invoke`, Qwen and Granite `tool_call`, Llama `python_tag` and `<function=...>`, Mistral `[TOOL_CALLS]`, OpenAI `tool_calls` and `function_call`, and a bare `{"name", "arguments"}` object.
Words of markup inside the strings of a complete action (an answer that explains tool calls) are the action's content and do not count.
When a reply holds several JSON objects, the first one with an `action` key wins, and only when there is none the last alias shape (`{"click": 3}`) does, as in the old engine.
`shared/fixtures/parse-cases.json` holds the reply cases as data (also meant for the Python runner), and `tests/parse.test.ts` runs them next to the rules that data cannot say.

### LLM Providers
The engine still calls `ApiClients.generateCompletion` in `background/apiClients.js`, which is now a thin shim over `src/background/llm/`.
Every provider runs on a LangChain chat model, and a model is built for every call with `maxRetries: 0`, so `callWithRetry` stays the only retry layer.
OpenRouter, OpenAI, OpenAI-compatible servers (Groq, LM Studio, vLLM), Anthropic, Gemini, and NVIDIA NIM (`build.nvidia.com`) are in `factory.ts`.
NVIDIA NIM routes through `openaiFamilyCall` to `https://integrate.api.nvidia.com/v1/chat/completions` using Bearer `nvapi-...` tokens.
Ollama is `ollama.ts` (`ChatOllama`): the action or plan schema goes out as `format`, with `think:false`, `num_ctx` and `num_predict`.
It keeps the two fallbacks, a model that rejects `think` and a server older than 0.5 that rejects a schema, and each is remembered for the life of the worker.
`ChatOllama` always streams, and its own abort is broken, so its fetch is wrapped to carry the call's signal, and a model is built per call.
AgentRouter is `agentRouter.ts`: `ChatAnthropic` on `/v1/messages` first, and `ChatOpenAICompletions` on `/v1/chat/completions` when the first fails in a way that another endpoint might not.
A 401, an abort and a network error do not fall back, and the first error is logged.
A 200 that `ChatAnthropic` cannot read (an `{"error": ...}` object, `{}`, HTML) did get an answer, so it does fall back, unless it is a chat reply in the OpenAI shape, which is simply read.
The declarativeNetRequest rule 8888 in `background.js` still sets the `User-Agent` for agentrouter.org, because Chromium replaces it on every fetch.
`deadline.ts` gives every call a deadline (`llmTimeoutMs`) and joins it with the task's abort signal, so a timeout, Pause and Stop really cancel the request.
Pause and Stop abort with a reason tagged `{ scoutfox: 'user' }`, and that tag, never the text of an error, tells them from a timeout.
The SDK clients' own 10 minute `timeout` is set out of the way (`SDK_TIMEOUT_MS`), so `llmTimeoutMs` is the only timer, also above 10 minutes.
NVIDIA NIM defaults to a 300s timeout (`DEFAULT_NVIDIA_LLM_TIMEOUT_MS`) to handle cold-start and queue latency on hosted 70B+ models, while other providers default to 120s.
`errors.ts` keeps the old user-facing error texts, `models.ts` keeps the model lists and their cache, and API keys are taken out of every error text.
Every model's `fetch` is a `watchFetch` (`factory.ts`): it keeps the raw text of a response for the error texts and tells "nobody answered" from "the client could not read the answer".
The second is an `UnreadableReplyError` with the status of the answer, so a 200 that is no chat reply reads `API Error (200): not a chat reply: <what the server said>` and not an internal TypeError.
It also takes the key out of an error response before the SDK reads it, because LangChain hands that error to every callback (tracing) unchanged, and Gemini's error is scrubbed where the request is made.
The key is never in the options of a model either: AgentRouter's wire image, which carries it, is put on the request by that `fetch` and not in `defaultHeaders`, and `tests/llm/keys.test.ts` runs every provider against a server that echoes its headers.
The requests are built by LangChain and the SDKs, so provider tests capture them with a fetch spy (`tests/helpers/llmWire.ts`) instead of stubbing a response object.

### Worker Bundle and CSP
The worker bundles the LangChain provider packages, answer audit, and LangGraph runtime, so `background/sw.js` is 4,339 KB unminified (966 KB gzip).
The build prints the size of every file, raw and gzip, and CI runs the build, so a jump in the worker shows in the log.
Minify stays off.
Minified, the worker would be 1,432 KB (363 KB gzip) and would start about 13 ms faster, and that is not worth an unreadable `dist/` and a rewrite of the zod check below.
`vite.config.mjs` has the numbers and the reasons.

The extension CSP (`script-src 'self'`) forbids `eval` and `new Function`, and Chromium reports even a caught `new Function('')` as a CSP violation.
zod 4 makes exactly that call, once, to probe whether it may compile object parsers, unless `globalThis.__zod_globalConfig.jitless` is `true` when zod's core module runs.
`src/background/boot/zodJitless.ts` sets the flag, and it must be the first import of the worker entry (`background/background.js`) and of the side panel entry, because an ES module import runs before the next one.
`npm run build` checks the order in `dist/` ("zod is jitless before any library code"): the flag must be a top-level statement, and the only `//#region` blocks above it may be rolldown's own helpers.
The check reads comments, so it needs unminified output, and it refuses a bundle without them.
`tests/boot/zodJitless.test.ts` runs zod with and without the module and counts constructions of a `Function` (0 with it, at least 2 without).
The smoke test watches the worker's CSP violations too, which Chromium reports only to the CDP Audits domain and not as a console message, and `--tamper=zod-not-jitless` shows that it fails without the flag.

`npm run evalscan` reads the map of a built file from `<file>.map` only, and refuses a built file that ends in a `sourceMappingURL` comment, because the build writes hidden maps and a string of our own code must not be able to name a map.
It allows five hits, each keyed by the original file (through the sourcemap), the kind of hit and the source line:
- `background/agentEngine.js`: the `new Function` of `execute_js`, which runs in the web page, not in the worker.
- `node_modules/zod/v4/core/util.js`: the probe above.
  `allowsEval` returns before it when the flag is set.
- `node_modules/zod/v4/core/doc.js`: `Doc.compile`, which only zod's object fast path calls, and that path is off under jitless.
- `node_modules/openai/lib/EventStream.mjs`, two places: the SDK reads the source text of the native `Function` constructor and lists it among the native constructors whose descriptors it reads.
  It never calls it.

Every entry but the first names a file in `node_modules/`, so no entry can hide a hit in our own code, and `tests/evalscan.test.js` pins that.
A library entry needs a reason and the version that was read; versions are exact pins, so a changed line fails loudly.

The build also fails on every bundler warning that is not on a short list.
The list is 7 pairs of a Node built-in and the file that imports it, all in the credential code of `@anthropic-ai/sdk` (`node:fs` and `node:path`, which Vite replaces with an empty module).
That code runs only for a client that has neither an API key nor a token, and ours always have a key; `tests/llm/anthropicCredentials.test.ts` shows it with a spy on the file system.
Warnings are recorded and the build fails after the pass, because a throw from the bundler's `onLog` is swallowed for a warning of a plugin (the build used to exit 0 for a new `import fs from 'node:fs'`).
`tests/buildWarnings.test.js` covers the list.

Chrome only wakes a worker for the listeners that were registered in the first run of the script.
All eight `chrome.*` listeners of `background.js` are registered at the top level, and a probe that wrapped `addListener` in Chromium 152 saw all of them inside that first run.
The worker's start, from the creation of its global scope to the end of that run (median of six starts on a fresh profile), is about 52 ms with LangChain in it and was about 12 ms before.

Gemini always streams, and its SDK leaves an unhandled rejection behind when a reply is cut halfway (Pause, Stop or a dropped connection) or when a 200 is not an event stream.
The worker's `unhandledrejection` handler ignores exactly those errors (`src/background/boot/rejections.ts`) and logs every other one as an error.

### Answer audit (finish gate)
A small model can finish with a table for three sites after it opened only one, with prices, shipping and links it made up.
The engine used to accept any `finish` and mark every plan step completed.
Now every final answer is checked by code, against what the engine itself read.
The model only picks actions.

**The ledger** (`src/background/agent/evidence.ts`).
It holds what the ENGINE read: the URL the tab was really on, the title and the visible text of every snapshot, and the text results of `read_page_text`, `execute_js` and `read_network_requests`.
A `navigate` action that the model typed does not count.
Where the tab landed does.
The text the model wrote is never stored, and an `execute_js` result that is only a literal from the model's own code is left out.
The current value of an input is not page text (the snapshot shows it as `value="..."`, and the model may have typed it), and every string with a digit or a link in it that the model typed is cut out of the page texts read afterwards, so a price typed into a search box and echoed by the results page is not a price that site shows.
A site is "opened" when a page on its registrable domain was read (`www.` is ignored).
When a `navigate` action is followed by a page on another site (`twitter.com` leads to `x.com`), the site asked for counts as opened through that page.
A snapshot that still shows the page the tab was on before is not a redirect.
The ledger lasts for the whole session, so a follow-up turn can use a page an earlier turn read.
When its texts are too long, the oldest pages are cut down to the lines around their numbers and links first, and whole pages go only after that.
Which pages and sites were read is kept apart from the texts (a short line per page, never cut for room), so cutting never turns an opened site into an unopened one.
It is stored with the session in a cut-down form (`compactLedgerSnapshot`, at most 40 pages and about 60,000 characters, plus up to 100 short visit lines with the newest page of every site among them).
A session stored before this existed has no ledger, and one stored before the visit list existed rebuilds it from its pages.
New Session clears it.
The first time a URL is read, the log says `[EVIDENCE_RECORDED]`.

**The audit** (`src/background/agent/answerAudit.ts`).
It checks PROVENANCE, not truth: was this page opened, was this number on a page that was read.
A price can still be wrong on the page itself, and the audit cannot know that.
What it finds:
- lies: a link that was never opened, data for a site that was never opened, a number that is on no page that was read (or only on another site's page);
- gaps: a site named in the task or plan that was never opened, where the answer claims nothing for it;
- soft notes: a shipping or delivery statement with no supporting wording on that site's pages.

An honest "blocked", "not checked" or "nicht geprueft" line is not a lie in any wording (`UNCHECKED_RE`), and it is the only kind of line that counts as an acknowledgement: "they do not differ by more than 5%" says nothing about what was opened.
Sites that the goal sends the agent to are found by the words around them ("on", "from", a list in brackets), so "explain what socket.io is used for" does not make `socket.io` a source to open (`goalSources`).
A shop that an opened comparison page lists (`notebooksbilliger.de` on `idealo.de`) is a row of that page, not a second source.
A number is grounded by a price (a review count or a postal code is not one), or by a sum or difference of numbers that belong together: a price and the shipping beside it, the leading prices of the shops one sentence names, prices the answer states.
"About EUR 2,100" must be a rounding (half of the unit it is written with, never over 2%), and "6%" is as precise as it is written.
A duration may be less specific than the page ("3-5 days" for "3-5 Werktage"), never more.

Verdict: any lie gives `unverified`, else any gap gives `partial`, else `verified`.
Soft notes never change it.
The audit is on the `finish` history entry as `audit`, and the side panel shows the verdict, so a failed answer is never a plain green "Done".

**The gate** (`gateFinish` in `background/agentEngine.js`).
A `verified` answer is accepted as it is.
Any other answer goes to `engine.finishPolicy`, which is `decideOnFailedAudit` in `src/background/agent/finishPolicy.ts` and answers with one of:
- `send_back`: the finish is not recorded, the model is told what was wrong (`formatSendBack`), and the run goes on.
  It costs a step.
- `annotate`: the run ends with the model's answer, made-up links cut out and a "Verification notes" section added.
  A site the answer itself says it did not check gets no extra note.
- `replace`: the run ends with a report written by code only (`buildEvidenceReport`).

`annotate` puts one warning line, written by code, at the very top of the answer (`WARNING - UNVERIFIED ANSWER: ...` or `PARTIAL ANSWER: ...`), before the model's words.
Annotating again gives the same text, and an answer that is unchanged because it honestly says what was not checked gets no line.
The side panel shows the verdict as its own card, so it does not print that line and the notes section a second time.
If the run ends while a finish is sent back (the model ran out of steps), the answer it gave goes through the gate once more with no send-back left, and is shown with its verdict, followed by the reason the run stopped.

There is deliberately no outcome that accepts a failed answer.
The engine clamps the policy (`resolveGateDecision` in `planEvidence.ts`): a send-back becomes `annotate` when no step is left, after 4 send-backs in one turn, and for a plain-text reply that the engine wrapped into a finish.
It also becomes `annotate` for an answer that states nothing false and already says, for every site it did not open, that it was not checked, once the model was sent back one time.
That answer has done what the send-back asked, and sending it back again would only push a small model towards inventing the missing values.
A policy that throws or answers anything else gets `annotate`.
A test can replace `engine.finishPolicy` to force one branch.

**The plan.**
A plan step that names a site (for example `idealo.de: find the price`, or `Check Idealo` from a cloud planner, which is mapped to the goal's site by its brand name) is never shown as completed before a page of that site was read, and the marker `[>]` goes to the first step that is not completed.
When the run ends, steps for sites that were never opened become `skipped`, not `completed`.
Plans that name no site behave as before.

**The step message** has a short block after the plan: the pages read so far (the page that showed a price is named next to the page read last, when they differ), the named sites that are not opened yet, and one rule.
With a site still to open the rule says to open it, and to write "not checked" only for a site that blocked the agent or did not load.
With none it only asks for facts from pages that were read.
It is under 600 characters, and it is left out only when there is nothing to say.

**Log tags** (read them to see what happened):
- `[FINISH_AUDIT] verdict=... lies=N gaps=N softs=N`, with the notes as the detail, on every finish;
- `[FINISH_SENT_BACK]`, `[FINISH_ANNOTATED]`, `[FINISH_REPLACED]`, `[FINISH_POLICY_CLAMPED]` (WARN, with the reason) when the policy's answer could not be followed (no step left, too many send-backs, a policy that threw or answered nonsense, a plain-text reply), and `[FINISH_ACCEPTED_PARTIAL]` (INFO, not a problem) when an honest answer that already says which sites were not checked is accepted as it is, with verdict partial, after a send-back;
- `[TASK_FINISHED] Task completed successfully.` only for a `verified` answer, else `[TASK_FINISHED_PARTIAL]` or `[TASK_FINISHED_UNVERIFIED]`.

**Tests.**
```bash
node --test tests/agentEngineFinishGate.test.ts   # the incident replay and the three policy branches
node --test tests/agentEngineEvidence.test.ts     # ledger, storage, clamps, log tags, step message, plan
node --test tests/agent/evidence.test.ts tests/agent/answerAudit.test.ts tests/agent/planEvidence.test.ts
npm test
```
`shared/fixtures/answer-audit-cases.json` holds the cases of the audit as data.
If an existing engine test finishes with a number or a link, the page it runs on must show it, or the gate correctly refuses the answer.

### Effort Profiles and Reflection (Phases P5b, P5c)
Effort profiles are defined in `shared/effort.json` (`auto`, `low`, `medium`, `high`, `xhigh`, `max`).
They configure `searchDepth`, `maxSites`, `stepBudgetPerSite`, `tokenBudgetPerSite`, `reflectMode`, `workerPlanning`, `replanBudgetPerSite`, `replanMaxRounds`, and `screenshotMode`.
`src/background/agent/profile.ts` loads the matrix and provides heuristic level suggestion (`suggestEffortLevel`) when Auto mode is selected.
The side panel provides segmented effort controls for Auto, Low, Medium, High, XHigh, and Max, and Settings stores the user default in `effortDefault`.
An active effort badge in the processing banner displays the running task's level.

Reflection and replanning run between sites in `reflectNode` (`src/background/graph/orchestrator.ts`).
`src/background/agent/reflectPrompt.ts` generates structured reflection prompts and parses model decisions (`continue`, `stop_early`, `replan`).
When `stop_early` is chosen, the run finishes immediately when all required findings and criteria are satisfied.
When `replan` is chosen, `planNode` creates revised plans with monotonic site IDs and archives the previous plan in `planPrev`.
`allocNode` preserves budget accounting across replans by crediting unspent allocations from dropped sites, funding new candidate sites, and protecting the reserve pool.
Comprehensive tests cover profiles and reflection in `tests/agent/profile.test.ts`, `tests/agent/reflectPrompt.test.ts`, `tests/graph/orchestratorEffort.test.ts`, and `tests/graph/orchestratorReflect.test.ts`.

### Risk Gate Backend (Phase P5d)
The risk gate evaluates proposed actions before execution using deterministic keyword heuristics from `shared/risk.json`.
Heuristic evaluation avoids LLM latency and nondeterminism for safety-critical checks.
`evaluateActionRisk` in `src/background/agent/risk.ts` assigns actions to one of three levels:
- `forbidden`: passwords, payment card numbers, and one-time security codes are rejected immediately and routed to recovery without asking the user.
- `risky`: purchase or checkout actions (clicks on purchase words or on checkout pages or forms, typing or submitting in checkout contexts), login form submissions, sensitive or personal field entry (emails, addresses, phone numbers), form submissions with destructive or submit words, and unapproved external navigations pause execution in `holdNode` for human confirmation (`confirm_action`).
- `safe`: ordinary browsing and navigation on approved domains proceed directly to `executeNode`.

DOM compression in `content/domCompressor.js` and `content/content.js` annotates element metadata (`fieldKind`, `formKind`, `elementInfo`) to detect sensitive inputs and forms.
When an action is denied by the user or fails policy, `recoverNode` in `src/background/graph/worker.ts` records the failure in failure memory and permanently bans that action signature (`verb|target|value`) to prevent retry loops.
Tests in `tests/agent/risk.test.ts` and `tests/graph/workerRisk.test.ts` cover risk classification, checkout forms, and banned action recovery.

### SidePanel UI Overhaul and LangGraph Cards (Phase P6)
Phase P6 upgrades the side panel with specialized event-delegated cards and live execution visualization:
- **Plan Approval Card (`sidepanel/cards.js`)**: renders when the orchestrator enters `approve_plan` hold.
  It displays planned sites, target fields, effort level selection, and estimated steps and duration, with Approve and Cancel buttons.
- **Action Confirmation Card (`sidepanel/cards.js`)**: renders when a worker action triggers a risk hold.
  It shows a variant badge (`purchase`, `login`, `form`, `navigate`), action summary, target domain, an optional "Remember domain" checkbox for external navigation, and Confirm/Deny buttons.
- **Provenance Findings Table (`sidepanel/cards.js`)**: renders extracted findings with source domain, field name, value, verification status badge, and excerpted evidence snippet.
- **Security Challenge Help Card (`sidepanel/cards.js`)**: renders when a worker encounters a bot challenge or verification screen on high or max effort, offering "I've Solved It" and "Skip Site" buttons.
- **Continue Budget Card (`sidepanel/cards.js`)**: renders when a worker reaches its soft budget cap on max effort, offering to continue with reserve steps or finish the site.
- **Nested Live Graph View (`sidepanel/graphStrip.js`)**: renders two-tier breadcrumbs for orchestrator phases (Plan, Alloc, Sched, Site Worker, Summary, Reflect, Compile, Finalize) and worker nodes (Open, Perceive, Meter, Policy, Risk Gate, Execute, Verify, Recover, Record), throttled by `requestAnimationFrame`.
- **Studio Mono Theme (`sidepanel/sidepanel.css`)**: monospace typography and status indicators, using the `--surface` variable for hover and active states.
- **Model and Step Overrides**: Settings provides inputs for `plannerModel`, `reflectModel`, and `maxSteps` (up to 1,000 steps).
  Changes auto-save on change and blur.
  `AgentRunner.ts` applies `plannerModel` to planner calls, `reflectModel` to reflection calls, and `maxSteps` to run limits.
- **Message Dispatch**: `background/background.js` handles `APPROVE_PLAN`, `CONFIRM_ACTION`, `RESOLVE_CHALLENGE`, and `CONTINUE_BUDGET` messages from the side panel, forwarding resumes into `AgentRunner`.
- **Effort Levels & Profiles (Phases P5b, P7b)**: supports 6 effort levels (`Auto`, `Low`, `Medium`, `High`, `XHigh`, `Max`) defined in `shared/effort.json`.
  `XHigh` applies a 4x budget with key-field cross-checking.
  `Max` applies an 8x budget with mid-site worker reflection, alternate entry points, full cross-checking, interactive challenge assistance, and soft-cap budget holds.
Tests in `tests/sidepanel/cards.test.js` and `tests/runner/agentRunnerCards.test.ts` cover card HTML rendering, event handlers, and runner state synchronization.

### Test Approach
`chrome.*` APIs are hand-mocked per test file, not a real browser.
New tests should use the shared fakes described under "Test Helpers" instead of a new hand-made mock.
Several tests monkey-patch `ApiClients.generateCompletion` to drive a real task through the actual background message-passing code, instead of only unit-testing pieces in isolation.

### Test Helpers
The shared fakes in `tests/helpers/` are for new tests:
- `fakeChrome.ts` builds the `chrome.*` surface (tabs, tabGroups, windows, storage, runtime, sidePanel, scripting, debugger, alarms and more).
  You declare only what a test needs, and touching any other API throws, so a missing API cannot give a false green.
- `fakeStorageSession.ts` fakes `chrome.storage.session` and `chrome.storage.local`, with byte counting and quota errors.
  A service worker restart in a test is a new connection to the same store.
- `fakeLlm.ts` is a scripted model.
  A script is a list of replies (a string, or `{ text, reasoning, delayMs, error }`, or a function that answers by what the model was shown).
  `generateCompletion` returns them in order, `install(ApiClients)` puts it in place of the real client, and every call is recorded with its settings, messages, schema and how it ended (`text`, `error` or `aborted`).
  An abort rejects the way `fetch` does, and a script that runs out throws.
  `chatModel()` is a LangChain chat model over the same script and log.
- `llmWire.ts` is a fetch spy for the provider tests.
  `spyFetch(t)` replaces `globalThis.fetch` until the test ends and records every request as the SDK built it (URL, lower-case headers, parsed JSON body, signal).
  It answers with a real `Response` in the wire format of the endpoint (`textReply`, and `ollamaReply` for what Ollama streams), or with what the test returns (`jsonResponse`, an HTTP error, a fetch that never answers).
- `slowServer.ts` is a local HTTP server that answers late or never (or sends the first piece of a streamed reply and stalls), and remembers whether the client hung up first.
  That is the proof that a request was really cancelled and not only abandoned.
  `redirectFetch` sends the fixed hosts of Anthropic and Gemini to it.
- `fakeDom.ts` builds page snapshots and a fake content script from a small description of a site.
  `pageSnapshot(page)` is what `content/domCompressor.js` returns, and `fakeDom({ pages }).attach(fc, tabId)` answers `GET_DOM_SNAPSHOT` and `EXECUTE_ACTION` for the page the tab is on: clicks, typing, scrolling, links that open pages, and the other verbs of the content script except `browser_batch` and typing into a `<select>`, which throw so a test can script them.
- `checkpointFixtures.ts` and `holdGraphs.ts` are for the checkpoint saver tests: hand-made checkpoints and the two small graphs (flat and with a subgraph) that stop at an interrupt.

The older tests were not moved to these helpers.
The helpers have their own tests: `tests/fakeChrome.test.js`, `tests/fakeStorageSession.test.js`, `tests/fakeLlm.test.ts` and `tests/fakeDom.test.ts`.
`fakeDom` is pinned to the real content scripts there: the same page description must give exactly what the real `DOMCompressor` returns and the same reply as the real `doType`, `doScroll` and `doPressKey`.
`tests/agentEngineFakeHarness.test.ts` drives the whole old engine through `fakeChrome`, `fakeDom` and `fakeLlm`.
The helpers are TypeScript files, and Node runs them directly through type stripping, which is on by default from Node 22.18.
Tests need no build step.

### E2E Smoke
The E2E smoke test loads the built extension (`dist/`) into Chromium and runs tasks on a local fixture site through the real background code.
It uses an offline mock model, so it needs no Ollama.
It is not part of `npm test`.

One-time setup:
```bash
(cd tests/e2e && npm ci)
```
You also need a Chromium binary, because branded Chrome ignores `--load-extension`.
Set `CHROMIUM_PATH` if it is not at the macOS default (`/Applications/Chromium.app/Contents/MacOS/Chromium`).

Run:
```bash
npm run test:e2e
```
It builds first, runs the tasks, and ends with `SMOKE PASSED` or `SMOKE FAILED`.
It fails on a console error or an exception in the worker, on a CSP violation in the worker or in the side panel, and on an error on a fixture page.
See [tests/e2e/README.md](tests/e2e/README.md) for all options, what a run checks, and the negative controls.
In CI it runs from `.github/workflows/e2e.yml`, when a pull request gets the `e2e` label or when you start it by hand.

---

## 4. Chrome Web Store Publishing Checklist

Before packaging for the Chrome Web Store:
1. **Manifest V3 Verification**: Ensure `"manifest_version": 3` in `public/manifest.json`.
2. **Permissions Audit**: `public/manifest.json` currently requests `sidePanel`, `scripting`, `storage`, `tabs`, `tabGroups`, `alarms`, `declarativeNetRequest`, and `debugger`, plus `host_permissions: ["<all_urls>"]`.
   Confirm each is still used before submitting.
   Store reviewers question `<all_urls>`, `declarativeNetRequest`, and `debugger` most often, so have a justification ready for them.
   The `debugger` permission is required for real clicks via Chrome DevTools Protocol (CDP Input events).
3. **Icons Audit**: Ensure `icon16.png`, `icon48.png`, and `icon128.png` are present in `public/icons/`.
   The build copies them into `dist/icons/`.
4. **Eval Scan**: Run `npm run build && npm run evalscan`.
   The extension's Content Security Policy blocks `eval`, `new Function` and `Function()`, so the scan fails on any call to them in `dist/`.
   It has five allowed hits, listed in "Worker Bundle and CSP" in section 3.
   One is the `new Function` of the `execute_js` action in `background/agentEngine.js`.
   That code runs in the web page (the `MAIN` world, through `chrome.scripting.executeScript`), not in the extension, and the page's own policy can block it.
   The other four are in zod and the openai SDK, and never run in the worker.
5. **Create Zip Package**:
   ```bash
   npm run build && npm run zip
   ```
   This writes `scoutfox-chrome-extension.zip` in the repository root.
   It holds the contents of `dist/`, with `manifest.json` at the root of the zip, and no sourcemaps.
6. Upload `scoutfox-chrome-extension.zip` to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## 5. Build Foundation and What Comes Next

> Status: phases P0 through P7b (including P5 Long-Horizon Worker, P5b Effort Profiles, P5c Reflect and Replan engine, P5d Risk Gate backend, P6 UI Overhaul, P7 Default Graph Engine, and P7b XHigh/Max Profiles and Interactive Holds) are built, along with the answer audit gate and honest finish policy.
> See section 3 of [PRD.md](PRD.md) for architecture and roadmap details.

What is true today:
- `npm run build` bundles the extension with Vite into `dist/`, and you load `dist/` unpacked in `chrome://extensions`, not the repository folder.
- The manifest and the icons live in `public/`, and the build copies them into `dist/`.
- `public/manifest.json` requests the `debugger` permission for real CDP input events.
  During a task, Chrome shows a yellow "is debugging this browser" bar, which is expected.
- The shared core, provider integration, input dispatcher, and graph engine in `src/` are TypeScript (phases P1-P5d).
- The providers run on LangChain (phase P2) and the graph runtime bundles LangGraph (phases P4-P5), so the worker bundle is about 4.3 MB, see "Worker Bundle and CSP" in section 3.
- Final answers pass through the answer audit provenance gate and honest finish policy before completion.
- The background worker defaults to graph `AgentRunner` (phase P7) while preserving legacy `AgentEngine` behind `settings.engine` (`'graph'` vs `'legacy'`).
- The legacy engine (`background/`), the content scripts and the side panel are still plain JavaScript ES modules.
- CI zips the built `dist/`, not the raw source folders.

Planned, not built yet:
- The legacy engine, content scripts, and side panel move to TypeScript in later phases.
- Real-site benchmark evaluation and additional multi-turn recovery strategies on the LangGraph engine before deprecating the legacy loop.
