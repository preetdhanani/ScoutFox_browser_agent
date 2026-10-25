# Verification: the harness now photographs Chrome's real side panel

Date: 2026-10-19, run by the OpenCode assistant. Change set: production (manifest, worker boot, Ollama
tool-call wire format) plus the harness.

## What changed and why

The suite used to photograph `sidepanel.html` opened as a 400 px tab, because puppeteer cannot open a
side panel (Chrome requires a user gesture). That proved the panel's content and nothing about the
surface a user actually looks at: not Chrome's width, not Chrome's header, not the panel being scoped
to one tab.

Three things had to be true before the real panel could appear, all of them established by probe runs
against Chromium 152 rather than assumed:

1. **Headful.** Headless Chromium creates no side panel document at all, however it is asked for. The
   suite now runs headful by default and `--headless` opts out (with the report saying so).
2. **No global panel registration.** `manifest.json` declared `side_panel.default_path`, which offers
   the panel on every tab; the worker countered that with a global `setOptions({ enabled: false })` at
   boot. While that global disable is on record Chrome will not open the panel programmatically:
   `sidePanel.open()` resolves and no document is ever created. The manifest entry and the boot
   disable are both gone, so there is nothing to override, and the existing per-tab `setOptions` calls
   do the scoping on their own.
3. **A real click on a page of the extension.** Browser UI is not a DevTools target, so the toolbar
   icon cannot be clicked. The harness copy now includes `panel-trigger.html` + `panel-trigger.js`,
   which take one CDP click and call `chrome.sidePanel.open({ tabId })` inside that click's own task.
   Chrome accepts it as a genuine gesture.

## A real bug the real web found

The first run of the new `--prompt` mode (real site, real model, prompt only) died on the second model
call with `Ollama error: 400 {"error":"Value looks like object, but can't find closing '}' symbol"}`.

Reproduced against local Ollama 0.40.6 with three one-line requests: `tool_calls[].function.arguments`
as an **object** is accepted, as a **JSON string** gets exactly that 400. `callOllamaWithTools` was
returning `JSON.stringify(tc.function.arguments)`, the OpenAI convention the loop uses internally, so
the first tool call came back in the history as a string and Ollama refused the whole request. No
single-step run can see this, which is why every scripted task had been passing it for months.

Fixed in `src/background/llm/index.ts` (`withObjectToolArguments`): the loop's internal string form is
kept, and the strings are turned back into objects where the request is built. The mock now answers the
same 400 text Ollama does for a string `arguments`, so the offline suite cannot pass a request a real
server would refuse.

## Verification

- Layer 1, mock self-test: `node tests/mcp/mockOllama.selftest.mjs` - **46 checks passed** (3 new: the
  400, its message, and that an object is not refused).
- Negative control: with the fix undone, `npm run test:e2e` fails with the same 400 the user would
  have hit, and passes again when it is restored. The check can fail, which is what makes it a check.
- Layer 2, Chromium: `npm run test:e2e` - **SMOKE PASSED (9 tasks)**, with
  `panel screenshots: 9 of 9 taken on Chrome's real side panel`.
- Unit suite: no file that passed before now fails, and 33 files that were failing pass again
  (`src/background/mcp/*` and `AgentRunner` imported sibling `.ts` files as `.js`, which Node's
  type-stripping loader cannot resolve; the imports now follow the repo convention).
- The remaining unit failures all import `src/background/agent/*` or `src/background/graph/*`, modules
  deleted with the LangGraph engine. Pre-existing, unrelated to this change, listed as follow-up.

## What the run writes

Per task, in `tests/e2e/screenshots/<run>/`:

- `<task>-side-by-side.png` - the page the task ran on, three panel widths wide, next to Chrome's real
  side panel at Chrome's own width. Both halves come from the same Chrome at the same pixel ratio, so
  the proportions are the proportions on screen.
- `<task>-panel.png` - that panel on its own, 720 x 1462 px (Chrome gave it 360 CSS px, pixel ratio 2).
- `<task>-page-end.png` - the page the task ended on.

## Rules added so this cannot quietly rot

- A panel screenshot taken on the fallback page is a **failure**, not a warning: `judge()` reports
  `the panel screenshot came from the fallback, not the real side panel`. Only a `--headless` run is
  allowed to fall back, and it says so.
- A page screenshot that cannot be taken is a failure (`the page end screenshot could not be taken`),
  where it used to be swallowed.
- Every task's final card is now read off the real panel and compared with what the run's ending
  deserves (`Done`, `Unconfirmed answer`, `Failed`), so a run that did not finish cannot show the
  green card a user would trust. This used to be checked only for tasks that opted in, and none did.
- The mock refuses a tool-call echo real Ollama would refuse.

## Look-overs deliberately left

- Dark mode: the real panel follows Chrome's theme, so a dark screenshot needs the harness to set the
  browser theme. The old dark shot came from the emulated page and is gone with it.
- The panel's console output and CSP hook are watched on the fallback page and by `checkSidePanel`;
  on the CDP-driven real panel only uncaught exceptions are collected.
- `--prompt` judges a run on what a user would notice, not on a predicted answer. It is a smoke test of
  the whole loop on the real web, and its result depends on the live model and the live site.
