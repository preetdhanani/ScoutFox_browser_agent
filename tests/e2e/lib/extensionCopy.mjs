/**
 * The extension folder the smoke run loads: a temp COPY of dist/ plus one extra file, driver.html.
 *
 * dist/ itself is never loaded and never touched. The copy has exactly the files the shipped zip
 * has (scripts/zip.mjs leaves out sourcemaps and OS junk, so this does too), and driver.html is
 * the only addition. Loading the copy means the browser sees what a user installs, and the test
 * page lives beside it without ever entering dist/ or the zip.
 *
 * `tamper` is for proving that the smoke run can fail. It changes the COPY only, after it was
 * made (see the negative controls in README.md). It never touches dist/ or a source file, and
 * every write is checked to stay inside the copy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The same rule as scripts/zip.mjs: sourcemaps and OS junk are not shipped.
const NOT_SHIPPED = /(?:\.map|(?:^|\/)\.DS_Store|(?:^|\/)Thumbs\.db)$/;

const POSIX = (p) => p.split(path.sep).join('/');

/** Every change `--tamper=<name>` can make, and what the smoke run must then report. */
export const TAMPERS = {
  'no-content-script': {
    does: 'deletes content/content.js, which the manifest lists (Chromium refuses to load the extension)',
    apply: (dir) => fs.rmSync(inside(dir, 'content/content.js'))
  },
  'worker-error': {
    does: 'adds console.error("boom") at the top of background/sw.js (worker errors must fail the run)',
    apply: (dir) => prepend(inside(dir, 'background/sw.js'), 'console.error(\'boom (tamper=worker-error)\');\n')
  },
  'broken-panel': {
    does: 'makes the side panel script throw when it loads (the panel gate must fail)',
    apply: (dir) => {
      const html = fs.readFileSync(inside(dir, 'sidepanel/sidepanel.html'), 'utf8');
      const src = /<script\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
      if (!src) throw new Error('tamper=broken-panel: sidepanel.html has no <script src>');
      prepend(inside(dir, src.replace(/^\/+/, '')), 'throw new Error(\'panel boom (tamper=broken-panel)\');\n');
    }
  },
  'empty-page-text': {
    does: 'makes the content script report no page text (the model then cannot read the page and must answer wrong)',
    apply: (dir) => {
      const file = inside(dir, 'content/domCompressor.js');
      // appendFileSync would create a missing file, and then this control would silently do nothing.
      if (!fs.existsSync(file)) throw new Error('tamper=empty-page-text: content/domCompressor.js is not in the copy (was it moved?)');
      fs.appendFileSync(file, '\n;(function () { if (window.domCompressor) window.domCompressor.extractPageText = function () { return \'\'; }; })();\n');
    }
  },
  'broken-net-recorder': {
    does: 'makes content/net-recorder.js (the MAIN-world content script) throw when it loads (the fixture page checks must fail)',
    apply: (dir) => prepend(inside(dir, 'content/net-recorder.js'), 'throw new Error(\'recorder boom (tamper=broken-net-recorder)\');\n')
  }
};

/** A path in the copy. Anything that would leave the copy is an error, so dist/ can never be hit. */
function inside(dir, rel) {
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) throw new Error(`tamper: ${file} is outside the extension copy`);
  return file;
}

function prepend(file, text) {
  fs.writeFileSync(file, text + fs.readFileSync(file, 'utf8'));
}

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
 * @param {{distDir: string, driverHtml: string, tamper?: string}} options
 * @returns {{dir: string, files: string[], remove: () => void}}
 */
export function prepareExtensionCopy({ distDir, driverHtml, tamper }) {
  if (tamper && !TAMPERS[tamper]) {
    throw new Error(`Unknown --tamper "${tamper}". Known: ${Object.keys(TAMPERS).join(', ')}`);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scoutfox-e2e-ext-')));
  const remove = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.cpSync(distDir, dir, {
      recursive: true,
      filter: (source) => !NOT_SHIPPED.test(POSIX(path.relative(distDir, source)))
    });
    fs.copyFileSync(driverHtml, path.join(dir, 'driver.html'));
    if (tamper) TAMPERS[tamper].apply(dir);
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
