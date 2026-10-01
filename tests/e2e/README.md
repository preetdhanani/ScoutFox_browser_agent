# ScoutFox end-to-end smoke harness

## What it is

`smoke.mjs` loads the built extension (`dist/`) into Chromium with puppeteer-core.
It serves the local fixture site from `tests/fixtures/site`.
It starts each task through the extension's own message path, the same `START_TASK` message the side panel sends.
It checks every answer, that the service worker, the side panel page and the fixture pages have no errors, and that the extension's content scripts really are on the fixture pages.
It is opt-in and not part of `npm test`.

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

The run prints every task with its steps, model calls and tokens, then a summary, and it ends with `SMOKE PASSED` or `SMOKE FAILED` with the list of problems.
The exit code is 0 for a pass and 1 for a fail.
If the sources are newer than `dist/`, it prints a warning to build again (or to use `--build`).

| Option | What it does |
| --- | --- |
| `--mock` | Uses the offline mock instead of Ollama, and runs the mock's own self-test first. |
| `--build` | Runs `npm run build` first, so `dist/` is fresh. |
| `--task=a,b` | Runs only these tasks: `store-price`, `cheapest-offer`, `bot-check`, `two-sources-lie`, `two-sources-honest-retry`. |
| `--model=name` | The model name (default `qwen3.5:9b`, or `mock-agent` with `--mock`). The honest variant of the two-sources task always uses `mock-agent-honest` with `--mock`. |
| `--max-steps=n` | The engine's step cap for a task (default 10). |
| `--timeout=ms` | The time limit for one task (default 360000, or 60000 with `--mock`). |
| `--headful` | Shows the browser window. |
| `--out=file.json` | Saves the full report as JSON. |
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

## What a run checks

A run fails when any of these is true.

- A task does not finish, or its answer is wrong (each task has a check in `lib/tasks.mjs`).
- The bot-check task clicks or types into element 1.
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
- With `--mock` only: the generic fallback plan is used, the finish is unconfirmed, a task logs an error entry, or the number of model calls is not one plan call plus one call per step.
- With `--mock` only: what the finish gate did is not what the task expects (`expectMock` in `lib/tasks.mjs`).
  This is the verdict of the audit on the finish entry, which sites it lists as opened and not opened, and the status of the plan rows.

## The finish gate: the two-sources tasks

The engine checks every final answer against the pages it really read (the finish gate).
`two-sources-lie` and `two-sources-honest-retry` are the incident that started it, in a real browser.

- The goal names two shops, `shop-a.test` and `shop-b.test`.
  Only shop A has a page (`tests/fixtures/site/shop-a.html`).
  The harness maps the host name `shop-a.test` to the fixture server with Chromium's `--host-resolver-rules`.
  So the tab really stands on `http://shop-a.test:<port>/...`, and the engine counts the site as opened.
  The engine counts a site as opened only when the tab's own URL is on it, and `127.0.0.1` would not do.
  `shop-b.test` is mapped to "not found", so a run that tries to open it gets a clean error page and never asks a real DNS server.
- The mock plays the small model of the incident.
  It reads shop A (one `read_page_text`) and finishes at once with a full row for both shops.
  The price, shipping, delivery and link of shop B are invented (`lib/twoSources.mjs`).
- `two-sources-lie`: when the gate refuses that finish, the mock writes the same answer again.
  The gate has to give up on it: the made-up link is cut out and the answer is marked unverified.
- `two-sources-honest-retry`: the model name is `mock-agent-honest`, and this mock gives in after a refusal.
  It writes "not checked" for shop B and keeps the real row of shop A.
  The run ends as a partial answer.
  The mock stays stateless, so its behaviour after a refusal is chosen by the model name in the request.
- `check` judges the answer the user reads (`judgeTwoSourcesAnswer`): a link to shop B must not be in it at all, a price, shipping or delivery for shop B only under an "unverified" first line, and the real price of shop A must be there.
  `expectMock` judges what the gate did: verdict `unverified` (or `partial` when the gate sent the finish back once and the model then said "not checked"), shop A opened, shop B not opened, and the plan row of shop B skipped and not completed.
  Both hold whatever `finishPolicy.ts` decides: the tasks accept a policy that sends back twice, four times, or never.
