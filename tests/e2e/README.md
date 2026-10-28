# ScoutFox end-to-end verification harness

## What it is

The verification of this project has two layers, and a change is only accepted when BOTH pass.

- Layer 1: the mock's self-test (`lib/mockOllama.selftest.mjs`). Node only, no browser, under a second. It runs first inside every `--mock` smoke run, so a broken mock is reported before Chromium starts.
- Layer 2: the smoke run (`smoke.mjs`). It loads the built extension (`dist/`) into Chromium with puppeteer-core and drives whole tasks through it.

The engine under test is the MCP tool loop (`src/background/mcp/`): the LLM calls tools, the MCP server executes them in the browser, results are fed back until `finish`.

The harness never loads `dist/` itself. It copies `dist/` into a temp folder, leaves out the sourcemaps like the zip does, and adds one file, `driver.html` from this folder. The browser sees the files a user installs, and the test page never enters `dist/` or the shipped zip. Nothing of the harness (mock, driver, fixtures, screenshots) ships with the extension.

The temp folder and a fresh Chromium profile are removed at the end, also on a failure and on Ctrl+C.

## Setup

1. `npm ci` at the repo root (Vite, for the build).
2. `cd tests/e2e && npm ci` (puppeteer-core only).
3. Chromium at `/Applications/Chromium.app/Contents/MacOS/Chromium`, or any other build in `CHROMIUM_PATH`.

## Run

The offline run needs no model and no Ollama. It is what CI runs.

```
npm run test:e2e                      # builds dist/ first, then runs on LISA (needs LISA_API_KEY or LISA_API in .env)
npm run test:e2e -- --held-out        # the held-out open-web tasks on LISA
npm run test:e2e -- --provider=nvidia # the same open-web tasks on NVIDIA NIM (needs NVIDIA_API_KEY)
npm run test:e2e:mock                 # builds dist/ first, then the offline run on the scripted mock
node tests/e2e/smoke.mjs --mock       # the offline run on the dist/ you already built
```

The run against a real local Ollama needs the model to be pulled already.

```
node tests/e2e/smoke.mjs --provider=ollama            # the open-web tasks with qwen3.8:27b-mlx
node tests/e2e/smoke.mjs --provider=ollama --task=web-eiffel-tower --model=gemma4:12b
```

The run prints every task with its steps, model calls and tokens, then a summary, and it ends with `SMOKE PASSED` or `SMOKE FAILED` with the list of problems. The exit code is 0 for a pass and 1 for a fail. If the sources are newer than `dist/`, it prints a warning to build again (or to use `--build`).

| Option | What it does |
| --- | --- |
| `--mock` | Uses the offline mock instead of Ollama, and runs the mock's self-test first. |
| `--build` | Runs `npm run build` first, so `dist/` is fresh. |
| `--task=a,b` | Runs only these tasks, for example `web-eiffel-tower,web-npm-react`, or `store-price` with `--mock`. |
| `--provider=name` | The real model server: `lisa` (default), `nvidia` or `ollama`. The OpenAI-compatible profiles live in `lib/providers.mjs`. |
| `--held-out` | Runs the held-out open-web tasks instead of the regular ones (see "The tasks"). |
| `--sealed` | Runs the sealed open-web tasks and shows only their verdicts and numbers, never their steps, answers or model calls (see "The tasks"). |
| `--repeat=k` | Runs each task k times (1 to 20). A real model is not deterministic, so the summary reports each task by its median and p90 of steps, model calls, prompt tokens and wall time, and how many runs succeeded. |
| `--model=name` | The model name (default: `lisa-pro` on LISA, `nvidia/nemotron-3.5-super-vl-120b-a12b` on NVIDIA, `qwen3.8:27b-mlx` on Ollama, `mock-agent` with `--mock`). |
| `--max-steps=n` | Saved into the settings (the MCP loop does not read a step cap yet). |
| `--timeout=ms` | The time limit for one task (default 360000, or 60000 with `--mock`). |
| `--headless` | Runs without a window. The suite is **headful by default**, because headless Chromium creates no side panel document at all; a headless run photographs the panel as a page instead, and says so in the report. |
| `--prompt="..."` | One run of your own, on a real site, with a real model: the prompt is the only instruction the extension gets. Needs a URL to start on (`--start-url`), and cannot be combined with `--mock`. |
| `--start-url=https://...` | Where a `--prompt` run starts. What happens next, including which site it ends up on, is the extension's decision. |
| `--out=file.json` | Saves the full report as JSON. |
| `--panel-screenshots=dir` | Overrides the root folder of the screenshots (default: `screenshots/<run stamp>/` in this folder). |
| `--dump-snapshots` | Writes what the content script sees on each fixture page to `tests/fixtures/snapshots/`, and needs no model. |
| `--tamper=name` | Breaks the temp copy on purpose (see "Negative controls"). |
| `--effort=level` | The effort every task starts with: `auto`, `off`, `low`, `medium` (default), `high` or `max`. It is the model's reasoning level, and every model call is checked for it on the wire (`think` on the mock, `enable_thinking` and `reasoning_budget` on NVIDIA Nemotron). |

