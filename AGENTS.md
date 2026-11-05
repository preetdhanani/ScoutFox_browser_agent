# Agent instructions for this project (ScoutFox)

These rules apply to every agent session working in this repository.

## Verification rule (highest priority)

- Nothing lands without a test that can fail.
- Verification has two layers, and a change is only accepted when BOTH pass:
  - Layer 1: the unit tests (`npm test`). Plain Node, no browser, no model.
  - Layer 2: the real-model Chromium run (`npm run test:e2e`). The built extension is loaded into a real Chromium and the real model drives whole tasks.
    It runs on LISA (`lisa-pro`, an OpenAI-compatible custom endpoint at `https://chat-1.ki-awz.iisys.de/api`): a neutral start page and only a question, the model picks the real websites itself.
    Two tasks run on local pages that copy a real case (`notebook.html`, `credentials.html`); the model acts on them like on any site.
    The run adds LISA through the side panel's "Custom model API" dialog, like a user does.
    It needs `LISA_API_KEY` in the environment or `LISA_API` in the repo `.env`.
    `npm run test:e2e -- --held-out` runs the held-out open-web tasks: nothing is ever tuned against them, and they run after every change to show it helps in general.
    `npm run test:e2e -- --sealed` runs the sealed tasks, which show only verdicts and numbers; never read a sealed task's trace.
    Run each task once (the default). Do not use `-- --repeat` unless Prit asks for it.
    `-- --provider=nvidia` runs on NVIDIA NIM instead (`NVIDIA_API_KEY` or `NVIDIA_API`), only when LISA is down.
- There is no scripted mock model and no tamper run: every e2e task is a real model taking real actions.
- After every implementation or change, run both layers. If either fails, fix the change until both pass. No change is done while a layer is red.
- The verification harness is for the verification steps only. It never gets into the extension itself: nothing from `tests/e2e/` (driver, fixtures, screenshots) enters `dist/` or the shipped zip.
- Every successful Chromium run produces screenshots for EVERY test case, saved by default with the paths printed in the report:
  - the side panel showing the steps the agent took and the end result (light and dark, tall, action group open, close-ups),
  - the end state of the page the task ran on.
- The harness loads the built extension (`dist/`) into Chromium with a fresh temp profile, serves the local pages of the two local tasks, and drives tasks through the extension's own message path. It never uses Prit's personal Chrome.
- A new behaviour is checked in a unit test, and where the real model can show it, in a real-model task (history entries, side panel DOM, screenshots).
- A unit test must be able to fail: when adding a check, confirm it fails on code that lacks the behaviour.

## General engineering rules

- Never use the em dash. Use a plain dash.
- Never manually modify CHANGELOG.md or files marked as auto-generated.
- In long Markdown files, put each full sentence on its own line.
- Prefer quality, simplicity, robustness and long term maintainability over development cost.
- For bug fixes, reproduce the bug first, in a unit test or a real-model task, as close to the user experience as possible, then fix it.
- Be picky about the UI in screenshots. If something looks off, fix it along the way, even if it is not the task at hand.
- Implementation plans are reviewed by an independent subagent in a separate context before execution.
