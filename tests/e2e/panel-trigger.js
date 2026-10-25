/**
 * Opens the REAL Chrome side panel for one tab, from the genuine click this page's button gets.
 *
 * The harness needs the panel itself, not a copy of sidepanel.html opened as a tab: the real panel
 * is what the user looks at, it sizes itself the way Chrome sizes it, and inside it
 * chrome.tabs.query({active, currentWindow}) answers with the tab the panel belongs to on its own.
 *
 * `?tab=<id>` says which tab the panel must attach to. The id is read without awaiting anything so
 * chrome.sidePanel.open() stays in the click's own task and Chrome still sees the user gesture.
 */
const tabId = Number(new URLSearchParams(location.search).get('tab'));

// The harness polls this: 'pending' -> 'ok' or 'rejected: <message>'.
window.__openResult = 'pending';

document.getElementById('openPanel').addEventListener('click', () => {
  const target = Number.isInteger(tabId) && tabId > 0 ? { tabId } : { windowId: chrome.windows.WINDOW_ID_CURRENT };
  Promise.resolve(chrome.sidePanel.open(target))
    .then(() => { window.__openResult = 'ok'; })
    .catch((err) => { window.__openResult = `rejected: ${err && err.message ? err.message : String(err)}`; });
});