## One run of your own, on the real web

```
node tests/e2e/smoke.mjs \
  --prompt="Find one recent arXiv paper about LLM agents that browse the web, and give me its title and first author." \
  --start-url=https://duckduckgo.com
```

Nothing is scripted and no answer is predicted. The extension decides where to go, what to click, and
when it is done, so this is the closest the harness gets to watching a person use ScoutFox. It is
judged on what a user would notice: the run finished, the answer is not empty, the panel's final card
matches how the run ended, and nothing threw on the way. Because the scripted expectations are gone,
this mode needs a real model: `--mock` is refused.

## The click lab: which scale a model points with

```
npm run click-lab
npm run click-lab -- --real --repeat=2
```

Vision models do not agree on what a click coordinate means.
Claude and GPT answer in pixels of the picture, while Nemotron VL, Qwen3-VL and Gemini answer on a 0-1000 scale of it, or as a 0-1 fraction, whatever the prompt asks for.
Read on the wrong scale, every coordinate click lands hundreds of pixels off, and a cookie banner never closes.
The lab shows a model small pages with one known target each (a cookie bar, a consent modal, a small button in a shadow root, a 28 px close icon, one date in a dense row), and with `--real` the cookie banners of a few real sites.
It asks the model to click the target with the extension's click tool and reports, for each answer, on which scale it lands inside the target.
Measured on Nemotron 3.5 Super VL: 0 of 10 answers hit as pixels, 22 of 25 hit as 0-1000 or as a fraction, 10 of 10 on real banners (bahn.de, stackoverflow.com, bbc.com inside an iframe, booking.com, reddit.com).
The scale the extension uses per model is `coordinateSpaceOf` in `src/background/llm/coordinates.ts`; a near miss of a few pixels is moved onto the control by `snapPoint` in `src/content/screenshotPrivacy.ts`.

## The panel in the screenshots is Chrome's real one

Every panel screenshot comes from Chrome's own side panel: Chrome's width, Chrome's header, and the
panel scoped to the task's tab by Chrome itself, not pointed there by the harness. That is what makes
the images evidence about what a user sees rather than about what puppeteer can render. The summary
line `panel screenshots: 9 of 9 taken on Chrome's real side panel` says how much of a run was taken
on the real surface, and a screenshot that came from the fallback page fails the run: a silent
fallback would quietly stop verifying the thing that matters.

Three findings got there, all of them measured on Chromium 152 rather than assumed:

- Headless Chromium never creates a side panel document, so the suite is headful by default.
- `manifest.json` must not declare `side_panel.default_path`. While it did, the worker had to disable
  the panel globally at boot to keep it off every tab, and while that global disable is on record
  Chrome will not open the panel programmatically: `sidePanel.open()` resolves and no document is
  ever created. With no global default there is nothing to disable, and per-tab `setOptions` does the
  scoping by itself (guarded by `tests/backgroundSidePanelScoping.test.js`).
- Chrome opens a panel only on a user gesture, and browser UI (the toolbar icon) is not a DevTools
  target. So `panel-trigger.html` and `panel-trigger.js`, harness files copied in beside
  `driver.html`, take one real CDP click and call `chrome.sidePanel.open({ tabId })` inside that
  click's own task. Chrome treats it as a genuine gesture. Neither file ships.

## The tasks

There are two kinds of tasks.

