# ScoutFox end-to-end verification harness

## What it is

The verification of this project has two layers, and a change is only accepted when BOTH pass.

- Layer 1: the unit tests (`npm test`). Plain Node, no browser, no model.
- Layer 2: the real-model run (`smoke.mjs`). It loads the built extension (`dist/`) into Chromium with puppeteer-core, and a real model (LISA by default) drives whole tasks through it.

There is no scripted mock model and no tamper run: every task is a real model taking real actions.

The engine under test is the MCP tool loop (`src/background/mcp/`): the LLM calls tools, the MCP server executes them in the browser, results are fed back until `finish`.

The harness never loads `dist/` itself. It copies `dist/` into a temp folder, leaves out the sourcemaps like the zip does, and adds one file, `driver.html` from this folder. The browser sees the files a user installs, and the test page never enters `dist/` or the shipped zip. Nothing of the harness (driver, fixtures, screenshots) ships with the extension.

The temp folder and a fresh Chromium profile are removed at the end, also on a failure and on Ctrl+C.

## Setup

1. `npm ci` at the repo root (Vite, for the build).
2. `cd tests/e2e && npm ci` (puppeteer-core only).
3. Chromium at `/Applications/Chromium.app/Contents/MacOS/Chromium`, or any other build in `CHROMIUM_PATH`.

## Run

```
npm run test:e2e                      # builds dist/ first, then runs on LISA (needs LISA_API_KEY or LISA_API in .env)
npm run test:e2e -- --held-out        # the held-out open-web tasks on LISA
npm run test:e2e -- --provider=nvidia # the same open-web tasks on NVIDIA NIM (needs NVIDIA_API_KEY)
npm run test:e2e -- --sealed          # the sealed tasks: verdicts and numbers only
```

The run against a real local Ollama needs the model to be pulled already.

```
node tests/e2e/smoke.mjs --provider=ollama            # the open-web tasks with qwen3.8:27b-mlx
node tests/e2e/smoke.mjs --provider=ollama --task=web-eiffel-tower --model=gemma4:12b
```

The run prints every task with its steps, model calls and tokens, then a summary, and it ends with `SMOKE PASSED` or `SMOKE FAILED` with the list of problems. The exit code is 0 for a pass and 1 for a fail. If the sources are newer than `dist/`, it prints a warning to build again (or to use `--build`).

