/**
 * The MCP server: the tools the model calls, executed in the browser.
 *
 * The server is the only place where a decision the model made becomes an action on a page, so
 * this is where the mistakes are expensive: a tool that acts on the wrong tab, an error that is
 * swallowed into a result the model reads as success, or a tool that answers something the model
 * then believes.
 *
 * The server is driven here with the real browser layer over fakeChrome and fakeDom: the same
 * snapshot and the same action executor the extension uses, so a test sees what the page saw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ScoutFoxMCPServer, coordinateClickRefusal, rankElementLines } from '../../src/background/mcp/server.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { fakeDom, link } from '../helpers/fakeDom.ts';
import type { RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';

const PAGE_URL = 'https://shop.test/items';
const DETAIL_URL = 'https://shop.test/items/42';

/** A runtime with the parts the server reads: the tabs, the clock and the control. */
function makeRuntime(tabId: number | null, ownerTabId = 101): RunRuntime {
  const clock = { now: () => 0, sleep: async () => {} };
  return {
    threadId: String(ownerTabId),
    ownerTabId,
    bootId: 'boot-1',
    control: {
      pauseRequested: false,
      stopRequested: false,
      stepSignal: () => new AbortController().signal,
      abortStep: () => {},
      isUserAbort: () => false,
      snapshot: () => ({ pauseRequested: false, stopRequested: false }),
    },
    tabs: { activeTabId: tabId, ownerTabId },
    windowId: 1,
    scoutFoxGroupIds: new Map(),
    attachedTabIds: new Set(),
    resumedAfterRestart: false,
    settings: async () => ({} as any),
    llm: { complete: async () => ({ text: '', provider: 'p', model: 'm', meta: {} }) },
    browser: {
      // The action executor asks the runtime for the url of the tab, to see whether the page
      // changed. A tab that is not there answers with nothing, like the real port does.
      tabInfo: async (id: number) => {
        const tabs = (globalThis as any).chrome?.tabs;
        if (!tabs?.get) return null;
        const tab = await tabs.get(id).catch(() => null);
        if (!tab) return null;
        return {
          url: tab.url ?? '',
          title: tab.title ?? '',
          windowId: tab.windowId,
          groupId: tab.groupId ?? -1,
          status: tab.status ?? 'complete'
        };
      },
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {}
    } as any,
    journal: {} as any,
    net: { marker: () => 'm', read: () => '' },
    emit: { enterNode: () => {}, setPhase: () => {} },
    clock,
  } as RunRuntime;
}

/** A server over a fake page, with the chrome installed for the test. */
function withPage(t: any, options: { tabId?: number | null; activeTabId?: number | null } = {}) {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: PAGE_URL, title: 'Items', windowId: 1 }] },
    tabGroups: true,
    dom: true,
    // A click goes through CDP when it can attach, and falls back to a synthetic click when it
    // cannot. The debugger is declared here so the test sees the path the extension takes.
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': {}
      }
    },
    scripting: { executeScript: [{ result: 800 }] },
  });
  const restore = fc.install();
  // The debugger manager is a singleton that remembers which tabs it attached to. Without this
  // the next test would find the tab still attached and would not go through the fake.
  t.after(async () => {
    await cdp.detachAll();
    restore();
  });
  const site = fakeDom({
    pages: [
      {
        url: PAGE_URL,
        title: 'Items',
        text: ['Item 42 available for 99 USD', 'Item 43 available for 120 USD'],
        elements: [link('Item 42 Details', DETAIL_URL)],
      },
      {
        url: DETAIL_URL,
        title: 'Item 42',
        text: ['Item 42 costs 99 USD'],
        elements: [link('Back to items', PAGE_URL)],
      },
    ],
  });
  site.attach(fc as any, 101);

  const runtime = makeRuntime(options.activeTabId === undefined ? 101 : options.activeTabId);
  const server = new ScoutFoxMCPServer();
  server.setRuntime(runtime);
  return { fc, site, server, runtime };
}

/** The text of the first content of a tool result. */
function textOf(result: { text: string }): string {
  return result.text ?? '';
}

test('get_page_text returns the text of the page', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('get_page_text', {});
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /Item 42 available for 99 USD/);
});

test('get_page_elements returns the interactive elements with their ids', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('get_page_elements', {});
  assert.match(textOf(result), /Item 42 Details/);
});