The real use cases (`web-*`) are the default set of a real-model run (`npm run test:e2e`, LISA).
On a custom provider like LISA, the run first adds it through the side panel's "Custom model API" dialog, like a user: it fills the form, fetches the model list through the key proxy, adds the provider, and shoots the dialog in light and dark.
A problem there fails the run as "provider setup".
Each starts on a neutral page (`https://example.com/`) and gets only a question.
Which site to open, what to search, which cookie banner to accept and when to stop are all the model's decisions.
The check reads only facts a right answer must contain.

| Task | The question |
| --- | --- |
| `web-eiffel-tower` | the year the Eiffel Tower was completed and its height, with the site used |
| `web-python-release` | the newest stable Python 3 release and its date, from the official source |
| `web-npm-react` | the latest React version on npm and its weekly downloads |
| `web-arxiv-agents` | one recent arXiv paper about web-browsing LLM agents: title, first author, id |
| `web-github-playwright` | the stars and the latest release of microsoft/playwright |
| `web-train-hof-munich` | a train from Hof to München Hbf tomorrow around 08:00 (bahn.de has a cookie layer in a shadow root) |
| `web-framework-price` | the official Framework Laptop 16 price compared with one other shop |
| `web-cookie-accept` | open stackoverflow.com, accept its cookie banner, and name the top question |
| `web-research-archive` | the exact file name of Ollama's latest Linux amd64 archive and whether it needs zstd, looked up with `web_search` or `fetch_url` (the run must use one) |

The held-out tasks (`held-*`, `--held-out`) are open-web tasks of other kinds that nothing is ever tuned against.
They run after every change made for the tasks above, to show the change helps in general and is not fitted to those tasks.
A held-out task that fails is a finding about the agent, never a reason to edit the task.
Their traces have been read while plans were made, so they are no longer a clean test of generality: the sealed set is.

The sealed tasks (`sealed-*`, `--sealed`) judge a finished series of changes.
The harness shows only their verdicts and numbers and saves no trace, and it refuses to run one by name without `--sealed`.
If a trace of a sealed task is ever read, the set is unsealed and must be replaced with new tasks.

A run succeeds only when it ends with the expected final entry, its answer passes the check, and the model's own outcome is the expected one.
An open-web task must end with outcome "done": an answer the model itself calls "partial" or "blocked" fails, however plausible it looks to the check (`lib/metrics.mjs`).
The summary ends with a table per task (runs that succeeded, and the median and p90 of each number), and `--out` saves every model call of every run.

| Task | The question |
| --- | --- |
| `held-node-lts` | the current Active LTS major of Node.js and its codename, from the official site |
| `held-rust-release` | the latest stable Rust version and its release date |
| `held-munich-population` | Munich's population from its English Wikipedia article, and the year of the figure |
| `held-mdn-array-at` | what `Array.prototype.at()` returns for a negative index, per MDN, with an example |
| `held-hn-top-story` | the title and points of the top story on Hacker News |
| `held-pypi-requests` | the latest `requests` version on PyPI and its minimum Python version |

A task may list the sites it needs (`reachable`): the harness asks each first, and a site that does not answer skips the task with the reason, never a failure.

Two small tasks start on a page of the fixture site (`tests/fixtures/site/store.html`) and run only offline on the scripted mock (`npm run test:e2e:mock`, CI).
They are not use cases: they check that the built extension loads, a run reaches the page and the panel shows the result.
The use cases are the open-web tasks above, on the real model.

| Task | Page | The engine must |
| --- | --- | --- |
| `store-price` | `store.html` | read the page and finish with the price exactly as the page shows it (`1.399,00 EUR`) |
| `model-pick` | `store.html` | run on the model picked in the composer's model picker; the composer's effort menu offers the levels the model supports |

## What a run checks

A run fails when any of these is true.

- A task does not end with the final entry it must (`finish`), or its answer is wrong (each task has a check in `lib/tasks.mjs`).
- A model call went out without the effort the run was started with (`--effort`, Medium by default): `think` on the mock, `enable_thinking` and `reasoning_budget` on NVIDIA Nemotron.
- The harness had to stop a run: the task timed out, the model got the same prompt 15 times in a row (the loop guard), or the run stood paused with no hold to answer.
- The runner broadcast a `paused` state with no hold to answer and no user pause, or no `STATE_UPDATE` reached the harness at all.
- The service worker or the driver page logs a console error or throws, or the worker has a CSP violation (watched through CDP Audits, because a worker reports it nowhere else).
- A fixture page a task runs on shows a console error or a page error, or its content scripts are not alive (the MAIN-world net recorder flag, and an answered `GET_DOM_SNAPSHOT`).
- The side panel, opened as a page, shows a console error, a page error or a CSP violation, its script did not run, or its model-list request failed.
- The fox mark is not where it belongs: the header next to the name, or the middle of the panel above "What would you like to automate?", has no mark, has a mark that is not the fox, or shows one too small to be seen. The check reads the shape out of the rendered DOM, so it judges what a user sees, not what a source file says.
- With `--mock` only: the mock refused a call (HTTP 400, 500 or 501), a reply of the mock starts with `MOCK-FAIL:`, the run logged an error entry, or the run's action sequence does not fit the task (`expectMock` in `lib/tasks.mjs`).

