# ScoutFox end-to-end smoke harness

## What it is

`smoke.mjs` loads the built extension (`dist/`) into Chromium with puppeteer-core.
It serves the local fixture site from `tests/fixtures/site`.
It starts each task through the extension's own message path, the same `START_TASK` message the side panel sends.
It answers the holds of the engine like a user at the side panel would (see "The holds of the engine").
It checks every answer, what the engine did to get it, that the service worker, the side panel page and the fixture pages have no errors, and that the extension's content scripts really are on the fixture pages.
It is opt-in and not part of `npm test`.

The engine under test is the LangGraph engine.

It never loads `dist/` itself.
It copies `dist/` into a temp folder, leaves out the sourcemaps like the zip does, and adds one file, `driver.html` from this folder.
So the browser sees the files a user installs, and the test page never enters `dist/` or the shipped zip.
The temp folder and a fresh Chromium profile are removed at the end, also on a failure and on Ctrl+C.

## Setup

1. `npm ci` at the repo root (Vite, for the build).
2. `cd tests/e2e && npm ci` (puppeteer-core only).
3. Chromium at `/Applications/Chromium.app/Contents/MacOS/Chromium`, or any other build in `CHROMIUM_PATH`.

## Run

The offline run needs no model and no Ollama.
It is what CI runs.

```
npm run test:e2e                      # builds dist/ first, then the offline run
node tests/e2e/smoke.mjs --mock       # the offline run on the dist/ you already built
```

The run against a real local Ollama needs the model to be pulled already.

```
node tests/e2e/smoke.mjs                              # all tasks with qwen3.5:9b
node tests/e2e/smoke.mjs --task=store-price --model=gemma4:12b
```

The run prints every task with its decisions, steps, model calls and tokens, then a summary, and it ends with `SMOKE PASSED` or `SMOKE FAILED` with the list of problems.
The exit code is 0 for a pass and 1 for a fail.
If the sources are newer than `dist/`, it prints a warning to build again (or to use `--build`).

| Option | What it does |
| --- | --- |
| `--mock` | Uses the offline mock instead of Ollama, and runs the mock's own self-test first. |
| `--build` | Runs `npm run build` first, so `dist/` is fresh. |
| `--task=a,b` | Runs only these tasks: `store-price`, `span-price`, `cheapest-offer`, `bot-check`, `two-sources-lie`, `two-sources-honest-retry`. A pending task is skipped (see "Pending tasks"). |
| `--model=name` | The model name (default `qwen3.5:9b`, or `mock-agent` with `--mock`). The honest variant of the two-sources task always uses `mock-agent-honest` with `--mock`. |
| `--max-steps=n` | The engine's hard step cap for a task (default 30). The graph engine builds its step budget from it. |
| `--timeout=ms` | The time limit for one task (default 360000, or 60000 with `--mock`). |
| `--headful` | Shows the browser window. |
| `--out=file.json` | Saves the full report as JSON. A run that loops keeps only the first five and the last three model calls of each task, and their count. |
| `--panel-screenshots=dir` | Saves the side panel in light and dark for every task, for a pixel review (the file kinds are listed below). |
| `--dump-snapshots` | Writes what the content script sees on each fixture page to `tests/fixtures/snapshots/`, and needs no model. The page of a task that runs under another host name (`shop-a.html`) goes to `tests/e2e/lib/snapshots/`. `--dump-snapshots=shop-a` writes only the pages you name. |
| `--tamper=name` | Breaks the temp copy on purpose (see "Negative controls"). |

| Environment variable | Default |
| --- | --- |
| `CHROMIUM_PATH` | `/Applications/Chromium.app/Contents/MacOS/Chromium` |
| `CHROMIUM_ARGS` | none (extra Chromium flags separated by spaces, for example `--no-sandbox` on a Linux CI runner) |
| `OLLAMA_URL` | `http://127.0.0.1:11434` |
| `FIXTURE_PORT` | `8765` (the committed snapshots contain this port, so keep it when you dump snapshots) |
| `PROXY_PORT` | `11435` (the port of the mock and of the Origin proxy) |

## What makes a graph run the same every time

- The settings the harness saves: the model and its server, `maxSteps` (the hard cap, 30) and `effortDefault` (`medium`).
- `START_TASK` carries `effort: "medium"` too, because the engine reads the words of a task when the level is `auto` (the word "cheapest" would make it High).
- `START_TASK` never carries `autoApprove`, so the engine approves the plan itself, exactly like the side panel; the plan hold is no longer expected.
- The engine has no model tier setting yet.
  The mock's `/api/show` answer (a 9B model) is what will decide the tier when the engine reads it (plan stage 2d).

