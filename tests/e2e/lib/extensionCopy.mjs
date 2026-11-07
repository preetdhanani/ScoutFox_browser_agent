/**
 * The extension folder the smoke run loads: a temp COPY of dist/ plus one extra file, driver.html.
 *
 * dist/ itself is never loaded and never touched. The copy has exactly the files the shipped zip
 * has (scripts/zip.mjs leaves out sourcemaps and OS junk, so this does too), and driver.html is
 * the only addition. Loading the copy means the browser sees what a user installs, and the test
 * page lives beside it without ever entering dist/ or the zip.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The same rule as scripts/zip.mjs: sourcemaps and OS junk are not shipped.
const NOT_SHIPPED = /(?:\.map|(?:^|\/)\.DS_Store|(?:^|\/)Thumbs\.db)$/;

const POSIX = (p) => p.split(path.sep).join('/');

/**
 * The files manifest.json points to that are not in `dir`. Chromium refuses to load an extension
 * with such a file and says little about it, so the smoke run names them when the worker never
 * starts.
 */
export function missingManifestFiles(dir) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (err) {
    return [`manifest.json (${err.message})`];
  }
  const icon = manifest.action && manifest.action.default_icon;
  const refs = [
    manifest.background && manifest.background.service_worker,
    manifest.side_panel && manifest.side_panel.default_path,
    manifest.action && manifest.action.default_popup,
    ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    ...Object.values(manifest.icons || {}),
    ...(typeof icon === 'string' ? [icon] : Object.values(icon || {}))
  ];
  return [...new Set(refs.filter((r) => typeof r === 'string' && r))]
    .filter((rel) => !fs.existsSync(path.join(dir, rel.replace(/^\/+/, ''))));
}

/**
 * @param {{distDir: string, driverHtml: string, panelTriggerHtml?: string, panelTriggerJs?: string}} options
 * @returns {{dir: string, files: string[], remove: () => void}}
 */
export function prepareExtensionCopy({ distDir, driverHtml, panelTriggerHtml, panelTriggerJs }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tarka-e2e-ext-')));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.cpSync(distDir, dir, {
      recursive: true,
      filter: (source) => !NOT_SHIPPED.test(POSIX(path.relative(distDir, source)))
    });
    fs.copyFileSync(driverHtml, path.join(dir, 'driver.html'));
    // The panel trigger needs both files or neither: a page whose script 404s would report
    // 'pending' forever and the harness would blame the panel for its own missing helper.
    if (Boolean(panelTriggerHtml) !== Boolean(panelTriggerJs)) throw new Error('panel trigger: pass both panelTriggerHtml and panelTriggerJs');
    if (panelTriggerHtml) {
      fs.copyFileSync(panelTriggerHtml, path.join(dir, 'panel-trigger.html'));
      fs.copyFileSync(panelTriggerJs, path.join(dir, 'panel-trigger.js'));
    }
  } catch (err) {
    remove();
    throw err;
  }
  const files = [];
  const walk = (folder, prefix = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(dir);
  return { dir, files: files.sort(), remove };
}