test('get_page_text on a page with no text says so, instead of returning nothing', async (t) => {
  // An empty string would read to the model as "the page is empty", which is a wrong conclusion
  // about a page that simply has no readable text.
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: 'https://shop.test/blank', title: 'Blank', windowId: 1 }] }, tabGroups: true, dom: true });
  const restore = fc.install();
  t.after(restore);
  const site = fakeDom({ pages: [{ url: 'https://shop.test/blank', title: 'Blank', text: [] }] });
  site.attach(fc as any, 101);
  const server = new ScoutFoxMCPServer();
  server.setRuntime(makeRuntime(101));
  const result = await server.callTool('get_page_text', {});
  assert.ok(textOf(result).length > 0, 'the model is told something, not nothing at all');
});

test('find returns the elements that match the query', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('find', { query: 'Item 42' });
  assert.match(textOf(result), /Item 42 Details/);
  assert.match(textOf(result), /matches "Item 42"/);
});

test('find with a query that matches nothing says so, and points at the way to find out', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('find', { query: 'the checkout button' });
  const text = textOf(result);
  assert.match(text, /No elements found matching/);
  assert.match(text, /get_page_elements/, 'the answer says how to look again');
});

test('find matches without regard to case', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('find', { query: 'item 42 details' });
  assert.match(textOf(result), /Item 42 Details/);
});

test('a tool that acts on the page reaches the page', async (t) => {
  const { server, site, fc } = withPage(t);
  // The model lists the elements first, so the page knows which ids exist. That is the order the
  // system prompt asks for, and it is what makes the id resolvable.
  await server.callTool('get_page_elements', {});
  const result = await server.callTool('click', { element_id: 1 });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /Clicked element \[1\]/);
  // The click goes over CDP, which is the path the extension takes on a real browser: trusted
  // mouse events at the point of the element, not a synthetic DOM event.
  const mouseEvents = fc
    .callsTo('debugger.sendCommand')
    .filter((call: any) => call.args[1] === 'Input.dispatchMouseEvent')
    .map((call: any) => call.args[2]);
  assert.deepEqual(
    mouseEvents.map((params: any) => params.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
    'the click reached the page as a trusted mouse press and release'
  );
  assert.equal(site.actions.length, 0, 'a CDP click does not go through the content script');
});

test('a click that does not reach the page comes back as an error, not as a success', async (t) => {
  // The model decides what to do next from the text of the tool result. A click that never
  // happened, answered with "Clicked element [1]", makes the model believe the page moved on.
  const { server } = withPage(t);
  await server.callTool('get_page_elements', {});
  // Element 7 is not on the page, so nothing can be clicked.
  const result = await server.callTool('click', { element_id: 7 });
  assert.equal(result.isError, true, 'the result is marked as an error');
  assert.match(textOf(result), /^Error:/, 'the model is told the click failed');
  assert.doesNotMatch(textOf(result), /Clicked element \[7\]/, 'and not that it clicked');
});

