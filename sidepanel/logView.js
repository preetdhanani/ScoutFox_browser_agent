/**
 * The Logs tab: one entry per model call, agent step and task event, each with its details as an
 * expandable JSON tree, like a JSON viewer.
 *
 * Pure functions that return HTML strings, so they can be tested without a browser. Every key and
 * value comes from the model or the page and is escaped; nothing here builds markup from raw text.
 * Expansion is driven by the panel (sidepanel.js) through data attributes on the toggles, and the
 * open/closed state lives in a Map keyed by "<entry id>|<path>", so a re-render keeps it.
 */

/** The labels of the kinds, as the reader sees them. */
export const LOG_KIND_LABELS = { agent: 'Task', tool: 'Step', llm: 'Model', system: 'System' };

/** The filter chips of the Logs tab: what each one shows. */
export const LOG_FILTERS = {
  // The run: task, steps and model calls, plus any warning or error. Plumbing is out.
  all: (log) => log.level !== 'DEBUG' && (kindOf(log) !== 'system' || log.level === 'WARN' || log.level === 'ERROR'),
  agent: (log) => kindOf(log) === 'agent' || kindOf(log) === 'tool',
  llm: (log) => kindOf(log) === 'llm',
  system: (log) => kindOf(log) === 'system'
};

/** Strings longer than this show their start and a button for the rest. */
export const JSON_STRING_PREVIEW = 300;

/** The kind of an entry; entries from before kinds existed are system lines. */
export function kindOf(log) {
  return log && LOG_KIND_LABELS[log.kind] ? log.kind : 'system';
}

/** Whether an entry belongs in the view of a filter. An unknown filter shows everything. */
export function logMatchesFilter(log, filter) {
  const test = LOG_FILTERS[filter];
  return test ? test(log) : true;
}

export function escapeLogHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The details of an entry: parsed JSON when they are JSON, else the text, else null. */
export function parseLogData(data) {
  if (data === null || data === undefined || data === '') return null;
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(String(data));
  } catch {
    return String(data);
  }
}

/** The key under which the open state of one node is kept. */
export function treeStateKey(entryId, path) {
  return `${entryId}|${path}`;
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

function sizeLabel(value) {
  return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
}

function leafHtml(value, path) {
  if (value === null) return '<span class="jt-null">null</span>';
  if (typeof value === 'number') return `<span class="jt-num">${escapeLogHtml(value)}</span>`;
  if (typeof value === 'boolean') return `<span class="jt-bool">${value}</span>`;
  const text = String(value);
  if (text.length <= JSON_STRING_PREVIEW) return `<span class="jt-str">"${escapeLogHtml(text)}"</span>`;
  return `<span class="jt-str jt-str-short">"${escapeLogHtml(text.slice(0, JSON_STRING_PREVIEW))}…"</span>`
    + `<span class="jt-str jt-str-full" hidden>"${escapeLogHtml(text)}"</span>`
    + `<button type="button" class="jt-more" data-path="${escapeLogHtml(path)}" data-label="show all ${text.length.toLocaleString('en-US')} characters" aria-expanded="false">show all ${text.length.toLocaleString('en-US')} characters</button>`;
}

function keyHtml(key, inArray) {
  return inArray
    ? `<span class="jt-index">${escapeLogHtml(key)}</span><span class="jt-colon">:</span> `
    : `<span class="jt-key">"${escapeLogHtml(key)}"</span><span class="jt-colon">:</span> `;
}

/**
 * One value of the tree. Objects and arrays are a toggle button (caret, key, size) and their
 * children; the root level is open by default, deeper levels closed, unless the state says otherwise.
 */
function nodeHtml(value, { key, inArray, path, depth, entryId, state }) {
  const label = key === undefined ? '' : keyHtml(key, inArray);
  if (!isContainer(value)) return `<div class="jt-leaf">${label}${leafHtml(value, path)}</div>`;
  const entries = Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value);
  if (entries.length === 0) {
    return `<div class="jt-leaf">${label}<span class="jt-brace">${Array.isArray(value) ? '[]' : '{}'}</span></div>`;
  }
  const remembered = state ? state.get(treeStateKey(entryId, path)) : undefined;
  const open = remembered === undefined ? depth === 0 : remembered;
  const children = entries.map(([childKey, child]) => nodeHtml(child, {
    key: childKey,
    inArray: Array.isArray(value),
    path: Array.isArray(value) ? `${path}[${childKey}]` : `${path}.${childKey}`,
    depth: depth + 1,
    entryId,
    state
  })).join('');
  return `<div class="jt-node">`
    + `<button type="button" class="jt-toggle" data-path="${escapeLogHtml(path)}" aria-expanded="${open}">`
    + `<span class="jt-caret" aria-hidden="true"></span>${label}<span class="jt-brace">${sizeLabel(value)}</span></button>`
    + `<div class="jt-children"${open ? '' : ' hidden'}>${children}</div></div>`;
}

/** The whole tree of one entry's details. */
export function renderJsonTree(value, { entryId = '', state = null } = {}) {
  return `<div class="jt" data-entry="${escapeLogHtml(entryId)}">${nodeHtml(value, { path: '$', depth: 0, entryId, state })}</div>`;
}

/** One entry of the Logs tab: time, kind, level, module, the sentence, and the details. */
export function logEntryHtml(log, { state = null } = {}) {
  const kind = kindOf(log);
  const level = ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(log.level) ? log.level : 'INFO';
  const id = String(log.id || `${log.timestamp || ''}-${(log.message || '').slice(0, 24)}`);
  const details = parseLogData(log.data);
  let body = '';
  if (details !== null && isContainer(details)) {
    body = renderJsonTree(details, { entryId: id, state });
  } else if (details !== null) {
    body = `<pre class="log-payload">${escapeLogHtml(details)}</pre>`;
  }
  return `<div class="log-entry log-kind-${kind} log-entry-${level}" data-id="${escapeLogHtml(id)}">`
    + `<div class="log-meta">`
    + `<span class="log-time">${escapeLogHtml(log.timestamp || '')}</span>`
    + `<span class="log-kind log-kind-badge-${kind}">${LOG_KIND_LABELS[kind]}</span>`
    + `${level === 'INFO' ? '' : `<span class="log-level-${level}">${level}</span>`}`
    // A run entry's kind says where it is from; only a system line needs its module.
    + `${kind === 'system' ? `<span class="log-module">${escapeLogHtml(log.module || 'System')}</span>` : ''}`
    + `${isContainer(details) ? `<button type="button" class="log-copy" data-id="${escapeLogHtml(id)}" title="Copy the details as JSON">Copy JSON</button>` : ''}`
    + `</div>`
    + `<div class="log-msg">${escapeLogHtml(log.message || '')}</div>`
    + body
    + `</div>`;
}