## The holds of the engine

The graph engine stops at a hold and waits for a person.
The harness polls the panel state (`GET_AGENT_STATE`) and answers every hold once, like a user would.
It never waits for the answer to its message: the engine answers `APPROVE_PLAN` and `CONFIRM_ACTION` only when the run has gone on to its next stop, which can be the end of the run.

| Hold (state field) | What the harness does |
| --- | --- |
| The plan card (`pendingApproval`) | Not expected: plans are auto-approved. If one appears (a run started with `autoApprove:false`), the harness sends `APPROVE_PLAN` at the level the plan proposes. |
| A confirmation (`pendingConfirm`) | Sends `CONFIRM_ACTION` approve when it is a navigation (`variant: navigate`) to a host of the task's fixture site (the fixture server's host, or the host name the task is served under). Every other confirmation is denied (`reject`). |
| A question (`pendingQuestion`) | Answers it only when the task defines an answer for it (`answers: [{ match, answer }]` in `lib/tasks.mjs`). Otherwise it stops the run and fails it. The harness never makes an answer up. |
| A bot check that asks for help (`pendingChallengeHelp`) | Skips the site. The harness never solves a bot check. |
| A budget question (`pendingContinueBudget`) | Finishes the site, never spends more. |

A run that is paused and shows no hold the harness can answer is stopped after three seconds and fails.
That check polls, and a mock run lasts about two seconds, so it cannot see a pause that is wrong for only part of a run.
So the harness also reads every `STATE_UPDATE` that reaches its side panel port (the states the real panel renders from) and fails the run when one says `paused` with no hold to answer and a `pauseReason` other than `user`.
That is the state in which the panel shows a Resume button with no reason, which users reported as "it stops after every task".
A pause because the model request failed (`llm_failure`) is flagged too: in a mock run nothing may fail.
The report prints how many state updates were seen, by status (`states:` line).
Every decision is printed in the report of the task (`decisions of the harness`) and saved in the JSON report.

## What a run checks

A run fails when any of these is true.

- A task does not end with the final entry it must (`finish`, or `partial_result` for the bot check), or its answer is wrong (each task has a check in `lib/tasks.mjs`).
- The bot-check task clicks or types into element 1, or the engine sends a click to the page at all.
- The harness had to stop a run: the task timed out, the model got the same prompt 15 times in a row (the loop guard, below), or the run stood paused with no hold to answer.
- The runner broadcast a `paused` state with no hold to answer and no user pause (see above), or no `STATE_UPDATE` reached the harness at all (the check could not look at anything).
- The plan rows of the final state do not fit the task (`expectPlanRows` in `lib/tasks.mjs`).
  A row says `completed` for a site that ended `done`, and `completed` or `skipped` for any other site status (a plan row has no word for `blocked`).
  `done` is accepted for `completed` too, because the mock self-test builds its rows from the site statuses.
- The service worker or the driver page logs a console error or throws.
  This includes an error at the very start of the worker.
- The service worker has a CSP violation (the extension CSP forbids `eval` and `new Function`).
  Chromium reports it in a worker only as a `ContentSecurityPolicyIssue` of the CDP Audits domain, never as a console message, so the harness enables Audits (and it replays the issues from before it attached).
  zod's `new Function('')` probe, which `zodJitless` prevents, is the case this exists for.
- A fixture page a task runs on (the start page and the page the task ended on) shows a console error or a page error.
  The listeners are attached before the page loads, so an error at `document_start` counts too.
  The only line ignored is the browser's own 404 for `/favicon.ico`, which the fixture site does not have.
- On such a page, the MAIN-world net recorder did not run (`window.__scoutfox_net_recorder_active` is not `true`), or the isolated-world content script does not answer a `GET_DOM_SNAPSHOT` message.
- The side panel, opened as a page, shows a console error, a page error or a CSP violation.
  Its script must also have run (the model badge shows the configured model), and its request for the model list must have worked.
- The "LLM Timeout (ms)" field of that page, after 1000 is typed into it, does not show the stored value 5000 (a value below the minimum is saved as 5000, and the field must not keep the typed number).
- With `--mock` only: the engine did not take the mock's plan (its plan rows are not the sites of the mock's plan reply, so the generic fallback plan was used), the finish is unconfirmed, a task has an error entry in its history, the mock refused a call (HTTP 400, 500 or 501), or a reply of the mock starts with `MOCK-FAIL:`.
- With `--mock` only: what the engine did is not what the task expects (`expectMock` in `lib/tasks.mjs`).
  These are the facts of the graph run: how each site ended (the `site_end` entries), the plan rows of the final state, the findings and their quality, and the number of model calls per node (plan, policy, reflect).