test('a navigate to a page that is not there comes back as an error, not as a success', async (t) => {
  // The model reads the result and decides what to do next. A navigation that never happened,
  // answered with "Navigated to ...", makes the model read a page it is not on.
  const { server } = withPage(t);
  const result = await server.callTool('navigate', { url: 'https://shop.test/missing' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error:/);
  assert.doesNotMatch(textOf(result), /Navigated to/);
});

test('the reason for an action is in the result, so the model can read what it did', async (t) => {
  const { server } = withPage(t);
  // The element has to be on the page for the click to be the one the model asked for.
  await server.callTool('get_page_elements', {});
  const result = await server.callTool('click', { element_id: 1, reason: 'open the details' });
  assert.match(textOf(result), /open the details/);
});

test('a tool that acts on a page that is gone fails, and says so', async (t) => {
  // A tool that answers "success" for a page that is not there makes the model believe the page
  // changed. The error has to come back as an error.
  const fc = fakeChrome({ tabs: { list: [] }, tabGroups: true, dom: true });
  const restore = fc.install();
  t.after(restore);
  const server = new ScoutFoxMCPServer();
  server.setRuntime(makeRuntime(101));
  const result = await server.callTool('get_page_text', {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Error:/);
});

test('with no runtime at all every tool fails, instead of throwing', async (t) => {
  const fc = fakeChrome({ tabs: { list: [] }, tabGroups: true, dom: true });
  const restore = fc.install();
  t.after(restore);
  const server = new ScoutFoxMCPServer();
  // No runtime: the server was never given a browser session.
  const result = await server.callTool('get_page_text', {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /No active browser session/);
});

test('with no active tab the run continues on the tab the session owns', async (t) => {
  // The active tab is the one the user is looking at. When there is none (the user switched away,
  // or the run was started from a panel of another tab), the run continues on the owner tab
  // instead of stopping.
  const { server, site } = withPage(t, { activeTabId: null });
  const result = await server.callTool('get_page_text', {});
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /Item 42 available for 99 USD/);
  assert.ok(site, 'the page answered');
});

test('with no active tab the owner tab is used, and a tab that is gone fails', async (t) => {
  // The active tab is the one the user is looking at; when there is none, the run continues on the
  // tab the session owns. A tab that does not exist any more is an error the model must see.
  const fc = fakeChrome({ tabs: { list: [] }, tabGroups: true, dom: true });
  const restore = fc.install();
  t.after(restore);
  const server = new ScoutFoxMCPServer();
  server.setRuntime(makeRuntime(null));
  const result = await server.callTool('get_page_text', {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /no longer exists|Error:/);
});

test('a tool the server does not know is an error, and names itself', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('teleport', {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown tool: teleport/);
});

test('finish returns the answer marked as the end of the task', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('finish', { answer: 'It costs 99 USD.' });
  assert.equal(result.isError, undefined);
  // The client reads this marker and ends the run. Without it the run would keep going.
  assert.equal(textOf(result), 'TASK_COMPLETE: It costs 99 USD.');
});

test('listTools returns the tools of the extension', async (t) => {
  const { server } = withPage(t);
  const tools = await server.listTools();
  const names = tools.map((tool: any) => tool.name);
  assert.ok(names.includes('finish'));
  assert.ok(names.includes('get_page_text'));
  assert.ok(names.includes('click'));
});

test('a wait waits for the time the model asked for, and the clock is the one of the runtime', async (t) => {
  const { server, runtime } = withPage(t);
  const slept: number[] = [];
  runtime.clock.sleep = async (ms: number) => { slept.push(ms); };
  const result = await server.callTool('wait', { amount: 3 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(slept, [3000], 'three seconds is three thousand milliseconds');
  assert.match(textOf(result), /Waited 3s/);
});

// ---------------------------------------------------------------------------------------------
// Screenshots and coordinate clicks
// ---------------------------------------------------------------------------------------------

/** A JPEG header that says w by h, base64. */
function jpegBase64(w: number, h: number): string {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff,
    (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9
  ]).toString('base64');
}

/** A capture path over a fixed viewport, so the server's frame maths is what is under test. */
function screenshotStub(options: { width?: number; height?: number; dpd?: number; fail?: string; scrollY?: number } = {}): any {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  return () => ({
    isTabInScope: async () => true,
    sendCommand: async () => {
      if (options.fail) throw new Error(options.fail);
      return { data: jpegBase64(width, height) };
    },
    page: {
      tabUrl: async () => PAGE_URL,
      probe: async () => ({ width, height, devicePixelRatio: options.dpd ?? 1, scrollX: 0, scrollY: options.scrollY ?? 0, scale: 1 }),
      signature: async () => ({ interactiveHash: 'a', textHash: 'b' }),
      hideUi: async () => true,
      showUi: async () => {}
    }
  });
}

test('take_screenshot returns a text block AND a picture, and the text names the picture', async (t) => {
  const { server } = withPage(t);
  server.setScreenshotDeps(screenshotStub());
  const result = await server.callTool('take_screenshot', {});

  assert.equal(result.isError, undefined, 'a capture that worked is not an error');
  assert.match(result.text, /Captured the visible page \(1280x720, image\/jpeg\)/);
  assert.match(result.text, /pixels in this picture/, 'the model is told the frame');
  assert.ok(result.image, 'the picture travels with the result');
  assert.equal(result.image!.type, 'image');
  assert.equal(result.image!.mediaType, 'image/jpeg');
  assert.equal(result.image!.imageWidth, 1280);
  assert.equal(result.image!.imageHeight, 720);
  assert.equal(result.image!.data, jpegBase64(1280, 720), 'the bytes the capture produced');
  assert.ok(result.image!.imageId.length > 0, 'the panel fetches the picture by this id');
});

test('a capture that fails comes back as an error the model can act on, not as a thrown exception', async (t) => {
  const { server } = withPage(t);
  server.setScreenshotDeps(screenshotStub({ fail: 'the renderer crashed' }));
  const result = await server.callTool('take_screenshot', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /renderer crashed|screenshot failed/);
  assert.match(result.text, /get_page_text/, 'the model is told what to do instead');
  assert.equal(result.image, undefined);
});

test('a click with a coordinate and no picture yet is refused', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('click', { x: 100, y: 100 });
  assert.equal(result.isError, true);
  assert.match(result.text, /no screenshot has been taken/i);
});

test('a click outside the picture is refused, and the message names the picture', async (t) => {
  const { server } = withPage(t);
  server.setScreenshotDeps(screenshotStub());
  await server.callTool('take_screenshot', {});
  const result = await server.callTool('click', { x: 5000, y: 100 });
  assert.equal(result.isError, true);
  assert.match(result.text, /\(5000, 100\)/);
  assert.match(result.text, /1280x720/);
});

test('a half coordinate click is refused, and not by the mouse', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('click', { x: 100 });
  assert.equal(result.isError, true);
  assert.match(result.text, /both x and y/);
});

test('render_table builds a table with matching rows', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('render_table', {
    columns: ['Shop', 'Price', 'Shipping', 'Total'],
    rows: [
      ['A', '899 EUR', '4.90 EUR', '903.90 EUR'],
      ['B', '949 EUR', '0.00 EUR', '949.00 EUR'],
      ['C', '919 EUR', '5.00 EUR', '924.00 EUR']
    ]
  });
  assert.equal(result.isError, undefined, 'a valid table is not an error');
  assert.match(result.text, /Table built: 3 row\(s\), 4 column\(s\)/);
  assert.ok(result.table, 'the table travels with the result');
  assert.deepEqual(result.table!.columns, ['Shop', 'Price', 'Shipping', 'Total']);
  assert.deepEqual(result.table!.rows, [
    ['A', '899 EUR', '4.90 EUR', '903.90 EUR'],
    ['B', '949 EUR', '0.00 EUR', '949.00 EUR'],
    ['C', '919 EUR', '5.00 EUR', '924.00 EUR']
  ]);
});

