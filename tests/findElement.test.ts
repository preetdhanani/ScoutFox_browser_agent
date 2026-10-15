/**
 * find_element (prompts-side find-elements-beyond-window): the lookup verb that reaches elements
 * past the 120-element window.
 *
 * Four things are pinned here:
 *   - the fake content script answers find_element like the real one (the executor parity of
 *     tests/fakeDom.test.ts, for the new verb): the same page gives the same reply, byte for byte;
 *   - a target past the window (button 250 of 300) is found, clickable, and its id still resolves
 *     after a new snapshot, because the compressor keeps the found ids in the same elementMap and
 *     docId and the snapshot's refs (the validation set) carries them;
 *   - zero matches answer an explicit no-match message with the labels nearest the words;
 *   - the optional tie-break stage of the background executor accepts only ids from the candidate
 *     set, so a hallucinated id from the model call is dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeChrome } from './helpers/fakeChrome.ts';
import type { FakeChrome } from './helpers/fakeChrome.ts';
import { button, fakeDom, link, pageSnapshot } from './helpers/fakeDom.ts';
import type { DomSnapshot, FakeDom, PageSpec } from './helpers/fakeDom.ts';
import { DOMCompressor } from '../src/content/domCompressor.ts';
import { ActionExecutor } from '../src/content/actionExecutor.ts';
import { withGlobals } from './helpers/contentGlobals.ts';

// ---------------------------------------------------------------------------------------------
// The rig: a fake site with one long page, like the rig of tests/fakeDom.test.ts
// ---------------------------------------------------------------------------------------------

const snapshotMessage = { action: 'GET_DOM_SNAPSHOT', payload: {} };
const act = (payload: Record<string, unknown>) => ({ action: 'EXECUTE_ACTION', payload });

interface Rig {
  site: FakeDom;
  fc: FakeChrome;
  send(message: unknown): Promise<any>;
  snapshot(): Promise<DomSnapshot>;
}

function rig(pages: PageSpec[], startUrl?: string): Rig {
  const site = fakeDom({ pages });
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: startUrl ?? pages[0]!.url }] }, dom: true });
  site.attach(fc, 101);
  return {
    site,
    fc,
    send: (message) => fc.chrome.tabs.sendMessage(101, message),
    snapshot: async () => (await fc.chrome.tabs.sendMessage(101, snapshotMessage)).data as DomSnapshot,
  };
}

/** A page of 300 buttons in document order; the target ("Buy now") is number 250, far below the fold. */
function bigPage(): PageSpec {
  return {
    url: 'https://big.test/',
    title: 'Big',
    viewportHeight: 800,
    pageHeight: 11000,
    elements: [
      ...Array.from({ length: 249 }, (_, i) => button(`Filler ${i}`, { y: i * 36 })),
      button('Buy now', { y: 249 * 36 }),
      ...Array.from({ length: 50 }, (_, i) => button(`Filler ${249 + i}`, { y: (250 + i) * 36 })),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// A target past the window: found, clickable, and its id survives a new snapshot
// ---------------------------------------------------------------------------------------------

test('find_element reaches button 250 of 300: found, clickable, and the id still resolves after a new snapshot', async () => {
  const r = rig([bigPage()]);

  const before = await r.snapshot();
  assert.equal(before.elementCount, 300);
  assert.equal(before.omittedCount, 180);
  assert.equal(before.refs.length, 120, 'the window cap is unchanged');
  assert.ok(!before.elementsText.includes('Buy now'), 'the target is not listed before the find');

  const find = await r.send(act({ action: 'find_element', query: 'buy now' }));
  assert.equal(find.success, true);
  assert.match(find.message, /^FOUND 1 match for "buy now" - showing 1\. The ids below work like the ones in the ELEMENTS list:\n\[121\] button "Buy now" \[off-screen\]$/);
  assert.equal(find.result.foundCount, 1);
  assert.equal(find.result.shownCount, 1);
  assert.equal(find.result.tied, false);
  assert.deepEqual(find.result.matches.map((m: any) => m.id), [121]);

  const clicked = await r.send(act({ action: 'click', element_id: 121 }));
  assert.equal(clicked.success, true, JSON.stringify(clicked));
  assert.equal(clicked.label, 'Buy now');

  // A new snapshot rebuilds the window, and the found id stays resolvable: the snapshot's refs
  // (the validation set the engine checks ids against) carries it, shownRefs does not.
  const after = await r.snapshot();
  assert.ok(after.refs.includes(121), 'the found id is in the validation set');
  assert.ok(!after.shownRefs.includes(121), 'the found id is not rendered in the element list');
  const clickedAgain = await r.send(act({ action: 'click', element_id: 121 }));
  assert.equal(clickedAgain.success, true, JSON.stringify(clickedAgain));

  r.site.assertClean();
});

test('a find id keeps working next to the window ids, and a second find continues after the first ids', async () => {
  const r = rig([bigPage()]);
  await r.snapshot();

  const first = await r.send(act({ action: 'find_element', query: 'buy now' }));
  assert.deepEqual(first.result.matches.map((m: any) => m.id), [121]);

  // A second find continues after the ids the first one handed out.
  const second = await r.send(act({ action: 'find_element', query: 'filler 7' }));
  assert.equal(second.success, true);
  assert.ok(second.result.matches[0].id > 121, JSON.stringify(second.result.matches));

  r.site.assertClean();
});

// ---------------------------------------------------------------------------------------------
// Zero matches: the explicit no-match message with the nearest labels
// ---------------------------------------------------------------------------------------------

test('zero matches answer the no-match message with the labels nearest the words', async () => {
  const r = rig([bigPage()]);
  await r.snapshot();

  // "buyer" shares a prefix with the "buy" token of "Buy now", so that label comes first.
  const near = await r.send(act({ action: 'find_element', query: 'buyer guide' }));
  assert.equal(near.success, true);
  assert.equal(near.result.foundCount, 0);
  assert.match(near.message, /^No element on this page matches "buyer guide"\. Labels nearest your words: Buy now, Filler 0, Filler 1, Filler 2, Filler 3\. Try other words and call find_element again\.$/);

  // Nothing shares anything: the five labels nearest the viewport are shown.
  const far = await r.send(act({ action: 'find_element', query: 'unicorn spell' }));
  assert.equal(far.success, true);
  assert.match(far.message, /^No element on this page matches "unicorn spell"\. Labels nearest your words: Filler 0, Filler 1, Filler 2, Filler 3, Filler 4\. Try other words and call find_element again\.$/);

  r.site.assertClean();
});

test('find_element without a query is refused with the fix', async () => {
  const r = rig([bigPage()]);
  await r.snapshot();
  const empty = await r.send(act({ action: 'find_element', query: '   ' }));
  assert.equal(empty.success, false);
  assert.match(empty.error, /find_element needs a query/);
  const missing = await r.send(act({ action: 'find_element' }));
  assert.equal(missing.success, false);
  assert.match(missing.error, /find_element needs a query/);
  r.site.assertClean();
});

test('more than eight matches are cut to the best eight, and equal scores keep document order', async () => {
  const pages: PageSpec[] = [{
    url: 'https://many.test/',
    title: 'Many',
    viewportHeight: 800,
    pageHeight: 1400,
    elements: Array.from({ length: 10 }, (_, i) => button('Next', { y: 820 + i * 30 })),
  }];
  const r = rig(pages);
  await r.snapshot();

  const find = await r.send(act({ action: 'find_element', query: 'next' }));
  assert.equal(find.success, true);
  assert.equal(find.result.foundCount, 10);
  assert.equal(find.result.shownCount, 8);
  assert.match(find.message, /^FOUND 10 matches for "next" - showing 8 \(best matches\)\. The ids below work like the ones in the ELEMENTS list:\n\[11\] button "Next" \[off-screen\]\n\[12\] button "Next" \[off-screen\]/);
  assert.equal(find.result.tied, true, 'ten equal scores tie at the top');

  r.site.assertClean();
});

// ---------------------------------------------------------------------------------------------
// Executor parity: the fake content script answers what the real ActionExecutor answers
// ---------------------------------------------------------------------------------------------

interface FakeNode {
  tagName: string;
  nodeType: number;
  id: string;
  innerText: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  value: string;
  parentElement: unknown;
  getAttribute(name: string): string | null;
  closest(selector: string): unknown;
  setAttribute(): void;
  checkVisibility(): boolean;
  getBoundingClientRect(): { width: number; height: number; top: number; bottom: number; left: number; right: number };
}

/** The real compressor and executor over a stub DOM built from the same description (as tests/fakeDom.test.ts does). */
function realFindReply(page: PageSpec, query: string, maxElements: number): any {
  const scrollY = page.scrollY ?? 0;
  const body = { nodeType: 1, innerText: typeof page.text === 'string' ? page.text : '', textContent: '' };
  const nodes: FakeNode[] = [];
  for (const spec of page.elements ?? []) {
    const tag = spec.tag.toLowerCase();
    const attributes: Record<string, string> = {};
    if (spec.type) attributes.type = spec.type;
    if (spec.placeholder) attributes.placeholder = spec.placeholder;
    if (spec.label) attributes['aria-label'] = spec.label;
    if (spec.role) attributes.role = spec.role;
    if (spec.name) attributes.name = spec.name;
    const top = (spec.y ?? 0) - scrollY;
    nodes.push({
      tagName: spec.tag.toUpperCase(),
      nodeType: 1,
      ...(tag === 'a' ? { href: new URL(spec.goes ?? '#', page.url).href } : {}),
      id: spec.id ?? '',
      innerText: spec.text ?? '',
      textContent: spec.text ?? '',
      disabled: spec.disabled ?? false,
      checked: false,
      value: spec.value ?? '',
      parentElement: body,
      getAttribute: (name) => attributes[name] ?? null,
      closest: () => null,
      setAttribute: () => {},
      checkVisibility: () => true,
      getBoundingClientRect: () => ({ width: 50, height: 20, top, bottom: top + 20, left: 10, right: 60 }),
    });
  }
  const fakeWindow = {
    location: { href: page.url, hostname: new URL(page.url).hostname },
    innerWidth: 1200,
    innerHeight: page.viewportHeight ?? 800,
    scrollY,
  };
  const fakeDocument = {
    title: page.title ?? '',
    contentType: 'text/html',
    documentElement: { scrollHeight: page.pageHeight ?? 800 },
    body,
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector.includes('a[href]') ? nodes : []),
  };
  return withGlobals(
    {
      window: fakeWindow,
      document: fakeDocument,
      Node: { ELEMENT_NODE: 1 },
      CSS: { escape: (s: string) => s },
    },
    () => {
      const compressor = new DOMCompressor();
      compressor.getSnapshot({ maxElements });
      const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);
      (fakeWindow as any).domCompressor = compressor;
      return executor.execute(JSON.parse(JSON.stringify({ action: 'find_element', query })));
    }
  );
}

const PARITY_PAGE: PageSpec = {
  url: 'https://parity.test/',
  title: 'Parity',
  viewportHeight: 800,
  pageHeight: 5100,
  elements: [
    button('Alpha'),
    button('Beta'),
    link('Home'),
    button('Gamma', { y: 5000 }),
  ],
};

test('executor parity: the fake content script answers find_element exactly like the real one', async () => {
  const real = await realFindReply(PARITY_PAGE, 'gamma', 2);
  const r = rig([PARITY_PAGE]);
  await r.send({ action: 'GET_DOM_SNAPSHOT', payload: { maxElements: 2 } });
  const fake = await r.send(act({ action: 'find_element', query: 'gamma' }));

  assert.deepEqual(fake, JSON.parse(JSON.stringify(real)), `real: ${JSON.stringify(real)}`);
  assert.match(fake.message, /\[3\] button "Gamma" \[off-screen\]$/, 'the cut element is found with the id after the window');
  r.site.assertClean();
});

// ---------------------------------------------------------------------------------------------
// The optional tie-break stage of the background executor
// ---------------------------------------------------------------------------------------------

const TIE_MATCHES = [
  { id: 121, line: '[121] button "Next page" (label="Next page")', score: 6 },
  { id: 122, line: '[122] button "Next page" (label="Next page")', score: 6 },
];
const TIE_HEADER = 'FOUND 2 matches for "next page" - showing 2. The ids below work like the ones in the ELEMENTS list:';
const TIE_MESSAGE = `${TIE_HEADER}\n${TIE_MATCHES.map((m) => m.line).join('\n')}`;

test('tie-break: ids the model reply names are kept only when they are in the candidate set', async () => {
  const { tieBreakIdsFromReply } = await import('../src/background/browser/execute.ts');
  assert.deepEqual(tieBreakIdsFromReply('Best: 122, then 999, and 122 again.', [121, 122]), [122], '999 is not a candidate and is dropped');
  assert.deepEqual(tieBreakIdsFromReply('no numbers here', [121, 122]), []);
  assert.deepEqual(tieBreakIdsFromReply(42, [121]), [], 'a non-string reply picks nothing');
});

test('tie-break: the picked matches are moved to the front, the unpicked keep their order behind them', async () => {
  const { applyTieBreak } = await import('../src/background/browser/execute.ts');
  const reordered = applyTieBreak(TIE_MATCHES, [122]);
  assert.deepEqual(reordered.map((m) => m.id), [122, 121]);
  assert.deepEqual(applyTieBreak(TIE_MATCHES, []), TIE_MATCHES, 'nothing picked: the deterministic order stands');
});

test('tie-break: a hallucinated id from the model call is dropped and the order follows the valid picks', async () => {
  const { executeAction } = await import('../src/background/browser/execute.ts');
  const completions: any[] = [];
  const result = await executeAction(101, { action: 'find_element', query: 'next page' }, {
    dispatchAction: async () => ({
      success: true,
      message: TIE_MESSAGE,
      result: { query: 'next page', foundCount: 2, shownCount: 2, tied: true, matches: TIE_MATCHES },
      via: 'cdp',
      effect: 'none',
    }),
    tabInfo: async () => ({ url: 'https://tie.test/', title: 'Tie', windowId: 1, groupId: 2, status: 'complete' }),
    runRuntime: {
      control: { stepSignal: () => new AbortController().signal },
      llm: {
        complete: async (req: any) => {
          completions.push(req);
          return { text: 'The better match is element 999, then 122.', provider: 'mock', model: 'mock', meta: {} };
        },
      },
    },
  } as any);

  assert.equal(completions.length, 1, 'one tie-break call');
  assert.equal(result.success, true);
  assert.equal(result.effect, 'none', 'a lookup never changes the page');
  assert.equal(result.oneShot?.label, 'Element Matches');
  assert.equal(result.message, `${TIE_HEADER}\n[122] button "Next page" (label="Next page")\n[121] button "Next page" (label="Next page")`);
  assert.equal(result.oneShot?.text, result.message);
  assert.deepEqual((result.result as any).matches.map((m: any) => m.id), [122, 121], '999 is dropped');
});

test('tie-break: a failing model call keeps the deterministic order, and no tie makes no call', async () => {
  const { executeAction } = await import('../src/background/browser/execute.ts');
  const dispatch = async () => ({
    success: true,
    message: TIE_MESSAGE,
    result: { query: 'next page', foundCount: 2, shownCount: 2, tied: true, matches: TIE_MATCHES },
    via: 'cdp',
    effect: 'none',
  });
  const tabInfo = async () => ({ url: 'https://tie.test/', title: 'Tie', windowId: 1, groupId: 2, status: 'complete' });

  const failing = await executeAction(101, { action: 'find_element', query: 'next page' }, {
    dispatchAction: dispatch,
    tabInfo,
    runRuntime: {
      control: { stepSignal: () => new AbortController().signal },
      llm: { complete: async () => { throw new Error('model down'); } },
    },
  } as any);
  assert.equal(failing.message, TIE_MESSAGE, 'the deterministic order stands');
  assert.equal(failing.oneShot?.text, TIE_MESSAGE);

  let called = 0;
  const untied = await executeAction(101, { action: 'find_element', query: 'next page' }, {
    dispatchAction: async () => ({
      success: true,
      message: TIE_MESSAGE,
      result: { query: 'next page', foundCount: 2, shownCount: 2, tied: false, matches: TIE_MATCHES },
      via: 'cdp',
      effect: 'none',
    }),
    tabInfo,
    runRuntime: {
      control: { stepSignal: () => new AbortController().signal },
      llm: { complete: async () => { called++; return { text: '122', provider: 'mock', model: 'mock', meta: {} }; } },
    },
  } as any);
  assert.equal(called, 0, 'no tie, no model call');
  assert.equal(untied.message, TIE_MESSAGE);
});

// ---------------------------------------------------------------------------------------------
// The count line of the ELEMENTS block
// ---------------------------------------------------------------------------------------------

test('the policy prompt states how many elements were shown and points to find_element when the cap cut', async () => {
  const { buildPolicyUserMessage } = await import('../src/background/agent/prompts.ts');
  const cut = pageSnapshot(bigPage());
  const message = buildPolicyUserMessage({
    task: 'Buy the thing',
    siteIndex: 1,
    totalSites: 1,
    domain: 'big.test',
    role: 'other',
    goal: 'Buy the thing',
    usedSteps: 1,
    allocSteps: 10,
    meterMode: 'normal',
    pageTitle: cut.title,
    pageUrl: cut.url,
    pageType: 'page',
    scrollY: 0,
    pageText: cut.pageText,
    elementsText: cut.elementsText,
  });
  assert.match(message, /ELEMENTS:\n120 of 300 shown - use find_element \{query\} to search the elements past this list\n\[1\] /);
  assert.match(message, /\[\+180 more interactive elements not listed - scroll to bring them into view, or use find_element to search them\]/);

  const whole = pageSnapshot({ url: 'https://small.test/', elements: [button('Only')] });
  const plain = buildPolicyUserMessage({
    task: 't', siteIndex: 1, totalSites: 1, domain: 'small.test', role: 'other', goal: 'g',
    usedSteps: 1, allocSteps: 10, meterMode: 'normal',
    pageTitle: whole.title, pageUrl: whole.url, pageType: 'page', scrollY: 0,
    pageText: whole.pageText, elementsText: whole.elementsText,
  });
  assert.doesNotMatch(plain, /find_element/, 'a page that fits the list gets no find hint');
  assert.match(plain, /ELEMENTS:\n\[1\] button "Only"/);
});
