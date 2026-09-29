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
| `npm run build` | Builds the extension into `dist/` with Vite, then checks that `dist/` can be loaded (manifest paths, one-file worker, classic content scripts, that every function passed to `executeScript({ func })` uses only its own names and page globals, reserved `_` names, page references). |
| `npm run check` | Runs `node --check` on the 10 source files listed in `package.json`. |
| `npm test` | Runs the unit tests with `node --test tests/*.test.js`, no browser needed. |
| `npm run evalscan` | Fails when `dist/` calls `eval`, `new Function` or `Function()` (one hit is allowed, see section 4), so run `npm run build` first. |
| `npm run zip` | Zips the contents of `dist/` into `scoutfox-chrome-extension.zip` in the repository root, without sourcemaps, so run `npm run build` first. |
| `npm run test:e2e` | Builds, then runs the browser smoke test in Chromium against an offline mock model (needs a one-time setup, see "E2E Smoke" in section 3). |

### CI
`.github/workflows/ci.yml` runs on every push to `main` or `dev` and on every pull request into them, on Node 22.x and 24.x.
It runs `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run evalscan` and `npm run zip`.
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
The code is not minified, so it stays readable, and the `//#region` comments in it name the original source file of most parts (a few small modules, such as the ones in `background/harness/`, sit inside a neighbour's region).
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
This runs `node --test tests/*.test.js` - 429 tests across 51 files as of this writing.
None of it needs a real browser.

### Syntax Check
```bash
npm run check
```
Runs `node --check` across the 10 source files listed in `package.json`, catching a syntax error before it ever reaches a browser reload.

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

The older tests were not moved to these helpers.
The helpers have their own tests: `tests/fakeChrome.test.js` and `tests/fakeStorageSession.test.js`.
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
See [tests/e2e/README.md](tests/e2e/README.md) for all options, what a run checks, and the negative controls.
In CI it runs from `.github/workflows/e2e.yml`, when a pull request gets the `e2e` label or when you start it by hand.

---

## 4. Chrome Web Store Publishing Checklist

Before packaging for the Chrome Web Store:
1. **Manifest V3 Verification**: Ensure `"manifest_version": 3` in `public/manifest.json`.
2. **Permissions Audit**: `public/manifest.json` currently requests `sidePanel`, `scripting`, `storage`, `tabs`, `tabGroups`, `alarms` and `declarativeNetRequest`, plus `host_permissions: ["<all_urls>"]`.
   Confirm each is still used before submitting.
   Store reviewers question `<all_urls>` and `declarativeNetRequest` most often, so have a justification ready for both.
   Planned (not in `public/manifest.json` yet): the next version will add the `debugger` permission for real clicks.
   It will need its own store justification, because reviewers look closely at `debugger`.
3. **Icons Audit**: Ensure `icon16.png`, `icon48.png`, and `icon128.png` are present in `public/icons/`.
   The build copies them into `dist/icons/`.
4. **Eval Scan**: Run `npm run build && npm run evalscan`.
   The extension's Content Security Policy blocks `eval`, `new Function` and `Function()`, so the scan fails on any call to them in `dist/`.
   It has exactly one allowed hit: the `new Function` of the `execute_js` action in `background/agentEngine.js`.
   That code runs in the web page (the `MAIN` world, through `chrome.scripting.executeScript`), not in the extension, and the page's own policy can block it.
5. **Create Zip Package**:
   ```bash
   npm run build && npm run zip
   ```
   This writes `scoutfox-chrome-extension.zip` in the repository root.
   It holds the contents of `dist/`, with `manifest.json` at the root of the zip, and no sourcemaps.
6. Upload `scoutfox-chrome-extension.zip` to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## 5. Build Foundation and What Comes Next

> Status: the build step is done (phase P0 of the LangGraph rework, 2026-09-29).
> The rest of the rework is decided but not built yet, see section 3 of [PRD.md](PRD.md).

What is true today:
- `npm run build` bundles the extension with Vite into `dist/`, and you load `dist/` unpacked in `chrome://extensions`, not the repository folder.
- The manifest and the icons live in `public/`, and the build copies them into `dist/`.
- The sources are still plain JavaScript ES modules, and the build changes no behavior.
- CI zips the built `dist/`, not the raw source folders.

Planned, not built yet:
- TypeScript comes in a later phase.
  Vite is also needed to bundle LangGraph.js so it can run in the MV3 service worker.
- `public/manifest.json` will request the `debugger` permission, so the agent can do real clicks while a task runs.
  During a task, Chrome shows a yellow "is debugging this browser" bar.
  This is expected.
- The test suite will be rewritten for the new graph, and the test count above will change.
