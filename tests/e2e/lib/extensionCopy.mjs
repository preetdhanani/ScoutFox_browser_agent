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
  'no-effort': {
    does: 'makes the tool loop drop the effort the run was started with (every request goes out with no reasoning field; the effort wire check must fail)',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'this.effort = normalizeEffort(effort);', 'this.effort = "auto";')
  },
  'stale-worker': {
    does: 'gives background/sw.js a different build stamp than the side panel, like a worker Chrome kept running after a rebuild (the panel must show its reload bar and the side panel gate must fail)',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'var BUILD_STAMP = "', 'var BUILD_STAMP = "older ')
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
  'zod-not-jitless': {
    does: 'removes the statement that switches zod code generation off from background/sw.js, so zod probes new Function under the CSP (the CSP violation in the worker must fail the run)',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'globalThis.__zod_globalConfig = { jitless: true };', '')
  },
  'no-history-rows': {
    does: 'makes the runner drop every history row (recordEntry pushes nothing), so the side panel timeline stays empty and the run is invisible (the harness must fail: the run never starts visibly)',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'this.history.push(entry)', ';')
  },
  'broken-net-recorder': {
    does: 'makes content/net-recorder.js (the MAIN-world content script) throw when it loads (the fixture page checks must fail)',
    apply: (dir) => prepend(inside(dir, 'content/net-recorder.js'), 'throw new Error(\'recorder boom (tamper=broken-net-recorder)\');\n')
  },
  'bad-tool-schema': {
    does: 'sets get_page_text inputSchema.required to null in the copy - a provider answers HTTP 400 "null is not of type array" and kills the run; the extension must fail locally instead, with an error naming the tool',
    apply: (dir) => {
      const file = inside(dir, 'background/sw.js');
      const from = '\t\t\tname: "get_page_text",\n\t\t\tdescription: "Read ALL visible text content from the current page. Use FIRST to understand page content.",\n\t\t\tinputSchema: {\n\t\t\t\ttype: "object",\n\t\t\t\tproperties: {},';
      replaceOnce(file, from, from + ',\n\t\t\t\t\trequired: null');
    }
  },
  'no-fox-mark': {
    does: 'takes the fox mark out of the panel header in the copy (the mark check must fail: the panel shows no fox next to the name)',
    apply: (dir) => {
      const file = inside(dir, 'sidepanel/sidepanel.html');
      const code = fs.readFileSync(file, 'utf8');
      // Only the mark in the header goes: it is the one inside .logo-icon.
      const header = /(<div class="logo-icon"[^>]*>)\s*<svg[\s\S]*?<\/svg>/;
      if (!header.test(code)) throw new Error('tamper=no-fox-mark: the panel header has no .logo-icon svg (was it moved?)');
      fs.writeFileSync(file, code.replace(header, '$1'));
    }
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

/** Replaces the one place `from` occurs. Anything else is an error, so a control never turns into a silent no-op after a rebuild changed the file. */
function replaceOnce(file, from, to) {
  const code = fs.readFileSync(file, 'utf8');
  const count = code.split(from).length - 1;
  if (count !== 1) throw new Error(`tamper: expected exactly one "${from}" in ${path.basename(file)}, found ${count}`);
  fs.writeFileSync(file, code.replace(from, () => to));
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
 * @param {{distDir: string, driverHtml: string, panelTriggerHtml?: string, panelTriggerJs?: string, tamper?: string}} options
 * @returns {{dir: string, files: string[], remove: () => void}}
 */
export function prepareExtensionCopy({ distDir, driverHtml, panelTriggerHtml, panelTriggerJs, tamper }) {
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
    // The panel trigger needs both files or neither: a page whose script 404s would report
    // 'pending' forever and the harness would blame the panel for its own missing helper.
    if (Boolean(panelTriggerHtml) !== Boolean(panelTriggerJs)) throw new Error('panel trigger: pass both panelTriggerHtml and panelTriggerJs');
    if (panelTriggerHtml) {
      fs.copyFileSync(panelTriggerHtml, path.join(dir, 'panel-trigger.html'));
      fs.copyFileSync(panelTriggerJs, path.join(dir, 'panel-trigger.js'));
    }
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
