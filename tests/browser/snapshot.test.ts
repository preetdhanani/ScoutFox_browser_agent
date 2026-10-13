import test from 'node:test';
import assert from 'node:assert/strict';
import { takeSnapshot, toPerceiveError, SnapshotError } from '../../src/background/browser/snapshot.ts';

test('toPerceiveError - maps SnapshotError directly preserving attributes', () => {
  const err = new SnapshotError('Out of scope', 'out_of_scope', true, true);
  const perceived = toPerceiveError(err, 2);

  assert.equal(perceived.message, 'Out of scope');
  assert.equal(perceived.kind, 'out_of_scope');
  assert.equal(perceived.terminal, true);
  assert.equal(perceived.fatal, true);
  assert.equal(perceived.tries, 2);
});

test('toPerceiveError - maps standard Error patterns to structured PerceiveError', () => {
  const closedErr = toPerceiveError(new Error('Target tab was closed'));
  assert.equal(closedErr.kind, 'tab_gone');
  assert.equal(closedErr.fatal, true);

  const scopeErr = toPerceiveError(new Error('outside this session scoutfox group'));
  assert.equal(scopeErr.kind, 'out_of_scope');
  assert.equal(scopeErr.fatal, true);

  const restrErr = toPerceiveError(new Error('restricted url: chrome://settings blocks all extensions'));
  assert.equal(restrErr.kind, 'restricted');
  assert.equal(restrErr.fatal, false);

  const genericErr = toPerceiveError(new Error('Unknown content script parse error'));
  assert.equal(genericErr.kind, 'unreadable');
  assert.equal(genericErr.fatal, false);
});

test('takeSnapshot - throws tab_gone on invalid or missing tabId', async () => {
  await assert.rejects(
    async () => takeSnapshot(0 as any, {}, { isTabInScope: async () => true }),
    (err: any) => err instanceof SnapshotError && err.kind === 'tab_gone' && err.fatal === true
  );
});

test('takeSnapshot - throws out_of_scope when tab is outside ScoutFox group', async () => {
  const prevChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    tabs: {
      get: (id: number, cb: (tab: any) => void) => cb({ id, url: 'https://example.com', title: 'Example' }),
    },
    runtime: { lastError: null },
  };

  try {
    await assert.rejects(
      async () => takeSnapshot(101, {}, { isTabInScope: async () => false }),
      (err: any) => err instanceof SnapshotError && err.kind === 'out_of_scope' && err.fatal === true
    );
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

test('takeSnapshot - throws restricted when tab is on a restricted URL', async () => {
  const prevChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    tabs: {
      get: (id: number, cb: (tab: any) => void) => cb({ id, url: 'chrome://extensions', title: 'Extensions' }),
    },
    runtime: { lastError: null },
  };

  try {
    await assert.rejects(
      async () => takeSnapshot(101, {}, { isTabInScope: async () => true }),
      (err: any) => err instanceof SnapshotError && err.kind === 'restricted' && err.fatal === false
    );
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

test('takeSnapshot - captures snapshot successfully on first attempt', async () => {
  const prevChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    tabs: {
      get: (id: number, cb: (tab: any) => void) => cb({ id, url: 'https://example.com', title: 'Example' }),
      sendMessage: (id: number, msg: any, cb: (resp: any) => void) => {
        cb({
          success: true,
          data: { url: 'https://example.com', title: 'Example', elementsText: '[1] button "Search"' },
          docId: 'doc-42',
        });
      },
    },
    runtime: { lastError: null },
  };

  try {
    const snap = await takeSnapshot(101, { showBadges: true }, { isTabInScope: async () => true });
    assert.equal(snap.docId, 'doc-42');
    assert.equal(snap.url, 'https://example.com');
    assert.equal(snap.elementsText, '[1] button "Search"');
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

test('takeSnapshot - performs injection fallback when primary attempt fails', async () => {
  const prevChrome = (globalThis as any).chrome;
  let attempts = 0;
  const injectedFiles: string[][] = [];

  (globalThis as any).chrome = {
    tabs: {
      get: (id: number, cb: (tab: any) => void) => cb({ id, url: 'https://example.com', title: 'Example' }),
      sendMessage: (id: number, msg: any, cb: (resp: any) => void) => {
        attempts++;
        if (attempts === 1) {
          cb(null); // Triggers primary error
        } else {
          cb({
            success: true,
            data: { url: 'https://example.com', title: 'Example (Injected)', elementsText: '[2] a "Home"' },
            docId: 'doc-99',
          });
        }
      },
    },
    scripting: {
      executeScript: (opts: any) => {
        injectedFiles.push(opts.files);
        return Promise.resolve([{ result: true }]);
      },
    },
    runtime: { lastError: null },
  };

  try {
    const snap = await takeSnapshot(101, {}, { isTabInScope: async () => true, sleep: async () => {} });
    assert.equal(attempts, 2);
    assert.equal(injectedFiles.length, 3); // isolated files, then net-recorder, then the per-frame relay (BUG-45)
    assert.deepEqual(injectedFiles[2], ['content/netRelay.js'], 'the third injection is the all-frames relay');
    assert.equal(snap.docId, 'doc-99');
    assert.equal(snap.title, 'Example (Injected)');
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});