test('render_table rejects a row that does not match the column count', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('render_table', {
    columns: ['Shop', 'Price'],
    rows: [['A', '99 EUR', 'extra cell']]
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /matching the column count/);
});

test('finish accepts an optional table alongside the answer', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('finish', {
    answer: 'The cheapest shop is A.',
    table: { columns: ['Shop', 'Price'], rows: [['A', '899 EUR']] }
  });
  assert.equal(result.isError, undefined, 'a finish with a table is not an error');
  assert.match(result.text, /TASK_COMPLETE: The cheapest shop is A\./);
  assert.ok(result.table, 'the table travels with finish');
  assert.deepEqual(result.table!.columns, ['Shop', 'Price']);
});

test('a click with neither an element nor coordinates says what click needs', async (t) => {
  const { server } = withPage(t);
  const result = await server.callTool('click', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /element_id from get_page_elements, or both x and y/);
});

test('a click with an element id still works, and still reports a failure as a failure', async (t) => {
  const { server } = withPage(t);
  await server.callTool('get_page_elements', {});
  const ok = await server.callTool('click', { element_id: 1 });
  assert.equal(ok.isError, undefined);
  assert.match(ok.text, /Clicked element \[1\]/);

  const bad = await server.callTool('click', { element_id: 999 });
  assert.equal(bad.isError, true, 'an element that is not there is not a click');
});

test('the frame of a screenshot is remembered per tab, for the next coordinate click', async (t) => {
  const { server } = withPage(t);
  server.setScreenshotDeps(screenshotStub({ width: 1280, height: 720 }));
  assert.equal(server.frameFor(101), null);
  await server.callTool('take_screenshot', {});
  const frame = server.frameFor(101);
  assert.ok(frame, 'the frame is stored');
  assert.equal(frame!.imageWidth, 1280);
  assert.equal(frame!.imageHeight, 720);
  assert.equal(frame!.viewportWidth, 1280);
});