## The facts of a run

`runFacts` in `lib/tasks.mjs` builds the facts from what the engine leaves behind, and the checks of a task read only these.

- The final entry of the last turn (`finish`), with its answer.
- The plan rows of the final state (`update_plan` writes them; each executed step advances them).
- The model's tool calls (`agent_response` entries), each with the result attached (`execution_result`).
- The model calls of the run (the record the mock or the proxy keeps; node `mcp`).
- What the engine sent to the page, counted inside the service worker by the harness: every `chrome.tabs.sendMessage` by its action name, and every `chrome.debugger.sendCommand` by its method. This is how the harness sees that a click was (or never was) sent to the page, which the history cannot show.
- The history rows are read without their exact copies; the number of copies is printed and never a failure.

## The screenshots

Every task saves its own folder under `screenshots/<run stamp>/` (gitignored; `--panel-screenshots` overrides the root), in light and dark:

| File | What it shows |
| --- | --- |
| `<task>-<model>-page-end.png` | The end state of the page the task ran on. |
| `<task>-<model>-panel.png` | The real Chrome side panel (page left, panel right in `...-side-by-side.png`). |
| `<task>-<model>-live-panel.png` | A task with a plan: the checklist while the run is live, or the plan card while manual approval waits. |
| `<task>-<model>-model-menu.png` | The composer's model menu, opened from the model name, with the run's model checked (`model-pick` only). |

The tall-open picture is the one that shows "what steps it took", the finish card shows "what the end result is".

## The loop guard

The mock counts identical requests in a row and writes the count into the record of the call. A run in which the model gets the same prompt 15 times in a row changes nothing and will not end by itself, so the harness stops it, and the run fails with the call number. The reply of the mock never depends on the count.

## The mock

`lib/mockOllama.mjs` is a tiny scripted agent behind the same HTTP calls the extension sends to Ollama: `POST /api/chat`, `POST /api/show`, `GET /api/tags`, `GET /api/version` and `OPTIONS`.

It speaks the MCP tool-calling protocol: a request carries a `tools` array (the Ollama function format of `SCOUTFOX_TOOLS`), and the reply is one JSON object whose message holds `tool_calls` (name + arguments object), which is what `callOllamaWithTools` reads. A chat call WITHOUT tools gets HTTP 501 with the reason: nothing in the extension calls `/api/chat` without tools any more, so a protocol drift fails loudly.

The script is stateless: it reads only the conversation of the request, the way a real model would.

- A bot check in the page content: finish at once with the honest answer, never click.
- A planning goal: `update_plan` with two steps (two steps auto-approve), then `read_page`, then `finish` with the facts.
- A click goal: `get_page_elements`, then `click` the element whose label matches the goal (an "add" label beats a generic cart label), then `finish`.
- A facts or summarize goal: `read_page`, then `finish` with the lines copied from the page text.
- A notebook goal (`notebook-fix`): `scroll` the cells panel (the result must say it moved, and the observation must have measured it), `read_page` part 1, then part 2 (cell 14 and its permission error), `get_page_elements`, `click` into cell 14, `press_key` select_all, `type` the fix without an element id, `press_key` Shift+Enter, `read_page` part 2 for the output, `finish` with the version.
- An order-list goal (`virtual-scroll`): `scroll` the windowed list and `read_page` what it draws, again, until the Zanzibar Spice Co. row is drawn, then `finish` with it.
- A two-fact goal whose page has only one fact (`partial-answer`): `read_page`, then `finish` with the price as inline code, the missing battery life said plainly, and `outcome` "partial".
  The card must be "Partly done" (class `partial`), and its body must show the price without the backticks.
