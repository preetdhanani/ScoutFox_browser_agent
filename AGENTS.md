# Agent instructions for this project (ScoutFox)

These rules apply to every agent session working in this repository.

## Verification rule (highest priority)

- Nothing lands without a test that can fail.
- Verification has two layers, and a change is only accepted when BOTH pass:
  - Layer 1: the mock self-test (`node tests/mcp/mockOllama.selftest.mjs`). No browser, runs in under a second, and runs first inside every `--mock` e2e run.
  - Layer 2: the Chromium end-to-end run (`npm run test:e2e`). The built extension is loaded into a real Chromium and driven through whole tasks.
    By default it runs open-web tasks on LISA (`lisa-pro`, an OpenAI-compatible custom endpoint at `https://chat-1.ki-awz.iisys.de/api`): a neutral start page and only a question, the model picks the real websites itself.
    The run adds LISA through the side panel's "Custom model API" dialog, like a user does.
    It needs `LISA_API_KEY` in the environment or `LISA_API` in the repo `.env`.
    `npm run test:e2e -- --held-out` runs the held-out open-web tasks: nothing is ever tuned against them, and they run after every change to show it helps in general.
    `npm run test:e2e -- --sealed` runs the sealed tasks, which show only verdicts and numbers; never read a sealed task's trace.
    Run each task once (the default). Do not use `-- --repeat` unless Prit asks for it.
    `-- --provider=nvidia` runs on NVIDIA NIM instead (`NVIDIA_API_KEY` or `NVIDIA_API`).
    `npm run test:e2e:mock` runs the same harness offline on the scripted mock (CI uses it, since CI has no key).
- After every implementation or change, run both layers. If either fails, fix the change until both pass. No change is done while a layer is red.
- The verification harness is for the verification steps only. It never gets into the extension itself: nothing from `tests/e2e/` (mock, driver, fixtures, screenshots) enters `dist/` or the shipped zip.
- Every successful Chromium simulation produces screenshots for EVERY test case, saved by default with the paths printed in the report:
  - the side panel showing the steps the agent took and the end result (light and dark, tall, action group open, close-ups),
  - the end state of the page the task ran on.
- The harness loads the built extension (`dist/`) into Chromium with a fresh temp profile, serves the local fixture site, and drives tasks through the extension's own message path. It never uses Prit's personal Chrome.
- `--mock` runs fully offline with the scripted LLM server (`tests/mcp/mockOllama.mjs`). Deterministic, no model, no network.
  It is the offline check (`npm run test:e2e:mock`); the default verification run uses the real LISA model.
- Every new behaviour gets a harness scenario: the feature must be observable in the simulated browser (history entries, side panel DOM, screenshots), not only in unit tests.
- Negative controls (`--tamper`) prove a check can fail. When adding a check, add or confirm a tamper or a negative scenario for it.
- Unit tests (`npm test`) are the fast inner loop; the e2e harness (`npm run test:e2e`) is the outer gate.
- When the engine's wire protocol changes, update the mock in the same change. A mock that no longer matches the engine fails loudly (HTTP 501 with the reason), and that failure is a task, not noise.

## General engineering rules

- Never use the em dash. Use a plain dash.
- Never manually modify CHANGELOG.md or files marked as auto-generated.
- In long Markdown files, put each full sentence on its own line.
- Prefer quality, simplicity, robustness and long term maintainability over development cost.
- For bug fixes, reproduce the bug in the e2e harness first, as close to the user experience as possible, then fix it.
- Be picky about the UI in screenshots. If something looks off, fix it along the way, even if it is not the task at hand.
- Implementation plans are reviewed by an independent subagent in a separate context before execution.
