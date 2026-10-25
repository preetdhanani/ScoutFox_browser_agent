/**
 * A small fake of the side panel's DOM and chrome APIs, for tests that drive sidepanel.js
 * through its own listeners (the same idea as tests/sidepanel/form.test.js).
 *
 * Every getElementById call returns one FakeElement per id, created on first use, so the panel
 * code finds every control it looks up. Listeners are kept, so a test can dispatch a click or
 * an input event on a control and the panel's own handler runs. chrome.storage.local is a plain
 * object the test can read and seed.
 *
 * install() must run BEFORE sidepanel.js is imported: the module touches window and document
 * once at load. Not a test file itself (no .test.js), so the runner does not pick it up.
 */

export class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.title = '';
    this.placeholder = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.style = {};
    this.attributes = {};
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c);
        else classes.delete(c);
      }
    };
    this.listeners = {};
    this.children = [];
    this.options = [];
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  /** Runs every listener of the event and waits for the async ones. */
  async dispatchEvent(event) {
    const ev = typeof event === 'string' ? { type: event } : event;
    if (!ev.stopPropagation) ev.stopPropagation = () => {};
    if (!ev.preventDefault) ev.preventDefault = () => {};
    if (!ev.target) ev.target = this;
    for (const fn of this.listeners[ev.type] || []) await fn(ev);
  }

  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  setAttribute(name, val) { this.attributes[name] = String(val); }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 100, bottom: 130, left: 0, right: 200, height: 30, width: 200 }; }
  focus() {}
  remove() {}
  appendChild(child) {
    this.children.push(child);
    this.options.push(child);
    return child;
  }
}

/**
 * Installs the fakes as globals. Returns the handles a test needs: the element of an id, the
 * storage object (mutable through `storage.data`), and the messages sent to the background.
 */
export function install({ models = ['test-model-1', 'test-model-2'] } = {}) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const storage = { data: {} };
  const sent = [];

  globalThis.window = { innerHeight: 800, addEventListener() {}, confirm: () => true };
  globalThis.document = {
    readyState: 'loading',
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {},
    getElementById: (id) => getEl(id),
    querySelectorAll: () => []
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (storage.data[k] !== undefined) out[k] = structuredClone(storage.data[k]);
          }
          cb(out);
        },
        set: (data, cb) => {
          Object.assign(storage.data, structuredClone(data));
          cb?.();
        },
        remove: (keys, cb) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete storage.data[k];
          cb?.();
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      lastError: undefined,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        cb?.({ success: true, models });
      }
    }
  };

  return { getEl, storage, sent };
}

/** Lets pending promise callbacks (the storage round trips) run. */
export function settle(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