- A dead-button goal (`stuck-recovery`, and `stuck-recovery-manual` with manual plan approval): `get_page_elements`, then `click` the dead Download CSV button again and again, like a stubborn model.
  It stops only when the loop says the click changed nothing: the repeat hint in a result first, then the reflection note as the user message right after the tool block.
  Then it `finish`es honestly with `outcome` "blocked": the button did not work, and what the user can do next.
  The panel card must then be "Could not finish" (class `blocked`), never the green "Done".
  In manual mode it plans first, and the harness approves the plan card like a user.
- A research goal (`research-then-answer`): `web_search`, then `fetch_url` on the result that is the install script, then `finish` with the archive name only that script names.
  Both results must come in the untrusted envelope, and without the research tools on offer it answers `MOCK-FAIL`, never a guess.
  Before the run the harness sets Settings > Research to SearXNG through the side panel's Settings tab, like a user, pointing at the fixture's search endpoint under `docs.lantern.test` (`RESEARCH_HOST` in `lib/twoSources.mjs`).
  The fixture server serves `research/search` as `research/search.json`, with `__ORIGIN__` replaced by the origin asked.
  The run also checks that the tab stayed on its page and that the panel rows read "Searched the web: ..." and "Read install.sh (docs.lantern.test)", and it shoots the Research section in light and dark.
- Anything it cannot find: a finish whose answer starts with `MOCK-FAIL:` and says what is missing. The run then ends without the data, and no check accepts it.

Every reply is validated before it is sent: the tool name must be one the request offered, and the arguments must fit the tool's parameters schema (`validateToolArgs`). A violation is an HTTP 500 - a mock bug, named, not papered over.

The self-test (`tests/mcp/mockOllama.selftest.mjs`) checks the protocol, the validator, and walks every task the way the client drives it, from the committed fixture snapshots, judged by the same checks as the smoke run. It also walks the tasks again with the page text or the element list removed: a run that lost what it needs must fail with `MOCK-FAIL`.

## Negative controls

`--tamper=name` changes only the temp copy, never `dist/` and never a source file. Use it to check that the smoke run can fail.