## The facts of a run

`runFacts` in `lib/tasks.mjs` builds the facts from what the engine leaves behind, and the checks of a task read only these.
The mock's self-test builds the same facts, so the mock is judged by the same checks.

- The final entry of the last turn: `finish` (every site ended done) or `partial_result`, with its answer, table and findings.
- One row per `site_end` entry: the status the site ended with (`done`, `blocked`, `not_found`, `partial`, ...) and why.
- The plan rows of the final state, each with the status of its site.
- The model's steps (`agent_response` entries).
  An entry with no action is a reply the engine rejected.
- The model calls of the task per node (`plan`, `policy` with its mode, `reflect`), from the record the mock (or the proxy) keeps of every call.
- What the engine sent to the page, counted inside the service worker by the harness: every `chrome.tabs.sendMessage` by its action name, and every `chrome.debugger.sendCommand` by its method.
  This is how the harness sees that a click was (or never was) sent to the page, which the history cannot show.
  The counters only count and pass everything on, and they are put into the temp copy's worker at run time, never into a file.
- The history rows are read without their exact copies.
  The engine writes the rows of a site twice when a run went through a hold (a known bug that plan stage 3b fixes).
  The number of copies is printed and never a failure.

## The loop guard

The mock counts identical requests in a row and writes the count into the record of the call.
A run in which the model gets the same prompt 15 times in a row changes nothing and will not end by itself, so the harness stops it, and the run fails with the call number and the node.
The reply of the mock never depends on the count.

## Pending tasks

A task with a `pending` reason in `lib/tasks.mjs` is skipped, prints its reason, and is never a failure.
Its data and its check stay, and the stage that brings it back removes the reason.

No task is pending right now. `two-sources-lie` and `two-sources-honest-retry` RUN in every
`npm run test:e2e`: the finish gate exists and is wired (worker.ts finish gate, answerAudit.ts,
finishPolicy.ts), and these tasks exercise it in a real browser.

- The goal names two shops, `shop-a.test` and `shop-b.test`.
  Only shop A has a page (`tests/fixtures/site/shop-a.html`).
  The harness maps the host name `shop-a.test` to the fixture server with Chromium's `--host-resolver-rules`.
  So the tab really stands on `http://shop-a.test:<port>/...`.
  `shop-b.test` is mapped to "not found", so a run that tries to open it gets a clean error page and never asks a real DNS server.
- The plan has one site per shop, so the run reads shop A, goes on to shop B, finds no page there, and ends as a `partial_result` (the expected outcome of both tasks).
  The engine's `INJECT_FAILED` error line for the error page of shop B is the one service worker error the harness accepts, and only for that host; the error page itself is not probed for content scripts.
- The mock plays the small model of the incident (`lib/twoSources.mjs` has the invented row).
  It knows the persona by the model name in the request: `mock-agent` is the stubborn model, `mock-agent-honest` is the one that gives in after a refusal.
