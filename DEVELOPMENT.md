# 🛠️ Development & Chrome Publishing Guide

> Developer guidelines for building, testing, and submitting **ScoutFox AI Browser Agent** to the Chrome Web Store.

---

## 1. Local Development Workflow

### Extension Reloading
When modifying background scripts, content scripts, or sidepanel UI:
1. Go to `chrome://extensions`.
2. Locate **ScoutFox AI Browser Agent** (the `name` field in `manifest.json`).
3. Click the **Refresh (🔄)** icon on the extension card.
4. If testing content script DOM changes, refresh the target web page tab as well.

---

## 2. Testing Extension Logic

### Service Worker Logs
To inspect background service worker output (`background/background.js`, `background/agentEngine.js`, `background/apiClients.js`):
1. Navigate to `chrome://extensions`.
2. Find the ScoutFox AI Browser Agent extension.
3. Click **service worker** link under "Inspect views".
4. Developer Tools console will open for the background worker.

### SidePanel UI Logs
Right-click anywhere inside the SidePanel UI and select **Inspect** to open DevTools for `sidepanel.html`.

---

## 3. Running the Automated Test Suite

### Test Suite
Run the full suite with:
```bash
npm test
```
This runs `node --test tests/*.test.js` - 258 tests across 48 files as of this writing.
None of it needs a real browser.

### Syntax Check
```bash
npm run check
```
Runs `node --check` across all 9 source files, catching a syntax error before it ever reaches a browser reload.

### Test Approach
`chrome.*` APIs are hand-mocked per test file, not a real browser.
Several tests monkey-patch `ApiClients.generateCompletion` to drive a real task through the actual background message-passing code, instead of only unit-testing pieces in isolation.

---

## 4. Chrome Web Store Publishing Checklist

Before packaging for the Chrome Web Store:
1. **Manifest V3 Verification**: Ensure `"manifest_version": 3` in `manifest.json`.
2. **Permissions Audit**: `manifest.json` currently requests `sidePanel`, `scripting`, `storage`, `tabs`, `tabGroups`, `alarms` and `declarativeNetRequest`, plus `host_permissions: ["<all_urls>"]`.
   Confirm each is still used before submitting.
   Store reviewers question `<all_urls>` and `declarativeNetRequest` most often, so have a justification ready for both.
   Planned (not in `manifest.json` yet): the next version will add the `debugger` permission for real clicks.
   It will need its own store justification, because reviewers look closely at `debugger`.
3. **Icons Audit**: Ensure `icon16.png`, `icon48.png`, and `icon128.png` are present in `/icons`.
4. **Create Zip Package**:
   ```bash
   zip -r scoutfox-browser-agent-v1.0.0.zip . -x "*.git*" "*PRD.md*"
   ```
5. Upload `.zip` to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## 5. Upcoming Build Changes (planned, decided 2026-09-28)

> Status: decided, not built yet.
> Today's instructions in this guide stay valid until these changes land.

Today the extension has no build step.
It is plain JavaScript ES modules, and you load the repo folder unpacked.

The next version will change this:
- The project will move to TypeScript + Vite.
  Vite is needed to bundle LangGraph.js so it can run in the MV3 service worker.
- You will run a build first, then load the built output folder unpacked in `chrome://extensions`, not the repo folder.
- CI will zip the built output, not the raw source folders.
- `manifest.json` will request the `debugger` permission, so the agent can do real clicks while a task runs.
  During a task, Chrome shows a yellow "is debugging this browser" bar.
  This is expected.
- The test suite will be rewritten for the new graph, and the test count above will change.