test('after a provider refused a picture, the tool answers honestly and takes nothing', async (t) => {
  const { server } = withPage(t);
  server.setScreenshotDeps(screenshotStub());
  server.setVisionUnavailable();
  const result = await server.callTool('take_screenshot', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /cannot see pictures/);
  assert.match(result.text, /get_page_text/);
  assert.equal(result.image, undefined);
});

test('two refusals in a row close the coordinate path, and say which path still works', async (t) => {
  const { server } = withPage(t);
  // The capture reports the page at its top, and the click re-reads the page 500 pixels down:
  // a page that moved under the picture, which is the refusal this check is about.
  server.setScreenshotDeps(screenshotStub({ width: 1280, height: 720 }));
  await server.callTool('take_screenshot', {});
  server.setScreenshotDeps(screenshotStub({ width: 1280, height: 720, scrollY: 500 }));

  const first = await server.callTool('click', { x: 10, y: 10 });
  assert.equal(first.isError, true);
  assert.match(first.text, /scrolled/);
  const second = await server.callTool('click', { x: 10, y: 10 });
  assert.match(second.text, /scrolled/, 'the second refusal says what changed');
  assert.match(second.text, /click by element id/, 'and names the path that still works');

  // From here on the coordinate path is closed, with one message, whatever the page does.
  const third = await server.callTool('click', { x: 10, y: 10 });
  assert.equal(third.isError, true);
  assert.match(third.text, /coordinates cannot be trusted/);
  assert.match(third.text, /get_page_elements/);
});

test('the action delay from Settings is applied after a page action', async (t) => {
  const { server, runtime } = withPage(t);
  (runtime as any).settings = async () => ({ actionDelayMs: 150 });
  const slept: number[] = [];
  (runtime as any).clock = { now: () => 0, sleep: async (ms: number) => { slept.push(ms); } };
  await server.callTool('get_page_elements', {});
  const result = await server.callTool('click', { element_id: 1 });
  assert.equal(result.isError, undefined);
  assert.ok(slept.includes(150), `the click waited the configured delay (slept: ${slept.join(', ') || 'nothing'})`);
});

