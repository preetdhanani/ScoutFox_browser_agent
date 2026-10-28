// src/background/research/urlPolicy.ts
// The one URL rule for the addresses a model hands the extension: navigate (the user's tab) and
// fetch_url (a request from the service worker). Pure, no chrome APIs.
//
// What it checks:
//   - the value parses as a full URL (new URL), so the checks below read the parsed parts and
//     never a string prefix a crafted address could fake;
//   - the scheme is http: or https: (no file:, data:, javascript:, chrome:, blob:, ftp:);
//   - the host name is not empty;
//   - no user name or password in the address (https://user:pass@host), which would send a
//     credential the model wrote, and hide the real host from a person reading the step.
//
// The limits, on purpose (kept simple, no new declarativeNetRequest rule):
//   - it does NOT block localhost or private network addresses: the user's own apps (a local
//     JupyterLab, a dev server) live there, and the extension's host permission (<all_urls>)
//     already reaches them from the tab;
//   - fetch_url sends no cookies or credentials (credentials: 'omit'), so a fetch can only read
//     what an anonymous visitor could read;
//   - a redirect is followed by the browser and is not re-checked here; fetch_url reports the
//     final address, and the browser itself refuses a redirect to a non-http(s) scheme.

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/** Checks one address a model wrote. The error is worded for the model. */
export function checkWebUrl(raw: unknown): UrlCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, error: 'the URL is empty. Give a full address that starts with https:// or http://.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: `"${text.slice(0, 200)}" is not a full URL. Give a full address that starts with https:// or http://.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `only http and https addresses are allowed, got "${url.protocol}" in "${text.slice(0, 200)}".` };
  }
  if (!url.hostname) return { ok: false, error: `"${text.slice(0, 200)}" has no host name.` };
  if (url.username || url.password) {
    return { ok: false, error: 'an address with a user name or password in it is refused. Use the address without them.' };
  }
  return { ok: true, url };
}
