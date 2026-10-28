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
  'custom-provider-unsaved': {
    does: 'makes "Add provider" of the "Custom model API" dialog close it without saving (a run on a custom provider must fail its provider setup)',
    apply: (dir) => {
      const html = fs.readFileSync(inside(dir, 'sidepanel/sidepanel.html'), 'utf8');
      const src = /<script\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
      if (!src) throw new Error('tamper=custom-provider-unsaved: sidepanel.html has no <script src>');
      replaceOnce(inside(dir, src.replace(/^\/+/, '')), 'el("btnCpSave").addEventListener("click", submit);', 'el("btnCpSave").addEventListener("click", close);');
    }
  },
  'empty-page-text': {
    does: 'makes the content script report no page text (the model then cannot read the page and must answer wrong)',
    apply: (dir) => {
      const file = inside(dir, 'content/domCompressor.js');
      // appendFileSync would create a missing file, and then this control would silently do nothing.
      if (!fs.existsSync(file)) throw new Error('tamper=empty-page-text: content/domCompressor.js is not in the copy (was it moved?)');
      // Both readers: the snapshot's capped text and the full text read_page pages through. With only the
      // first blanked, read_page still found the price and this control passed (it went blind).
      fs.appendFileSync(file, '\n;(function () { if (window.domCompressor) { window.domCompressor.extractPageText = function () { return \'\'; }; window.domCompressor.extractFullPageText = function () { return \'\'; }; } })();\n');
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
  'idle-after-restore': {
    does: 'makes a restarted worker reset the restored run to "idle" whenever the runner meta exists (the old bug): an interrupted run must end "stopped", so worker-restart-midrun must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'),
      'if (saved) this.restoreGroupMap(saved.scoutFoxGroupIds || []);',
      'if (saved) { this.restoreGroupMap(saved.scoutFoxGroupIds || []); this.status = "idle"; }')
  },
  'clear-keeps-loop': {
    does: 'makes New chat clear the thread without ending the run (the old bug): the loop goes on into the cleared thread, so clear-midrun must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'this.endRun("idle", null);', ';')
  },
  'no-press-key': {
    does: 'takes press_key out of the tool list the model is offered (the old tool set): editor-replace cannot select all or press Shift+Enter, so it must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'),
      'TOOL_NAMES = SCOUTFOX_TOOLS.map((t) => t.name);',
      '(() => { const i = SCOUTFOX_TOOLS.findIndex((t) => t.name === "press_key"); if (i < 0) throw new Error("tamper=no-press-key: press_key is not in the tool list"); SCOUTFOX_TOOLS.splice(i, 1); })();\n\tTOOL_NAMES = SCOUTFOX_TOOLS.map((t) => t.name);')
  },
  'type-needs-id': {
    does: 'makes type refuse without an element_id again (the old rule): typing into the focused editor fails, so editor-replace must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'),
      'const hasTarget = targetId !== void 0 && targetId !== null;',
      'if (targetId === void 0 || targetId === null) return { success: false, error: "Type action requires an element_id.", via: "synthetic" };\n\t\tconst hasTarget = true;')
  },
  'no-observation': {
    does: 'drops the observation line from every action result (the old one-line results): the model is not told what its actions did, so editor-replace must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'observationLine(exec?.effectDetail, urlAfter)', '""')
  },
  'no-repeat-guard': {
    does: 'turns the repeat guard off (no repeat hint, no reflection note, the old loop): the dead click of stuck-recovery is repeated until the model gives up, so stuck-recovery must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'),
      'const guard = this.progress.record(name, args, resultText);',
      'const guard = { hint: null, reflect: false, noProgressInWindow: 0, repeats: 0 };')
  },
  'no-research': {
    does: 'stops offering web_search and fetch_url to the model, as if Settings > Research were off: research-then-answer cannot find the fact outside the tab, so it must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'research: this.researchEnabled,', 'research: false,')
  },
  'finish-ignores-outcome': {
    does: 'drops the outcome the finish tool named from the finish row (the old card rule: Done unless a step failed): stuck-recovery\'s honest "it did not work" shows the green Done card again, so stuck-recovery must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'if (outcome) entry.outcome = outcome;', '')
  },
  'finish-says-partial': {
    does: 'stores every finish row with outcome "partial", whatever the model said: an open-web task whose answer passes its check must still fail on "expected done"',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'if (outcome) entry.outcome = outcome;', 'if (outcome) entry.outcome = "partial";')
  },
  'broken-net-recorder': {
    does: 'makes content/net-recorder.js (the MAIN-world content script) throw when it loads (the fixture page checks must fail)',
    apply: (dir) => prepend(inside(dir, 'content/net-recorder.js'), 'throw new Error(\'recorder boom (tamper=broken-net-recorder)\');\n')
  },
  'bad-tool-schema': {
    does: 'sets the read_page inputSchema.required to null in the copy - a provider answers HTTP 400 "null is not of type array" and kills the run; the extension must fail locally instead, with an error naming the tool',
    apply: (dir) => {
      const file = inside(dir, 'background/sw.js');
      const from = '\t\t\tname: "read_page",';
      const code = fs.readFileSync(file, 'utf8');
      const at = code.indexOf(from);
      if (at < 0 || code.indexOf(from, at + 1) >= 0) throw new Error('tamper=bad-tool-schema: expected exactly one read_page tool definition in background/sw.js');
      const schema = code.indexOf('inputSchema: {\n\t\t\t\ttype: "object",', at);
      if (schema < 0) throw new Error('tamper=bad-tool-schema: the read_page tool has no inputSchema');
      const insertAt = schema + 'inputSchema: {\n\t\t\t\ttype: "object",'.length;
      fs.writeFileSync(file, `${code.slice(0, insertAt)}\n\t\t\t\trequired: null,${code.slice(insertAt)}`);
    }
  },
  'scroll-lies': {
    does: 'makes scroll report the full step as moved without turning the wheel (the old always-"Scrolled" path): nothing moves, the observation measures no scroll, so notebook-fix and virtual-scroll must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'),
      'await this.wheelAndMeasure(tabId, point, delta, before, control, ask)',
      '({ after: { ...before, top: before.top + delta, atTop: false, atBottom: false } })')
  },
  'read-repeats': {
    does: 'makes read_page ignore the part it is asked for and always read part 1 (the old re-read of the same first text): notebook-fix asks for part 2 and must fail',
    apply: (dir) => replaceOnce(inside(dir, 'background/sw.js'), 'const part = readPagePart(args?.part);', 'const part = 1;')
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