| Tamper | What it does | The run must |
| --- | --- | --- |
| `no-content-script` | Deletes `content/content.js`, which the manifest lists. | Exit 1: Chromium refuses to load the extension, and the error names the missing file. |
| `worker-error` | Adds a `console.error` at the top of `background/sw.js`. | Exit 1 on the worker error, although all tasks pass. |
| `broken-panel` | Makes the side panel script throw when it loads. | Exit 1 on the side panel gate. |
| `finish-says-partial` | Stores every finish row with outcome "partial", whatever the model said. | Exit 1 on an open-web task whose answer passes its check: "the model ended with outcome "partial", expected "done"". |
| `custom-provider-unsaved` | Makes "Add provider" of the "Custom model API" dialog close it without saving. | Exit 1 on a custom-provider run (LISA): "provider setup: "Add provider" stored no custom provider "lisa"". |
| `empty-page-text` | Makes the content script report no page text (the snapshot text and the full text `read_page` pages through). | Exit 1: the mock answers `MOCK-FAIL` (it cannot read a price from an empty page). |
| `no-history-rows` | Makes the runner drop every history row (`recordEntry` pushes nothing). | Exit 1: the run is invisible (no timeline rows, no final entry). |
| `zod-not-jitless` | Removes the statement that switches zod code generation off from `background/sw.js`. | Exit 1 on two `service worker CSP violation` lines, although all tasks pass. |
| `broken-net-recorder` | Makes `content/net-recorder.js` (the MAIN-world content script) throw when it loads. | Exit 1 on every fixture page: the recorder flag is not set, and the page reports a page error. |
| `bad-tool-schema` | Sets `read_page` `inputSchema.required` to null in the copy. | Exit 1: the extension must reject the tool itself, with an error naming the tool, instead of sending a schema a provider answers with HTTP 400. |
| `no-fox-mark` | Takes the fox mark out of the panel header in the copy. | Exit 1 on the mark check ("the header has no fox mark"), although every task passes. |
| `no-effort` | Makes the tool loop drop the effort the run was started with. | Exit 1: every model call went out with no reasoning field ("model call 1 went out with think=undefined, expected true for effort medium"). |
| `stale-worker` | Gives the worker a different build stamp than the side panel, like a worker Chrome kept running after a rebuild. | Exit 1: the side panel gate reports that the panel shows its reload bar. |
| `idle-after-restore` | Makes a restarted worker reset the restored run to `idle` whenever the runner meta exists. | Exit 1 on `worker-restart-midrun`: "after a mid-run worker restart the status is "idle", expected "stopped"". |
| `clear-keeps-loop` | Makes New chat clear the thread without ending the run. | Exit 1 on `clear-midrun`: the model gets more calls after New chat, and the rows come back into the cleared thread. |
| `no-press-key` | Takes `press_key` out of the tool list the model is offered. | Exit 1 on `editor-replace`: the mock's `press_key` reply names a tool the request did not offer (HTTP 500), and the editor keeps its old code. |
| `type-needs-id` | Makes `type` refuse without an `element_id` again. | Exit 1 on `editor-replace`: the type into the focused editor fails, the mock answers `MOCK-FAIL`, and the page check finds the old code. |
| `no-observation` | Drops the `Observation:` line from every action result. | Exit 1 on `editor-replace`: the mock answers `MOCK-FAIL` (the click was not observed), and `expectMock` finds no observation in the tool results the model got. |
| `scroll-lies` | Makes `scroll` report the full step as moved without turning the wheel (the old always-"Scrolled" path). | Exit 1 on `notebook-fix` and `virtual-scroll`: the scroll result claims a move, the observation measured none, and the mock answers `MOCK-FAIL`. |
| `read-repeats` | Makes `read_page` ignore `part` and always read part 1. | Exit 1 on `notebook-fix`: the mock asks for part 2, gets part 1, and answers `MOCK-FAIL`. |
| `no-repeat-guard` | Turns the repeat guard off: no repeat hint, no reflection note. | Exit 1 on `stuck-recovery`: the mock clicks the dead button until it gives up and answers `MOCK-FAIL`, and `expectMock` finds no hint and no reflection. |
| `finish-ignores-outcome` | Drops the `outcome` the finish tool named from the finish row, so the panel falls back to the old rule (Done unless a step failed). | Exit 1 on `stuck-recovery` and `partial-answer`: the honest "it did not work" and "only part of it" answers get the green "Done" card instead of "Could not finish" and "Partly done", and `expectMock` finds no finish outcome. |
| `no-research` | Stops offering `web_search` and `fetch_url`, as if Settings > Research were off. | Exit 1 on `research-then-answer`: the mock answers `MOCK-FAIL` (the research tools are not offered), no research row appears, and the card says Failed. |

## Real mode and the Origin note

Ollama answers 403 to any request from a `chrome-extension://` origin, unless `OLLAMA_ORIGINS` was set when the server started. The harness must not restart your Ollama, so in real mode the extension talks to a small proxy on port 11435. The proxy drops the Origin header and forwards the request to Ollama.

## Chromium

Branded Chrome ignores `--load-extension`. Use Chromium or Chrome for Testing, and point `CHROMIUM_PATH` at it. The run starts it headless with `pipe: true` and `enableExtensions: true`, and it never leaves a browser or a server running.

## Files

- `smoke.mjs`: the harness (Layer 2).
- `driver.html`: the empty extension page that sends the messages (`START_TASK`, `GET_AGENT_STATE`, and the answers to a hold), added to the copy of `dist/`.
- `lib/tasks.mjs`: the tasks, their checks, the expectations, and `runFacts`, which builds the facts of a run.
- `lib/mockOllama.mjs` and `lib/mockOllama.selftest.mjs`: the offline mock (Layer 1) and its self-test.
- `lib/callRecord.mjs`: the record of a model call, shared by the proxy and the mock.
- `lib/extensionCopy.mjs`: the copy of `dist/` and the tampers.
- `lib/fixtureServer.mjs`: the static server for the fixture site.
- `lib/ollamaProxy.mjs`: the Origin proxy for the real Ollama.
- `lib/keyProxy.mjs`: the proxy in front of a real OpenAI-compatible server (LISA, NVIDIA) that adds the key, so the extension only holds a placeholder.
- `lib/metrics.mjs`: the success rule of a run, and the median and p90 per task over repeated runs.
- `lib/providers.mjs`: the real OpenAI-compatible servers `--provider` takes, with their URL, key variables and default model.
- `lib/twoSources.mjs`: the Chromium host rules that map fake shop names onto the fixture server.
- `screenshots/<run stamp>/`: the screenshots of the runs (gitignored).