- The self-test runs both tasks through the engine's own gate (`AgentEngine.gateFinish` with the real audit and policy).
  It also runs them under three forced policies, and it checks that `judgeTwoSourcesAnswer` rejects hand-written bad answers (the incident's table with a copied price, a made-up link, a number left unmarked) and accepts the honest and the marked ones.
  A check that can no longer fail is noticed there.

## What it proves

- `dist/` loads in Chromium: the manifest paths exist, the worker starts as one ES module, the content scripts run as classic scripts, and the side panel page loads with its bundled assets.
- Page content really reaches the model prompt, through the content script.
  The mock answers only from the page text and the element list it finds in the prompt.
- A click that navigates works, and the content script answers on the second page.
- On every fixture page the tasks use, both content-script worlds are alive: the MAIN-world net recorder ran (its flag is set) and the isolated-world content script answers.
  Neither script threw an error that the page could see.
- The service worker runs a whole task without errors.
- The side panel page loads clean and gets its data from the background.

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

`lib/mockOllama.mjs` is a tiny scripted agent behind the same HTTP calls the extension sends to Ollama: `POST /api/chat`, `GET /api/tags`, `GET /api/version` and `OPTIONS`.
Its replies are worked out only from the request.
The plan call is recognised by its schema, and an action call by its `oneOf` schema.
It reads the page text and the element list from the engine's step message and answers from them.
For a bot check it waits once and then finishes honestly, and it never clicks the box.
For the cheapest offer it adds price and shipping itself, and clicks the link that best matches the product in the goal.
For price, shipping and delivery it copies those lines from the page text.
When what it needs is not in the prompt, it finishes with an answer that starts with `MOCK-FAIL:` and says what is missing, so the smoke run fails.
Every reply is checked against the schema of the request before it is sent, and a request that is not valid JSON gets HTTP 400.
The extension talks to Ollama through ChatOllama, which always streams.
So the mock answers a request with `stream: true`, or with no `stream`, as Ollama does: NDJSON, one JSON object per line, the reply text in two pieces and a last line with `done: true`, `done_reason` and the counts.
A request with `stream: false` still gets one JSON object.

The mock knows the fixture site and the engine's step message.
When either changes, its self-test shows what broke.

```
node tests/e2e/lib/mockOllama.selftest.mjs
```

## Negative controls

`--tamper=name` changes only the temp copy, never `dist/` and never a source file.
Use it to check that the smoke run can fail.

| Tamper | What it does | The run must |
| --- | --- | --- |
| `no-content-script` | Deletes `content/content.js`, which the manifest lists. | Exit 1: Chromium refuses to load the extension, and the error names the missing file. |
| `worker-error` | Adds a `console.error` at the top of `background/sw.js`. | Exit 1 on the worker error, although all tasks pass. |
| `broken-panel` | Makes the side panel script throw when it loads. | Exit 1 on the side panel gate. |
| `empty-page-text` | Makes the content script return no page text. | Exit 1: `store-price` and `cheapest-offer` answer `MOCK-FAIL`. |
| `zod-not-jitless` | Removes the `globalThis.__zod_globalConfig = { jitless: true }` statement from `background/sw.js`, so zod probes `new Function('')`. | Exit 1 on two `service worker CSP violation` lines (`kEvalViolation`), although all tasks pass. |
| `broken-net-recorder` | Makes `content/net-recorder.js` (the MAIN-world content script) throw when it loads. | Exit 1 on every fixture page: the recorder flag is not set, and the page reports a page error. |

`--tamper=empty-page-text` also fails the two-sources tasks: the mock cannot read the price of shop A, and its answer is `MOCK-FAIL`.
There is no tamper that switches the finish gate off.
That would be an edit of the code under test, even in the temp copy.
The check of the two-sources tasks is proven in the mock self-test instead, with answers written by hand.

## Panel screenshots

`--panel-screenshots=dir` writes these files for every task and both colour schemes (`light`, `dark`), plus one `-live-light` set taken while the run was still going, when the poll caught it.

| File | What it shows |
| --- | --- |
| `<task>-<model>-<scheme>.png` | The panel at 400 x 900 px. It scrolls to the newest card, so a long card is seen from its bottom. |
| `...-tall.png` | 400 x 1800 px: a long card from its top. |
| `...-tall-open.png` | The same with the action group open: the plan rows (a skipped step says "not checked") and the refused finishes. |
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
- `driver.html`: the empty extension page that sends the messages, added to the copy of `dist/`.
- `lib/tasks.mjs`: the tasks and their checks.
- `lib/twoSources.mjs`: what the two-sources tasks share: the shop names, the invented row, the Chromium host rules and the judge of the final answer.
- `lib/snapshots/`: what the content script sees on the pages that a task serves under another host name, for the mock's self-test.
- `lib/mockOllama.mjs` and `lib/mockOllama.selftest.mjs`: the offline mock and its self-test.
- `lib/ollamaProxy.mjs`: the Origin proxy for the real Ollama.
- `lib/callRecord.mjs`: the record of a model call, shared by the proxy and the mock.
- `lib/extensionCopy.mjs`: the copy of `dist/` and the tampers.
- `lib/fixtureServer.mjs`: the static server for the fixture site.