| Option | What it does |
| --- | --- |
| `--build` | Runs `npm run build` first, so `dist/` is fresh. |
| `--task=a,b` | Runs only these tasks, for example `web-eiffel-tower,web-npm-react` |
| `--provider=name` | The real model server: `lisa` (default), `nvidia` or `ollama`. The OpenAI-compatible profiles live in `lib/providers.mjs`. |
| `--held-out` | Runs the held-out open-web tasks instead of the regular ones (see "The tasks"). |
| `--sealed` | Runs the sealed open-web tasks and shows only their verdicts and numbers, never their steps, answers or model calls (see "The tasks"). |
| `--repeat=k` | Runs each task k times (1 to 20). A real model is not deterministic, so the summary reports each task by its median and p90 of steps, model calls, prompt tokens and wall time, and how many runs succeeded. |
| `--model=name` | The model name (default: `lisa-pro` on LISA, `nvidia/nemotron-3.5-super-vl-120b-a12b` on NVIDIA, `qwen3.8:27b-mlx` on Ollama). |
| `--max-steps=n` | Saved into the settings (the MCP loop does not read a step cap yet). |
| `--timeout=ms` | The time limit for one task (default: the task's own, else 360000). |
| `--headless` | Runs without a window. The suite is **headful by default**, because headless Chromium creates no side panel document at all; a headless run photographs the panel as a page instead, and says so in the report. |
| `--prompt="..."` | One run of your own, on a real site, with a real model: the prompt is the only instruction the extension gets. Needs a URL to start on (`--start-url`). |
| `--start-url=https://...` | Where a `--prompt` run starts. What happens next, including which site it ends up on, is the extension's decision. |
| `--out=file.json` | Saves the full report as JSON. |
| `--panel-screenshots=dir` | Overrides the root folder of the screenshots (default: `screenshots/<run stamp>/` in this folder). |
| `--dump-snapshots` | Writes what the content script sees on the store fixture page to `tests/fixtures/snapshots/`, and needs no model. |
| `--effort=level` | The effort every task starts with: `auto`, `off`, `low`, `medium` (default), `high` or `max`. It is the model's reasoning level, and every model call is checked for it on the wire (`enable_thinking` and `reasoning_budget` on NVIDIA Nemotron). |

## One run of your own, on the real web

```
node tests/e2e/smoke.mjs \
  --prompt="Find one recent arXiv paper about LLM agents that browse the web, and give me its title and first author." \
  --start-url=https://duckduckgo.com
```

Nothing is scripted and no answer is predicted. The extension decides where to go, what to click, and
when it is done, so this is the closest the harness gets to watching a person use ScoutFox. It is
judged on what a user would notice: the run finished, the answer is not empty, the panel's final card
matches how the run ended, and nothing threw on the way. It always runs on a real model.

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

Three default tasks run on local pages that copy a real case; the model acts on them like on any site.

| Task | Page | The question |
| --- | --- | --- |
| `web-notebook-fix` | `notebook.html` | fix the failing cell of a notebook so it installs Ollama without sudo, run it and give the version |
| `web-credentials-json` | `credentials.html` | a JSON file of the ten certifications with name, issue date and credential URL (the LinkedIn case); the file must hold every one, and an answer that pastes the whole file is printed as a note |
| `web-chat-chain` | `credentials.html`, then `notebook.html` | how many certifications the page lists (10); after a Compact, in the same chat on a page without the fact: that number times 7, the result only (70) |

### A follow-up turn in the same chat (`followUp`)

A task can carry a `followUp` (see `../mcp/tasks.mjs`): a second turn in the same tab and the same chat, started once the first turn has ended and been checked.
It is how the chain of a chat is verified: a new request in a chat gets the earlier turns, or after a Compact their summary.

`web-chat-chain` uses every part of it, in this order.

1. Turn 1 runs on `credentials.html` and must answer 10.
2. `compact: true`: in Chrome's real side panel, the context ring of the composer must show a share above 0%. The harness opens the ring's card with a real click, clicks "Compact chat" with a real click, and waits (up to 3 minutes, the summary is a real model call) for the "Chat compacted" divider in the timeline. It opens the divider's summary like a reader. The ring, the open card and the divider are shot as close-ups, light and dark.
3. `navigate: 'notebook.html'`: the tab goes to a page that does not have the fact.
4. Turn 2 sends "Take the number of certifications you gave me in your last answer, multiply it by 7, and reply with the result only." in the same tab and chat.
5. Turn 2 must finish with outcome "done" and answer 70 (no other number than the 10 and the 7), make no `read_page`, `get_page_elements`, `find` or `take_screenshot` call (`noReads`), and its first model request must start with the chain header and hold the summary of the Compact (the call record keeps the first user message as `firstUserText`).
6. The panel's end card of turn 2 must be "Done".

A problem of the follow-up is reported with the task and fails the run like any other check.

## What a run checks

A run fails when any of these is true.

- A task does not end with the final entry it must (`finish`), or its answer is wrong (each task has a check in `../mcp/tasks.mjs`).
- A model call went out without the effort the run was started with (`--effort`, Medium by default): `enable_thinking` and `reasoning_budget` on NVIDIA Nemotron.
- The harness had to stop a run: the task timed out, or the run stood paused with no hold to answer.
- The runner broadcast a `paused` state with no hold to answer and no user pause, or no `STATE_UPDATE` reached the harness at all.
- The service worker or the driver page logs a console error or throws, or the worker has a CSP violation (watched through CDP Audits, because a worker reports it nowhere else).
- A fixture page a task runs on shows a console error or a page error, or its content scripts are not alive (the MAIN-world net recorder flag, and an answered `GET_DOM_SNAPSHOT`).
- The side panel, opened as a page, shows a console error, a page error or a CSP violation, its script did not run, or its model-list request failed.
- The fox mark is not where it belongs: the header next to the name, or the middle of the panel above "What would you like to automate?", has no mark, has a mark that is not the fox, or shows one too small to be seen. The check reads the shape out of the rendered DOM, so it judges what a user sees, not what a source file says.

## The facts of a run

`runFacts` in `../mcp/tasks.mjs` builds the facts from what the engine leaves behind, and the checks of a task read only these.

- The final entry of the last turn (`finish`), with its answer.
- The plan rows of the final state (`update_plan` writes them; each executed step advances them).
- The model's tool calls (`agent_response` entries), each with the result attached (`execution_result`).
- The model calls of the run (the record the key proxy keeps; node `mcp`).
- What the engine sent to the page, counted inside the service worker by the harness: every `chrome.tabs.sendMessage` by its action name, and every `chrome.debugger.sendCommand` by its method. This is how the harness sees that a click was (or never was) sent to the page, which the history cannot show.
- The history rows are read without their exact copies; the number of copies is printed and never a failure.

## The screenshots

Every task saves its own folder under `screenshots/<run stamp>/` (gitignored; `--panel-screenshots` overrides the root), in light and dark:

| File | What it shows |
| --- | --- |
| `<task>-<model>-page-end.png` | The end state of the page the task ran on. |
| `<task>-<model>-panel.png` | The real Chrome side panel (page left, panel right in `...-side-by-side.png`). |
| `<task>-<model>-live-panel.png` | A task with a plan: the checklist while the run is live, or the plan card while manual approval waits. |
| `<task>-<model>-context-ring-{light,dark}.png` | A task with `followUp.compact`: the composer with the context ring after the first turn. |
| `<task>-<model>-context-card-{light,dark}.png` | The card the ring opens: the window, the bar of this chat, the note and "Compact chat". |
| `<task>-<model>-compacted-{light,dark}.png` | The "Chat compacted" divider in the timeline, with its summary opened. |
| `<task>-<model>-followup-*.png` | The page end, the panel and the side-by-side view after the follow-up turn. |

The tall-open picture is the one that shows "what steps it took", the finish card shows "what the end result is".

## Real mode and the Origin note

Ollama answers 403 to any request from a `chrome-extension://` origin, unless `OLLAMA_ORIGINS` was set when the server started. The harness must not restart your Ollama, so in real mode the extension talks to a small proxy on port 11435. The proxy drops the Origin header and forwards the request to Ollama.

## Chromium

Branded Chrome ignores `--load-extension`. Use Chromium or Chrome for Testing, and point `CHROMIUM_PATH` at it. The run starts it headless with `pipe: true` and `enableExtensions: true`, and it never leaves a browser or a server running.

## Files

- `smoke.mjs`: the harness (Layer 2).
- `driver.html`: the empty extension page that sends the messages (`START_TASK`, `GET_AGENT_STATE`, and the answers to a hold), added to the copy of `dist/`.
- `panel-trigger.html` and `panel-trigger.js`: the harness page that opens Chrome's real side panel on a genuine gesture.
- `../mcp/tasks.mjs`: the tasks, their checks, and `runFacts`, which builds the facts of a run.
- `../mcp/callRecord.mjs`: the record of a model call, kept by the proxies (with the first user message, where the chain of a chat is).
- `lib/extensionCopy.mjs`: the copy of `dist/` without its sourcemaps.
- `lib/fixtureServer.mjs`: the static server for the local pages.
- `lib/ollamaProxy.mjs`: the Origin proxy for a real local Ollama.
- `lib/keyProxy.mjs`: the proxy in front of a real OpenAI-compatible server (LISA, NVIDIA) that adds the key, so the extension only holds a placeholder.
- `lib/metrics.mjs`: the success rule of a run, and the median and p90 per task over repeated runs.
- `lib/providers.mjs`: the real OpenAI-compatible servers `--provider` takes, with their URL, key variables and default model.
- `screenshots/<run stamp>/`: the screenshots of the runs (gitignored).
