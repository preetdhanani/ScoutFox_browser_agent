/**
 * Screenshots are always on: every page load gets a picture taken for clarity. There is no
 * user toggle for it, and the Settings tab no longer renders a screenshots control.
 *
 * The code holds to this: `Storage` reads `screenshots` as a boolean (true = on), the model
 * loop takes one picture at the start of every task, and `take_screenshot` is always offered
 * to the model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { screenshotsAlwaysOn } from '../../src/shared/storage.ts';

const HTML = fs.readFileSync(new URL('../../sidepanel/sidepanel.html', import.meta.url), 'utf8');
const PANEL_JS = fs.readFileSync(new URL('../../sidepanel/sidepanel.js', import.meta.url), 'utf8');

test('screenshotsAlwaysOn is true: there is no off/auto/vision toggle any more', () => {
  assert.equal(screenshotsAlwaysOn, true);
});

test('the Settings tab has no screenshots select control', () => {
  assert.equal(/<select id="screenshotsSelect"/.test(HTML), false, 'the screenshots select is gone from Settings');
});

test('the panel never reads the screenshotsSelect control', () => {
  assert.equal(/screenshotsSelect\.value/.test(PANEL_JS), false, 'no code writes to screenshotsSelect');
  assert.equal(/screenshotsSelect\?\.value/.test(PANEL_JS), false, 'no save path reads screenshotsSelect');
});

test('autoSaveCurrentForm hardcodes screenshots to true', () => {
  assert.match(PANEL_JS, /screenshots:\s*true,/, 'auto-save writes screenshots: true');
});