- `check` judges the answer the user reads (`judgeTwoSourcesAnswer`): a link to shop B must not be in it at all, a price, shipping or delivery for shop B only under an "unverified" first line, and the real price of shop A must be there.
- The mock's self-test checks the two-sources tasks at the reply level (their plan, the real row of shop A, the stubborn and the honest model at a page that is not the site's page and at a finish) and walks them through the worker.
  It also checks that `judgeTwoSourcesAnswer` rejects hand-written bad answers (the incident's table with a copied price, a made-up link, a number left unmarked) and accepts the honest and the marked ones.
  A check that can no longer fail is noticed there.

## What it proves

- `dist/` loads in Chromium: the manifest paths exist, the worker starts as one ES module, the content scripts run as classic scripts, and the side panel page loads with its bundled assets.
- Page content really reaches the model prompt, through the content script.
  The mock answers only from the page text and the element list it finds in the prompt.
- Text that sits in plain `<span>`s and `<div>`s reaches the page text, and hidden copies do not (`span-price` on `store-spans.html`, the shape of the live frame.work configurator).
- A run goes through the whole graph in the real browser: plan, the approval of the plan, the site worker, the findings, the final answer.
- A click that navigates works, and the content script answers on the second page.
  (Today this part is red, see "Known state".)
- On every fixture page the tasks use, both content-script worlds are alive: the MAIN-world net recorder ran (its flag is set) and the isolated-world content script answers.
  Neither script threw an error that the page could see.
- The service worker runs a whole task without errors.
- The side panel page loads clean and gets its data from the background.

## Known state

Until the graph engine hands the ids of the page's elements to its parser (plan stage 1b), every `click` and `type` with an element id is rejected before it reaches the page.
So `cheapest-offer`, which has to click, is red on purpose: the model asks for the same click again and again and the harness stops it with the loop guard.
`store-price` and `bot-check` need no click and pass.

## What it does not prove

- It does not judge a real model.
  The mock is a script.
  Use the real run, and the evals in `tests/evals`, for that.
- It does not open Chrome's real side panel.
  Puppeteer cannot do that (it needs a user gesture), so the panel is opened as a normal page.
- It does not test branded Chrome, other browsers, or a Linux or Windows machine.
  It was run on macOS with Chromium 152.
- It does not test the zip itself.
  It tests a copy of `dist/` that holds exactly the files of the zip, plus `driver.html`.
- It does not test what the net recorder records or what it does to a page's own `fetch` and `XMLHttpRequest`.
  It only proves that the script loaded, set its flag and threw nothing.
  An error inside the isolated-world content script that the page cannot see is caught only when it stops the script from answering.
- It does not test service worker restarts, trusted input, hidden tabs or pages outside a secure context.

## The mock

`lib/mockOllama.mjs` is a tiny scripted agent behind the same HTTP calls the extension sends to Ollama: `POST /api/chat`, `POST /api/show`, `GET /api/tags`, `GET /api/version` and `OPTIONS`.
Its replies are worked out only from the request, and it speaks the protocol of the LangGraph engine.
Three calls exist, each recognised by what the request carries:

- The plan call has a schema with `task_kind` and `sites`.
  Its user message is `Task: ...` and `Current tab: <title> (<url>)`.
  The reply is a research plan with one site for the page the tab is on, or one site per shop the goal names.
- The policy call is the worker's step.
  It has one schema per mode: `browse` has the click verb, `answer` has `finish`, `extract` has `continue_browsing`, and `harvest` is the `record_finding` schema without either.
  Its user message is the worker's prompt: the task, the current site and its goal, the needed columns, the current page (title, URL, text between `"""` marks) and the numbered element list.
  The call is stateless, so the mock answers from the page the message shows.
- The reflect call has no schema and is told apart by its system prompt.
  The mock always says "continue".

What the policy reply is:

- For a bot check it never clicks the box and answers `mark_blocked`.
- For the cheapest offer it clicks the link that best matches the product in the goal, and on the offers page it records the shop, the price, the shipping and the total it adds itself.
- For price, shipping and delivery it records those lines, copied from the page text.
- In answer mode (the schema has `finish`) it finishes with the same facts as text.
- When what it needs is not in the prompt, it answers with `MOCK-FAIL:` and says what is missing: as the answer of a finish in answer mode, else as the reason of `mark_not_found`.
  The run then ends without the data, so the smoke run fails.

Every reply is checked against the schema of the request before it is sent.
A reply that does not fit is an HTTP 500, a request that is not valid JSON gets HTTP 400, and a chat call the mock has no script for gets HTTP 501.
The 501 message names the call: its schema or its verbs, the number of messages and the start of its system prompt.
So a change in the engine's protocol fails loudly and says what was sent.

`POST /api/show` answers like Ollama: `details.parameter_size` (a 9B model), `capabilities`, `model_info`.
A model the mock does not list is a 404.
The engine will read this answer to decide the tier of the model (plan stage 2d).

The extension talks to Ollama through ChatOllama, which always streams.
So the mock answers a request with `stream: true`, or with no `stream`, as Ollama does: NDJSON, one JSON object per line, the reply text in two pieces and a last line with `done: true`, `done_reason` and the counts.
A request with `stream: false` still gets one JSON object.

The mock knows the fixture site and the prompts of `src/background/agent/prompts.ts`.
When either changes, its self-test shows what broke.

```
node tests/e2e/lib/mockOllama.selftest.mjs
```

The self-test builds the engine's messages with the engine's own prompt builders from the committed snapshots (`tests/fixtures/snapshots/`, `lib/snapshots/`).
It walks every task through the parts of the worker that decide what the mock sees, and judges the facts of the walk with the same checks as the smoke run.

## Negative controls

`--tamper=name` changes only the temp copy, never `dist/` and never a source file.
Use it to check that the smoke run can fail.

| Tamper | What it does | The run must |
| --- | --- | --- |
| `no-content-script` | Deletes `content/content.js`, which the manifest lists. | Exit 1: Chromium refuses to load the extension, and the error names the missing file. |
| `worker-error` | Adds a `console.error` at the top of `background/sw.js`. | Exit 1 on the worker error, although all tasks pass. |
| `broken-panel` | Makes the side panel script throw when it loads. | Exit 1 on the side panel gate. |
| `empty-page-text` | Makes the content script return no page text. | Exit 1: `store-price` ends with no finding, because the mock answers `MOCK-FAIL` (it cannot read a price from an empty page). |
| `zod-not-jitless` | Removes the `globalThis.__zod_globalConfig = { jitless: true }` statement from `background/sw.js`, so zod probes `new Function('')`. | Exit 1 on two `service worker CSP violation` lines (`kEvalViolation`), although all tasks pass. |
| `broken-net-recorder` | Makes `content/net-recorder.js` (the MAIN-world content script) throw when it loads. | Exit 1 on every fixture page: the recorder flag is not set, and the page reports a page error. |
| `stale-paused-status` | Puts the old status bug back in `background/sw.js`: an auto-approved plan hold leaves the runner status `paused` for the whole run. | Exit 1 on every task: `the runner reported "paused" with no hold to answer and no user pause`, with at least one `paused` state in the `states:` line, although every answer is right (the drive-start safeguard in `AgentRunner.executeDriveStep` sets `running` again at once, so the tampered run shows one stale `paused` where the original bug showed about 30). |

There is no tamper that switches the answer audit gate off: the gate is plain code in
`answerAudit.ts`/`finishPolicy.ts` with no flag to flip, and the two-sources tasks run in every
smoke pass, so a "switched off" gate is a code edit under test, not a switch.
The check of the two-sources tasks is additionally proven in the mock self-test, with answers written by hand.

## Panel screenshots

`--panel-screenshots=dir` writes these files for every task and both colour schemes (`light`, `dark`), plus one `-live-light` set taken while the run was still going, when the poll caught it.

| File | What it shows |
| --- | --- |
| `<task>-<model>-<scheme>.png` | The panel at 400 x 900 px. It scrolls to the newest card, so a long card is seen from its bottom. |
| `...-tall.png` | 400 x 1800 px: a long card from its top. |
| `...-tall-open.png` | The same with the action group open: the plan rows and the refused finishes. |
| `...-zoom-plan.png`, `...-zoom-card.png` | Close-ups at twice the pixel density of the action group and of the finish card. |
| `...-zoom-card-details.png` | The finish card with its audit details open, when they were closed. |

## Real mode and the Origin note

Ollama answers 403 to any request from a `chrome-extension://` origin, unless `OLLAMA_ORIGINS` was set when the server started.
The harness must not restart your Ollama, so in real mode the extension talks to a small proxy on port 11435.
The proxy drops the Origin header and forwards the request to Ollama.
The answer is NDJSON, because the extension streams.
The proxy reads all of it before it passes it on, and joins the pieces only for its own record of the call.
If Ollama is not reachable, the run stops with a hint to use `--mock`.

## Chromium

Branded Chrome ignores `--load-extension`.
Use Chromium or Chrome for Testing, and point `CHROMIUM_PATH` at it.
The run starts it headless with `pipe: true` and `enableExtensions: true`, and it never leaves a browser or a server running.

## Files

- `smoke.mjs`: the harness.
- `driver.html`: the empty extension page that sends the messages (`START_TASK`, `GET_AGENT_STATE`, `APPROVE_PLAN`, `CONFIRM_ACTION` and the other answers to a hold), added to the copy of `dist/`.
- `lib/tasks.mjs`: the tasks, their checks, and `runFacts`, which builds the facts of a run.
- `lib/twoSources.mjs`: what the two-sources tasks share: the shop names, the invented row, the Chromium host rules and the judge of the final answer.
- `lib/snapshots/`: what the content script sees on the pages that a task serves under another host name, for the mock's self-test.
- `lib/mockOllama.mjs` and `lib/mockOllama.selftest.mjs`: the offline mock and its self-test.
- `lib/ollamaProxy.mjs`: the Origin proxy for the real Ollama.
- `lib/callRecord.mjs`: the record of a model call (with its node and mode), shared by the proxy and the mock.
- `lib/extensionCopy.mjs`: the copy of `dist/` and the tampers.
- `lib/fixtureServer.mjs`: the static server for the fixture site.
