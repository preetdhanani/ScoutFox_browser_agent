/**
 * Tests for tests/helpers/fakeStorageSession.ts, the shared fake of chrome.storage.session and
 * chrome.storage.local. The later graph and checkpointer tests lean on it (quota errors, byte
 * counts, a worker restart over the same store), so its own behaviour is pinned down here first.
 *
 * Expected byte counts are worked out by hand in the comments (bytes = UTF-8 bytes of the JSON
 * text of the value + UTF-8 bytes of the key), not computed by the helper.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEvent, FakeStorage, Host, createFakeStorage, storageBytes } from './helpers/fakeStorageSession.ts';

const SESSION_QUOTA_MESSAGE = 'Session storage quota bytes exceeded. Values were not stored.';
const LOCAL_QUOTA_MESSAGE = 'QUOTA_BYTES quota exceeded';
const TEN_MB = 10 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Byte counting
// ---------------------------------------------------------------------------------------------

test('bytes: an item counts the UTF-8 bytes of its JSON value plus its key', async () => {
  const store = createFakeStorage();
  const { session } = store.connect();
  await session.set({ a: { n: 1 } }); // 'a' = 1 byte, '{"n":1}' = 7 bytes
  assert.equal(await session.getBytesInUse(), 8);
  assert.equal(await session.getBytesInUse('a'), 8);
  assert.equal(await session.getBytesInUse(['a', 'missing']), 8);
  assert.equal(await session.getBytesInUse('missing'), 0);
  assert.equal(await session.getBytesInUse(null), 8);
  assert.equal(store.session.bytesInUse(), 8);
  assert.equal(storageBytes('a', { n: 1 }), 8);
});

test('bytes: a key that is asked for twice is counted once', async () => {
  const store = createFakeStorage();
  const { session } = store.connect();
  await session.set({ a: { n: 1 }, b: 'xy' }); // 'a' 8 bytes, 'b' + '"xy"' = 5 bytes
  assert.equal(store.session.bytesInUse(['a', 'a']), 8);
  assert.equal(store.session.bytesInUse(['a', 'b', 'a', 'missing', 'b']), 13);
  assert.equal(await session.getBytesInUse(['a', 'a']), 8);
  assert.equal(await session.getBytesInUse(['b', 'a', 'b']), 13);
});

test('bytes: more hand-counted values', async () => {
  const store = createFakeStorage();
  const { local } = store.connect();
  await local.set({ key: 'value' }); // 'key' 3 + '"value"' 7 = 10
  await local.set({ n: 12345 }); //  'n' 1 + '12345' 5 = 6
  await local.set({ z: null }); //  'z' 1 + 'null' 4 = 5
  await local.set({ list: [1, 2, 3] }); // 'list' 4 + '[1,2,3]' 7 = 11
  assert.deepEqual(store.local.usage(), { key: 10, list: 11, n: 6, z: 5 });
  assert.equal(store.local.bytesInUse(), 32);
  assert.equal(await local.getBytesInUse(['key', 'n']), 16);
});

test('bytes: multi-byte characters are counted in UTF-8, not in string length', async () => {
  const store = createFakeStorage();
  const { session } = store.connect();
  await session.set({ 'é': 'ü' }); // key 'é' = 2 bytes, '"ü"' = 1 + 2 + 1 = 4 bytes
  assert.equal(store.session.bytesInUse(), 6);
  await session.set({ k: '😀' }); // 'k' = 1, '"😀"' = 1 + 4 + 1 = 6
  assert.equal(store.session.bytesInUse('k'), 7);
  assert.equal(store.session.bytesInUse(), 13);
});

test('bytes: replacing a value counts only the new value, and remove and clear give the bytes back', async () => {
  const store = createFakeStorage();
  const { session } = store.connect();
  await session.set({ a: 'xxxxxxxxxx' }); // 1 + 12 = 13
  assert.equal(store.session.bytesInUse(), 13);
  await session.set({ a: 'y' }); // 1 + 3 = 4
  assert.equal(store.session.bytesInUse(), 4);
  await session.set({ b: 'z' }); // + 4
  assert.equal(store.session.bytesInUse(), 8);
  await session.remove('a');
  assert.equal(store.session.bytesInUse(), 4);
  await session.clear();
  assert.equal(store.session.bytesInUse(), 0);
});

test('bytes: usage() shows the bytes per key, and the store reports both areas', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  await conn.session.set({ big: 'x'.repeat(100), small: 1 }); // 3 + 102 = 105, 5 + 1 = 6
  await conn.local.set({ l: true }); // 1 + 4 = 5
  assert.deepEqual(store.session.usage(), { big: 105, small: 6 });
  assert.deepEqual(store.bytesInUse(), { session: 111, local: 5 });
});

// ---------------------------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------------------------

test('quota: both areas default to 10 MB and QUOTA_BYTES says so', () => {
  const { local, session } = createFakeStorage().connect();
  assert.equal(session.QUOTA_BYTES, 10485760);
  assert.equal(local.QUOTA_BYTES, 10485760);
});

test('quota: a set over the limit rejects with the session message and writes nothing', async () => {
  const store = createFakeStorage({ session: { quotaBytes: 20 } });
  const { session } = store.connect();
  await session.set({ a: 'x'.repeat(10) }); // 1 + 12 = 13 bytes, fits
  await assert.rejects(session.set({ b: 'y'.repeat(10) }), { message: SESSION_QUOTA_MESSAGE }); // 13 + 13 = 26 > 20
  assert.deepEqual(store.session.keys(), ['a']);
  assert.equal(store.session.bytesInUse(), 13);
});

test('quota: the local area rejects with its own message', async () => {
  const store = createFakeStorage({ local: { quotaBytes: 20 } });
  const { local } = store.connect();
  await assert.rejects(local.set({ a: 'x'.repeat(30) }), { message: LOCAL_QUOTA_MESSAGE });
  assert.deepEqual(store.local.keys(), []);
});

test('quota: a failed set is atomic - even the keys that would have fit are not written, and old values stay', async () => {
  const store = createFakeStorage({ session: { quotaBytes: 30 } });
  const { session } = store.connect();
  await session.set({ a: 'x'.repeat(10) }); // 13 bytes
  // The write would replace a (13 -> 1 + 5 = 6 bytes) and add c (1 + 42 = 43 bytes): 6 + 43 = 49 > 30.
  await assert.rejects(session.set({ a: 'zzz', c: 'w'.repeat(40) }), { message: SESSION_QUOTA_MESSAGE });
  assert.deepEqual(await session.get(null), { a: 'x'.repeat(10) });
  assert.equal(store.session.bytesInUse(), 13);
});

test('quota: exactly at the limit is allowed, one byte more is not', async () => {
  const store = createFakeStorage({ session: { quotaBytes: 13 } });
  const { session } = store.connect();
  await session.set({ a: 'x'.repeat(10) }); // 1 + 12 = 13 == quota
  assert.equal(store.session.bytesInUse(), 13);
  await assert.rejects(session.set({ a: 'x'.repeat(11) }), { message: SESSION_QUOTA_MESSAGE }); // 14 > 13
  assert.equal(store.session.bytesInUse(), 13);
  assert.deepEqual(await session.get('a'), { a: 'x'.repeat(10) });
});

test('quota: replacing a value is judged on the change, so a smaller value always fits', async () => {
  const store = createFakeStorage({ session: { quotaBytes: 100 } });
  const { session } = store.connect();
  await session.set({ a: 'x'.repeat(78) }); // 1 + 80 = 81
  await session.set({ a: 'x'.repeat(58) }); // 1 + 60 = 61: 81 + 61 would be over 100, replacing is not
  assert.equal(store.session.bytesInUse(), 61);
});

test('quota: a big value against the real 10 MB limit rejects, in both areas', async () => {
  const store = createFakeStorage();
  const { local, session } = store.connect();
  const big = 'x'.repeat(TEN_MB);
  await assert.rejects(session.set({ big }), { message: SESSION_QUOTA_MESSAGE });
  await assert.rejects(local.set({ big }), { message: LOCAL_QUOTA_MESSAGE });
  assert.equal(store.session.bytesInUse(), 0);
  assert.equal(store.local.bytesInUse(), 0);
});

test('quota: at the real 10 MB, the last byte fits and the next one does not', async () => {
  const store = createFakeStorage();
  const { session } = store.connect();
  await session.set({ k: 'x'.repeat(TEN_MB - 3) }); // 'k' 1 + (TEN_MB - 3 + 2 quotes) = exactly 10485760
  assert.equal(store.session.bytesInUse(), TEN_MB);
  await assert.rejects(session.set({ q: '' }), { message: SESSION_QUOTA_MESSAGE }); // + 1 + 2 bytes
  await assert.rejects(session.set({ k: 'x'.repeat(TEN_MB - 2) }), { message: SESSION_QUOTA_MESSAGE }); // one byte too many
  assert.equal(store.session.bytesInUse(), TEN_MB);
});

test('quota: it can be set small per area and changed later, and QUOTA_BYTES follows', async () => {
  const store = createFakeStorage({ session: { quotaBytes: 50 }, local: { quotaBytes: 60 } });
  const { local, session } = store.connect();
  assert.equal(session.QUOTA_BYTES, 50);
  assert.equal(local.QUOTA_BYTES, 60);
  store.session.quotaBytes = 5;
  assert.equal(session.QUOTA_BYTES, 5);
  await assert.rejects(session.set({ a: 'hello' }), { message: SESSION_QUOTA_MESSAGE }); // 1 + 7 = 8 > 5
});

test('quota: the callback style reports it through lastError and the callback gets no items', async () => {
  const store = createFakeStorage({ session: { quotaBytes: 10 } });
  const conn = store.connect();
  const seen = [];
  const returned = conn.session.set({ big: 'x'.repeat(50) }, (...args) => seen.push({ args, message: conn.lastError?.message }));
  assert.equal(returned, undefined, 'the callback style returns nothing, like Chrome');
  assert.deepEqual(seen, [], 'the callback never runs synchronously');
  await conn.host.settle();
  assert.deepEqual(seen, [{ args: [], message: SESSION_QUOTA_MESSAGE }]);
  assert.equal(store.session.bytesInUse(), 0);
});

test('json: a value JSON cannot serialize (circular, BigInt) rejects, and nothing is written', async () => {
  const store = createFakeStorage();
  const { session } = store.connect();
  const circular = {};
  circular.self = circular;
  await assert.rejects(session.set({ ok: 1, circular }), /circular/i);
  await assert.rejects(session.set({ ok: 1, big: 10n }), /BigInt/);
  assert.deepEqual(store.session.keys(), []);
});

// ---------------------------------------------------------------------------------------------
// JSON round trip
// ---------------------------------------------------------------------------------------------

test('json: values that JSON changes come back changed', async () => {
  const { session } = createFakeStorage().connect();
  await session.set({
    date: new Date('2026-09-29T10:00:00.000Z'),
    map: new Map([['a', 1]]),
    set: new Set([1, 2]),
    bytes: new Uint8Array([1, 2, 3]),
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    nested: { keep: 1, drop: undefined, fn: () => 1 },
    list: [1, undefined, () => 2],
    cls: new (class Thing {
      constructor() {
        this.x = 1;
      }
    })(),
  });
  assert.deepEqual(await session.get(null), {
    date: '2026-09-29T10:00:00.000Z',
    map: {},
    set: {},
    bytes: { 0: 1, 1: 2, 2: 3 },
    nan: null,
    inf: null,
    nested: { keep: 1 },
    list: [1, null, null],
    cls: { x: 1 },
  });
});

test('json: a key whose value is undefined is not stored, and does not overwrite the old value', async () => {
  const store = createFakeStorage();
  const { session } = store.connect();
  await session.set({ a: 1 });
  await session.set({ a: undefined, b: undefined });
  assert.deepEqual(await session.get(null), { a: 1 });
  assert.deepEqual(store.session.keys(), ['a']);
});

test('json: what get() returns is a copy, and so is what set() stored', async () => {
  const { session } = createFakeStorage().connect();
  const input = { deep: { n: 1 } };
  await session.set({ item: input });
  input.deep.n = 999; // the caller changes its object later
  const first = await session.get('item');
  assert.equal(first.item.deep.n, 1);
  first.item.deep.n = 42; // the caller changes what it got
  assert.equal((await session.get('item')).item.deep.n, 1);
});

// ---------------------------------------------------------------------------------------------
// get / set / remove / clear / getKeys
// ---------------------------------------------------------------------------------------------

test('get: undefined and null return everything, a string or an array return only what exists', async () => {
  const { session } = createFakeStorage().connect();
  await session.set({ a: 1, b: 2, c: 3 });
  assert.deepEqual(await session.get(), { a: 1, b: 2, c: 3 });
  assert.deepEqual(await session.get(null), { a: 1, b: 2, c: 3 });
  assert.deepEqual(await session.get('b'), { b: 2 });
  assert.deepEqual(await session.get(['a', 'c', 'nope']), { a: 1, c: 3 });
  assert.deepEqual(await session.get('nope'), {}, 'a missing key is absent, not undefined');
  assert.deepEqual(await session.get([]), {});
});

test('get: an object gives defaults for the keys that are missing, and only for those', async () => {
  const { session } = createFakeStorage().connect();
  await session.set({ present: 'stored', zero: 0 });
  assert.deepEqual(await session.get({ present: 'default', zero: 5, missing: { d: 1 }, other: [] }), {
    present: 'stored',
    zero: 0,
    missing: { d: 1 },
    other: [],
  });
  assert.deepEqual(await session.get({}), {});
});

test('get: the defaults object is never handed back, and never changed: the answer holds copies', async () => {
  const { session } = createFakeStorage().connect();
  await session.set({ present: 'stored' });
  const defaults = { present: 'default', list: [1], nested: { n: 1 } };
  const expectedDefaults = { present: 'default', list: [1], nested: { n: 1 } }; // written out, not copied from `defaults`
  const got = await session.get(defaults);
  assert.deepEqual(got, { present: 'stored', list: [1], nested: { n: 1 } });
  assert.notEqual(got, defaults, 'not the same object');
  assert.deepEqual(defaults, expectedDefaults, 'a stored value did not overwrite the caller\'s default');
  assert.notEqual(got.list, defaults.list, 'a default array is a copy');
  assert.notEqual(got.nested, defaults.nested, 'a default object is a copy');
  got.list.push(2);
  got.nested.n = 9;
  assert.deepEqual(defaults, expectedDefaults, 'changing the answer does not change the caller\'s defaults');
  assert.deepEqual(await session.get(defaults), { present: 'stored', list: [1], nested: { n: 1 } }, 'and the next answer is fresh');
});

test('get: with only a callback it returns everything', async () => {
  const conn = createFakeStorage().connect();
  await conn.local.set({ a: 1 });
  let got;
  const returned = conn.local.get((items) => {
    got = items;
  });
  assert.equal(returned, undefined);
  await conn.host.settle();
  assert.deepEqual(got, { a: 1 });
});

test('the calls throw a TypeError for arguments Chrome would refuse, before anything happens', () => {
  const { session } = createFakeStorage().connect();
  assert.throws(() => session.get(5), TypeError);
  assert.throws(() => session.get(['a', 5]), TypeError);
  assert.throws(() => session.set([1, 2]), TypeError);
  assert.throws(() => session.set(null), TypeError);
  assert.throws(() => session.set('a'), TypeError);
  assert.throws(() => session.remove({}), TypeError);
  assert.throws(() => session.getBytesInUse(3), TypeError);
  assert.throws(() => session.setAccessLevel({ accessLevel: 'EVERYONE' }), TypeError);
});

test('remove and clear: missing keys are ignored, and both call styles work', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  await conn.local.set({ a: 1, b: 2, c: 3 });
  await conn.local.remove('a');
  await conn.local.remove(['b', 'not there']);
  assert.deepEqual(await conn.local.get(null), { c: 3 });
  await new Promise((resolve) => conn.local.clear(resolve));
  assert.deepEqual(store.local.keys(), []);
});

test('getKeys: all keys, sorted, in both call styles', async () => {
  const conn = createFakeStorage().connect();
  await conn.session.set({ zed: 1, alpha: 2, 'sf:lg:ix:7': 3 });
  assert.deepEqual(await conn.session.getKeys(), ['alpha', 'sf:lg:ix:7', 'zed']);
  const viaCallback = await new Promise((resolve) => conn.session.getKeys(resolve));
  assert.deepEqual(viaCallback, ['alpha', 'sf:lg:ix:7', 'zed']);
});

test('getKeys takes no arguments but a callback: a key prefix or any other argument is an invalid invocation, like Chrome', async () => {
  const conn = createFakeStorage().connect();
  await conn.session.set({ a: 1, 'sf:lg:cp:1': 2 });
  assert.throws(() => conn.session.getKeys('sf:lg:'), /Error in invocation of storage\.session\.getKeys: No matching signature\./);
  assert.throws(() => conn.session.getKeys(['a']), /No matching signature/);
  assert.throws(() => conn.session.getKeys(null), /No matching signature/);
  assert.throws(() => conn.local.getKeys({}, () => {}), /No matching signature/, 'a callback does not make an extra argument fine');
  // What Chrome accepts: nothing, an explicit undefined for the optional callback, or the callback.
  assert.deepEqual(await conn.session.getKeys(), ['a', 'sf:lg:cp:1']);
  assert.deepEqual(await conn.session.getKeys(undefined), ['a', 'sf:lg:cp:1']);
  assert.deepEqual(await new Promise((resolve) => conn.session.getKeys(resolve)), ['a', 'sf:lg:cp:1']);
});

test('setAccessLevel is recorded, and the area starts as TRUSTED_CONTEXTS', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  assert.equal(store.session.accessLevel, 'TRUSTED_CONTEXTS');
  await conn.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  assert.equal(store.session.accessLevel, 'TRUSTED_AND_UNTRUSTED_CONTEXTS');
  assert.equal(store.local.accessLevel, 'TRUSTED_CONTEXTS');
  assert.deepEqual(conn.host.calls, [{ api: 'storage.session.setAccessLevel', args: [{ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }] }]);
});

test('the two areas are separate', async () => {
  const store = createFakeStorage();
  const { local, session } = store.connect();
  await session.set({ a: 'in session' });
  await local.set({ a: 'in local' });
  assert.deepEqual(await session.get('a'), { a: 'in session' });
  assert.deepEqual(await local.get('a'), { a: 'in local' });
});

// ---------------------------------------------------------------------------------------------
// Call styles and lastError
// ---------------------------------------------------------------------------------------------

test('call styles: a promise without a callback, undefined with one, and the same answer either way', async () => {
  const { session } = createFakeStorage().connect();
  const promise = session.set({ a: 1 });
  assert.ok(promise instanceof Promise);
  await promise;
  const viaPromise = await session.get('a');
  const viaCallback = await new Promise((resolve) => {
    const returned = session.get('a', resolve);
    assert.equal(returned, undefined);
  });
  assert.deepEqual(viaCallback, viaPromise);
});

test('lastError: set only while the failing callback runs, undefined before and after', async () => {
  const store = createFakeStorage({ session: { quotaBytes: 5 } });
  const conn = store.connect();
  assert.equal(conn.lastError, undefined);
  const during = [];
  await new Promise((resolve) =>
    conn.session.set({ a: 'too long for five bytes' }, () => {
      during.push(conn.lastError?.message);
      resolve();
    })
  );
  assert.deepEqual(during, [SESSION_QUOTA_MESSAGE]);
  assert.equal(conn.lastError, undefined);
  // a success afterwards sees no error
  const ok = [];
  await new Promise((resolve) =>
    conn.session.set({ a: 1 }, () => {
      ok.push(conn.lastError);
      resolve();
    })
  );
  assert.deepEqual(ok, [undefined]);
});

test('lastError: a callback that never looks at it is remembered as unchecked, a callback that looks is not', async () => {
  const conn = createFakeStorage({ session: { quotaBytes: 5 } }).connect();
  conn.session.set({ a: 'x'.repeat(50) }, () => {});
  conn.session.set({ b: 'x'.repeat(50) }, () => void conn.lastError);
  await conn.host.settle();
  assert.deepEqual(conn.host.errors.unchecked, [SESSION_QUOTA_MESSAGE]);
});

test('lastError: the promise style rejects and never touches lastError', async () => {
  const conn = createFakeStorage({ session: { quotaBytes: 5 } }).connect();
  await assert.rejects(conn.session.set({ a: 'x'.repeat(50) }), { message: SESSION_QUOTA_MESSAGE });
  assert.equal(conn.lastError, undefined);
  assert.deepEqual(conn.host.errors.unchecked, []);
});

test('calls are recorded without the callback, and the recorded args are copies', async () => {
  const conn = createFakeStorage().connect();
  const value = { n: 1 };
  await conn.local.set({ v: value });
  value.n = 2;
  conn.local.get('v', () => {});
  await conn.host.settle();
  assert.deepEqual(conn.host.calls, [
    { api: 'storage.local.set', args: [{ v: { n: 1 } }] },
    { api: 'storage.local.get', args: ['v'] },
  ]);
});

// ---------------------------------------------------------------------------------------------
// onChanged
// ---------------------------------------------------------------------------------------------

test('onChanged: new key has newValue, a changed key has both, remove has oldValue, clear has oldValue for all', async () => {
  const conn = createFakeStorage().connect();
  const areaSeen = [];
  const rootSeen = [];
  conn.session.onChanged.addListener((changes) => areaSeen.push(changes));
  conn.onChanged.addListener((changes, areaName) => rootSeen.push({ areaName, changes }));

  await conn.session.set({ a: 1 });
  await conn.session.set({ a: 2, b: { x: 1 } });
  await conn.session.remove('a');
  await conn.session.clear();

  assert.deepEqual(areaSeen, [
    { a: { newValue: 1 } },
    { a: { oldValue: 1, newValue: 2 }, b: { newValue: { x: 1 } } },
    { a: { oldValue: 2 } },
    { b: { oldValue: { x: 1 } } },
  ]);
  assert.deepEqual(
    rootSeen.map((r) => r.areaName),
    ['session', 'session', 'session', 'session']
  );
  assert.deepEqual(
    rootSeen.map((r) => r.changes),
    areaSeen
  );
});

test('onChanged: no event for a write that changes nothing, or for removing what is not there', async () => {
  const conn = createFakeStorage().connect();
  await conn.local.set({ a: { same: true } });
  const seen = [];
  conn.local.onChanged.addListener((changes) => seen.push(changes));
  await conn.local.set({ a: { same: true } });
  await conn.local.remove('missing');
  await conn.local.clear().then(() => conn.local.clear());
  assert.deepEqual(seen, [{ a: { oldValue: { same: true } } }], 'only the first clear() removed something');
});

test('onChanged: a local write does not reach session listeners, and the root event names the area', async () => {
  const conn = createFakeStorage().connect();
  const sessionSeen = [];
  const rootSeen = [];
  conn.session.onChanged.addListener((c) => sessionSeen.push(c));
  conn.onChanged.addListener((c, area) => rootSeen.push([area, c]));
  await conn.local.set({ a: 1 });
  assert.deepEqual(sessionSeen, []);
  assert.deepEqual(rootSeen, [['local', { a: { newValue: 1 } }]]);
});

test('onChanged: listeners run after the write, not inside the set() call, and before the promise resolves', async () => {
  const conn = createFakeStorage().connect();
  const order = [];
  conn.session.onChanged.addListener(() => order.push('listener'));
  const promise = conn.session.set({ a: 1 });
  order.push('after set() returned');
  await promise;
  order.push('promise resolved');
  assert.deepEqual(order, ['after set() returned', 'listener', 'promise resolved']);
});

test('onChanged: changing a payload never changes the stored data or another context\'s payload', async () => {
  const store = createFakeStorage();
  const worker = store.connect();
  const panel = store.connect();
  worker.session.onChanged.addListener((changes) => {
    changes.a.newValue.n = 999;
  });
  const panelSeen = [];
  panel.session.onChanged.addListener((changes) => panelSeen.push(changes));
  await worker.session.set({ a: { n: 1 } });
  assert.deepEqual(panelSeen, [{ a: { newValue: { n: 1 } } }]);
  assert.deepEqual(store.session.data(), { a: { n: 1 } });
});

test('onChanged: an error in one listener does not stop the others, and the first error is rethrown', () => {
  const store = createFakeStorage();
  const a = store.connect();
  const b = store.connect();
  const seen = [];
  a.session.onChanged.addListener(() => {
    throw new Error('listener bug');
  });
  b.session.onChanged.addListener((changes) => seen.push(changes));
  b.onChanged.addListener((changes, area) => seen.push([area, changes]));
  assert.throws(() => store.session.dispatch({ x: { newValue: 1 } }), { message: 'listener bug' });
  assert.deepEqual(seen, [{ x: { newValue: 1 } }, ['session', { x: { newValue: 1 } }]]);
});

test('onChanged: an error thrown by a listener during delivery is collected by host.onError, and by default is uncaught', async () => {
  const conn = createFakeStorage().connect();
  const errors = [];
  conn.host.onError = (error) => errors.push(error.message);
  conn.session.onChanged.addListener(() => {
    throw new Error('listener bug');
  });
  await conn.session.set({ a: 1 });
  assert.deepEqual(errors, ['listener bug'], 'the write itself still succeeded');
  assert.deepEqual(await conn.session.get('a'), { a: 1 });

  // With no onError the error must not vanish: the queued delivery rethrows it, which in a real
  // run is an uncaught exception. Catch the queued function instead of letting one happen.
  const host = new Host();
  const realQueueMicrotask = globalThis.queueMicrotask;
  const queued = [];
  globalThis.queueMicrotask = (fn) => queued.push(fn);
  try {
    host.defer(() => {
      throw new Error('listener bug');
    });
  } finally {
    globalThis.queueMicrotask = realQueueMicrotask;
  }
  assert.equal(queued.length, 1);
  assert.throws(() => queued[0](), { message: 'listener bug' });
});

// ---------------------------------------------------------------------------------------------
// Shared store: worker restart, other contexts
// ---------------------------------------------------------------------------------------------

test('shared store: data written before a worker restart survives it, listeners do not', async () => {
  const store = createFakeStorage();
  const worker1 = store.connect();
  const w1Seen = [];
  worker1.session.onChanged.addListener((c) => w1Seen.push(c));
  await worker1.session.set({ 'sf:meta:7': { boot: 1 } });
  assert.equal(w1Seen.length, 1);

  worker1.kill(); // the worker is terminated
  const worker2 = store.connect(); // a new worker: fresh listeners, same store
  assert.deepEqual(await worker2.session.get('sf:meta:7'), { 'sf:meta:7': { boot: 1 } });
  assert.equal(worker2.session.onChanged.hasListeners(), false, 'listeners are not carried over');

  const w2Seen = [];
  worker2.session.onChanged.addListener((c) => w2Seen.push(c));
  await worker2.session.set({ 'sf:meta:7': { boot: 2 } });
  assert.equal(w1Seen.length, 1, 'the dead worker hears nothing');
  assert.deepEqual(w2Seen, [{ 'sf:meta:7': { oldValue: { boot: 1 }, newValue: { boot: 2 } } }]);
});

test('shared store: a second live context (the side panel) hears the worker\'s writes', async () => {
  const store = createFakeStorage();
  const worker = store.connect();
  const panel = store.connect();
  const panelSeen = [];
  panel.onChanged.addListener((changes, area) => panelSeen.push([area, changes]));
  await worker.local.set({ agent_settings: { model: 'm' } });
  assert.deepEqual(panelSeen, [['local', { agent_settings: { newValue: { model: 'm' } } }]]);
});

test('shared store: a killed connection hears nothing more, and the other connections keep working', async () => {
  const store = createFakeStorage();
  const a = store.connect();
  const b = store.connect();
  const aSeen = [];
  a.session.onChanged.addListener((c) => aSeen.push(c));
  await a.session.set({ k: 1 });
  a.kill();
  await b.session.set({ k: 2 });
  assert.equal(aSeen.length, 1, 'only the write made before the kill');
  assert.deepEqual(store.snapshot(), { session: { k: 2 }, local: {} });
});

test('shared store: snapshot() gives parsed copies of both areas', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  await conn.session.set({ s: { a: [1, 2] } });
  await conn.local.set({ l: 'x' });
  const snap = store.snapshot();
  assert.deepEqual(snap, { session: { s: { a: [1, 2] } }, local: { l: 'x' } });
  snap.session.s.a.push(3);
  assert.deepEqual(store.snapshot().session.s.a, [1, 2]);
});

test('store: data can be given at the start, and seed() fires no events but does check the quota', async () => {
  const store = createFakeStorage({ session: { quotaBytes: 30, data: { a: 1 } }, local: { data: { l: 'x' } } });
  assert.deepEqual(store.snapshot(), { session: { a: 1 }, local: { l: 'x' } });
  const conn = store.connect();
  const seen = [];
  conn.session.onChanged.addListener((c) => seen.push(c));
  store.session.seed({ b: 2 });
  await conn.host.settle();
  assert.deepEqual(seen, []);
  assert.throws(() => store.session.seed({ big: 'x'.repeat(100) }), /Session storage quota bytes exceeded/);
  assert.throws(() => createFakeStorage({ session: { quotaBytes: 3, data: { big: 'x'.repeat(10) } } }), /quota/i);
});

test('store: wipe() empties an area without events, like a browser restart clearing storage.session', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  await conn.session.set({ a: 1 });
  await conn.local.set({ b: 2 });
  const seen = [];
  conn.session.onChanged.addListener((c) => seen.push(c));
  store.session.wipe();
  assert.deepEqual(store.snapshot(), { session: {}, local: { b: 2 } });
  assert.equal(store.session.bytesInUse(), 0);
  await conn.host.settle();
  assert.deepEqual(seen, []);
});

test('store: it is a FakeStorage, and connect() calls are recorded per connection', async () => {
  const store = createFakeStorage();
  assert.ok(store instanceof FakeStorage);
  const one = store.connect();
  const two = store.connect();
  await one.session.set({ a: 1 });
  assert.equal(one.host.calls.length, 1);
  assert.equal(two.host.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Timing: delays and races
// ---------------------------------------------------------------------------------------------

test('delayMs: results arrive late, but a read sees the data as it was when it was asked', async () => {
  const store = createFakeStorage({ local: { delayMs: 30, data: { a: 'old' } } });
  const { local } = store.connect();
  const read = local.get('a');
  let resolved = false;
  read.then(() => {
    resolved = true;
  });
  store.local.seed({ a: 'new' }); // written right after the read was issued
  await sleep(5);
  assert.equal(resolved, false, 'still waiting for the delay');
  assert.deepEqual(await read, { a: 'old' });
  assert.deepEqual(await local.get('a'), { a: 'new' });
});

test('races: two read-modify-write flows without a lock lose an update, like the real thing', async () => {
  const { session } = createFakeStorage().connect();
  await session.set({ counter: 0 });
  const bump = async () => {
    const { counter } = await session.get('counter');
    await session.set({ counter: counter + 1 });
  };
  await Promise.all([bump(), bump()]);
  assert.equal((await session.get('counter')).counter, 1, 'both read 0, both wrote 1');
  // ...and run one after the other, they do not
  await session.set({ counter: 0 });
  await bump();
  await bump();
  assert.equal((await session.get('counter')).counter, 2);
});

test('Host.settle() also waits for deliveries that sit behind a long delayMs timer', async () => {
  const conn = createFakeStorage({ local: { delayMs: 150 } }).connect();
  let done = false;
  conn.local.set({ a: 1 }).then(() => {
    done = true;
  });
  await conn.host.settle();
  assert.equal(done, true);
});

test('kill(): what a killed connection had queued never runs, its data stays, and it can no longer call', async () => {
  const store = createFakeStorage({ local: { delayMs: 10 } });
  const conn = store.connect();
  const heard = [];
  conn.local.onChanged.addListener((changes) => heard.push(changes));
  let resolved = false;
  conn.local.set({ k: 1 }).then(() => {
    resolved = true;
  });
  conn.kill();
  await sleep(40);
  assert.equal(resolved, false, 'the old worker\'s promise never resolves');
  assert.deepEqual(heard, [], 'and it hears nothing');
  assert.deepEqual(store.local.data(), { k: 1 }, 'the write itself was applied when it was made');
  assert.throws(() => conn.local.get('k'), /storage\.local\.get was called after kill\(\) - that worker is dead/);
  assert.equal(conn.host.violations.length, 1);
  assert.equal(conn.host.dead, true);
  const next = store.connect();
  assert.deepEqual(await next.local.get('k'), { k: 1 });
});

test('operations happen in call order even with a delay', async () => {
  const { session } = createFakeStorage({ session: { delayMs: 10 } }).connect();
  session.set({ a: 1 });
  session.set({ a: 2 });
  const { a } = await session.get('a');
  assert.equal(a, 2);
});

// ---------------------------------------------------------------------------------------------
// The shared primitives
// ---------------------------------------------------------------------------------------------

test('FakeEvent: listeners are added once, removed, and all run even if one throws', () => {
  const event = new FakeEvent();
  const seen = [];
  const a = (x) => seen.push(['a', x]);
  const b = () => {
    throw new Error('b broke');
  };
  const c = (x) => seen.push(['c', x]);
  event.addListener(a);
  event.addListener(a); // the same function twice registers once
  event.addListener(b);
  event.addListener(c);
  assert.equal(event.hasListener(a), true);
  assert.equal(event.hasListeners(), true);
  assert.throws(() => event.dispatch(1), { message: 'b broke' });
  assert.deepEqual(seen, [['a', 1], ['c', 1]]);
  event.removeListener(a);
  event.removeListener(b);
  assert.deepEqual(event.dispatch(2), [3]);
  event.clear();
  assert.equal(event.hasListeners(), false);
  assert.throws(() => event.addListener('not a function'), TypeError);
});

test('Host: defer() runs later, settle() waits for everything queued, violation() is recorded', async () => {
  const host = new Host();
  const order = [];
  host.defer(() => order.push('microtask'));
  host.defer(() => order.push('timer'), 15);
  order.push('sync');
  await host.settle();
  assert.deepEqual(order, ['sync', 'microtask', 'timer']);
  const error = host.violation('a test mistake');
  assert.equal(error.message, 'a test mistake');
  assert.deepEqual(host.violations, [error]);
});
