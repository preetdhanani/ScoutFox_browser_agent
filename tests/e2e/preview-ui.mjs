/**
 * Temporary UI preview: the side panel document at Chrome's side-panel width, idle, so the
 * header and composer can be looked at without running a task. Not part of the suite.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const extensionPath = path.resolve('dist');
const profile = fs.mkdtempSync('/tmp/scoutfox-preview-');
const out = path.resolve('tests/e2e/screenshots/ui-preview');
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: false,
  userDataDir: profile,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check'
  ],
  defaultViewport: { width: 360, height: 820, deviceScaleFactor: 2 }
});

try {
  const target = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 15000 }
  );
  const extensionId = new URL(target.url()).host;

  async function shot(name, scheme, width = 360) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 820, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    // Point the panel's active-tab query at this page, so it behaves like a panel attached to
    // a real tab instead of one attached to itself.
    await page.evaluateOnNewDocument(() => {
      const original = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (queryInfo, cb) => {
        if (queryInfo && queryInfo.active && queryInfo.currentWindow && typeof cb === 'function') {
          return original({}, (tabs) => cb((tabs || []).filter((t) => t.url && !t.url.startsWith('chrome-extension://'))));
        }
        return original(queryInfo, cb);
      };
    });
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });

    if (scheme === 'light') {
      await page.click('#btnApprovalMode');
      await new Promise((r) => setTimeout(r, 250));
      await page.screenshot({ path: path.join(out, `${name}-approval-menu.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await page.click('#btnEffort');
      await new Promise((r) => setTimeout(r, 250));
      await page.screenshot({ path: path.join(out, `${name}-effort-menu.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await page.click('#btnToggleHistory');
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.join(out, `${name}-history.png`), fullPage: true });
      const closeBtn = await page.$('#btnCloseHistory');
      if (closeBtn) { await closeBtn.click(); await new Promise((r) => setTimeout(r, 250)); }
      await page.click('#composerModel');
      await new Promise((r) => setTimeout(r, 600));
      await page.screenshot({ path: path.join(out, `${name}-model-menu.png`), fullPage: true });
    }
    await page.close();
    // The Settings tab, where the new controls live: a control nobody has looked at is a control
    // that ships with a wrong label or an empty select.
    const settingsPage = await browser.newPage();
    await settingsPage.setViewport({ width, height: 820, deviceScaleFactor: 2 });
    await settingsPage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await settingsPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 800));
    await settingsPage.click('.nav-btn[data-tab="settings"]').catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    await settingsPage.evaluate(() => {
      const select = document.getElementById('screenshotsSelect');
      if (!select) return;
      select.scrollIntoView({ block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 250));
    await settingsPage.screenshot({ path: path.join(out, `${name}-settings-screenshots.png`) });
    const chosen = await settingsPage.$eval('#screenshotsSelect', (el) => el.value || '(empty)').catch(() => '(missing)');
    console.log(`screenshots select value: ${chosen} (${scheme})`);
    await settingsPage.close();
  }

  await shot('idle-light', 'light');
  await shot('idle-dark', 'dark');
  await shot('idle-narrow', 'light', 320);
  console.log(`preview written to ${out}`);
} finally {
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