test('a click or a type on a bot check is refused, and the page is not touched', async (t) => {
  const { server, site, fc } = withPage(t);
  // The fake page's first element is renamed into a bot check, the way a challenge page lists it.
  const realGet = server.callTool.bind(server);
  const listed = await realGet('get_page_elements', {});
  const first = textOf(listed).split('\n')[0];
  (server as any).elementLines.get(101).set(1, first.replace(/"[^"]*"/, '"Verify you are human"'));
  const before = fc.callsTo('debugger.sendCommand').length + site.actions.length;
  const click = await server.callTool('click', { element_id: 1 });
  assert.equal(click.isError, true);
  assert.match(textOf(click), /bot check/i);
  assert.match(textOf(click), /Call finish/);
  const type = await server.callTool('type', { element_id: 1, text: 'x' });
  assert.equal(type.isError, true);
  assert.equal(fc.callsTo('debugger.sendCommand').length + site.actions.length, before, 'nothing reached the page');
});

/** Where the mouse was pressed by the coordinate clicks of a test, in viewport CSS pixels. */
function mousePresses(fc: any): Array<{ x: number; y: number }> {
  return fc.callsTo('debugger.sendCommand')
    .filter((call: any) => call.args[1] === 'Input.dispatchMouseEvent' && call.args[2]?.type === 'mousePressed')
    .map((call: any) => ({ x: call.args[2].x, y: call.args[2].y }));
}

test('a per-mille model clicks where it points: 0-1000 of the picture, and the 0-1 fraction form too', async (t) => {
  // Nemotron VL answers on a 0-1000 scale even when asked for pixels (measured in the click lab),
  // and now and then as a fraction of 1. Both must land on the same place of the page.
  const { fc, server } = withPage(t);
  server.setScreenshotDeps(screenshotStub({ width: 1280, height: 720 }));
  server.setCoordinateSpace('per-mille');
  const shot = await server.callTool('take_screenshot', {});
  assert.match(shot.text, /0-1000 scale/, 'the picture says how to point on it');

  const first = await server.callTool('click', { x: 500, y: 250 });
  assert.equal(first.isError, undefined, first.text);
  assert.match(first.text, /on the 0-1000 scale/);
  const second = await server.callTool('click', { x: 0.5, y: 0.25 });
  assert.equal(second.isError, undefined, second.text);
  assert.match(second.text, /fraction of the picture/);
  assert.deepEqual(mousePresses(fc), [{ x: 640, y: 180 }, { x: 640, y: 180 }]);
});

test('a pixel model is read as pixels, so (500, 250) stays (500, 250)', async (t) => {
  const { fc, server } = withPage(t);
  server.setScreenshotDeps(screenshotStub({ width: 1280, height: 720 }));
  await server.callTool('take_screenshot', {});
  const result = await server.callTool('click', { x: 500, y: 250 });
  assert.equal(result.isError, undefined, result.text);
  assert.deepEqual(mousePresses(fc), [{ x: 500, y: 250 }]);
});

test('the far edge of the 0-1000 scale is the last pixel, not one past the picture', async (t) => {
  const { fc, server } = withPage(t);
  server.setScreenshotDeps(screenshotStub({ width: 1280, height: 720 }));
  server.setCoordinateSpace('per-mille');
  await server.callTool('take_screenshot', {});
  const result = await server.callTool('click', { x: 1000, y: 1000 });
  assert.equal(result.isError, undefined, result.text);
  assert.deepEqual(mousePresses(fc), [{ x: 1279, y: 719 }]);
  const outside = await server.callTool('click', { x: 1200, y: 10 });
  assert.equal(outside.isError, true, 'past the end of the scale is outside the picture');
});

test('find ranks by the words of the query, so a question in words finds the element', () => {
  // Real lines from the NVIDIA runs: both queries found nothing as one substring, and each miss
  // cost a round and a full element list.
  const github = [
    '[1] a "Skip to content"',
    '[14] a "Code"',
    '[31] a "Releases 182" (href="/microsoft/playwright/releases")',
    '[32] a "v1.64.1 Latest"'
  ].join('\n');
  const releases = rankElementLines(github, 'Releases link or latest release');
  assert.equal(releases[0], '[31] a "Releases 182" (href="/microsoft/playwright/releases")');
  const python = ['[4] a "Docs"', '[14] a "Downloads"', '[15] a "All releases"'].join('\n');
  assert.deepEqual(rankElementLines(python, 'downloads page link'), ['[14] a "Downloads"']);
  assert.deepEqual(rankElementLines(python, 'Docs'), ['[4] a "Docs"'], 'a plain label still finds itself');
  assert.deepEqual(rankElementLines(python, 'checkout button'), [], 'and an absent target finds nothing');
});

/** The rig's tab load, like Chrome's: done once the fake has opened the new page. */
function realisticLoads(runtime: RunRuntime): void {
  (runtime.browser as any).waitForTabComplete = () => new Promise((resolve) => setTimeout(resolve, 5));
}

test('navigate returns the text of the page it opened, so the model needs no get_page_text round', async (t) => {
  const { server, runtime } = withPage(t);
  realisticLoads(runtime);
  const result = await server.callTool('navigate', { url: DETAIL_URL });
  assert.equal(result.isError, undefined, result.text);
  assert.match(result.text, /Navigated to https:\/\/shop\.test\/items\/42/);
  assert.match(result.text, /NOW ON: Item 42/);
  assert.match(result.text, /Item 42 costs 99 USD/, 'the page text is in the result');
});

test('a link click that does not change the page carries no page text, and says the link did not open', async (t) => {
  // The fake page cannot follow a CDP click, so the click stays on the page: its result must not
  // claim a new page, and must say the link did not open (a consent banner swallows clicks like
  // that). The click that opens one is checked on real Chromium (far-link, consent-link).
  const { server, runtime } = withPage(t);
  realisticLoads(runtime);
  await server.callTool('get_page_elements', {});
  const result = await server.callTool('click', { element_id: 1 });
  assert.equal(result.isError, undefined, result.text);
  assert.doesNotMatch(result.text, /NOW ON/);
  assert.match(result.text, /^Clicked element \[1\]\nNote: the link did not open its page \(\/items\/42\)/);
});
