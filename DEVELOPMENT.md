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

## 3. Chrome Web Store Publishing Checklist

Before packaging for the Chrome Web Store:
1. **Manifest V3 Verification**: Ensure `"manifest_version": 3` in `manifest.json`.
2. **Permissions Audit**: `manifest.json` currently requests `sidePanel`, `activeTab`, `scripting`, `storage`, `tabs`, `tabGroups`, `alarms` and `declarativeNetRequest`, plus `host_permissions: ["<all_urls>"]`.
   Confirm each is still used before submitting.
   Store reviewers question `<all_urls>` and `declarativeNetRequest` most often, so have a justification ready for both.
3. **Icons Audit**: Ensure `icon16.png`, `icon48.png`, and `icon128.png` are present in `/icons`.
4. **Create Zip Package**:
   ```bash
   zip -r scoutfox-browser-agent-v1.0.0.zip . -x "*.git*" "*PRD.md*"
   ```
5. Upload `.zip` to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).
