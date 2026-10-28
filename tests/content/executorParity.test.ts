import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor } from '../../src/content/actionExecutor.ts';
import { ACCENT_COLOR } from '../../src/content/badges.ts';

test('1. renderBadges and removeBadges manage floating badges correctly', () => {
  const elements = new Map<number, any>();
  const btn1 = {
    getBoundingClientRect: () => ({ top: 10, left: 20, width: 80, height: 30, right: 100, bottom: 40 })
  };
  elements.set(1, btn1);

  const createdElements: any[] = [];
  const bodyChildren: any[] = [];
  const body = {
    appendChild: (el: any) => bodyChildren.push(el),
    contains: (el: any) => bodyChildren.includes(el)
  };

  const fakeDocument = {
    body,
    getElementById: (id: string) => bodyChildren.find((el) => el.id === id) || null,
    createElement: (tag: string) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        appendChild: (child: any) => el.children.push(child),
        remove: () => {
          const idx = bodyChildren.indexOf(el);
          if (idx >= 0) bodyChildren.splice(idx, 1);
        }
      };
      createdElements.push(el);
      return el;
    }
  };

  const fakeWindow = {
    domCompressor: { getElement: (id: number) => elements.get(id) || null },
    scrollY: 100,
    scrollX: 50
  };

  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);
  executor.renderBadges([{ id: 1 }]);

  assert.ok(executor.badgeContainer, 'badgeContainer must be created');
  assert.equal(executor.badgeContainer!.id, 'scoutfox-badge-container');
  assert.equal(executor.badgeContainer!.style.zIndex, '2147483647');

  const children = (executor.badgeContainer as any).children;
  assert.equal(children.length, 1);
  const badge = children[0];
  assert.equal(badge.className, 'scoutfox-badge');
  assert.equal(badge.textContent, '1');
  assert.equal(badge.style.backgroundColor, ACCENT_COLOR);
  assert.equal(badge.style.top, '110px'); // top 10 + scrollY 100
  assert.equal(badge.style.left, '70px'); // left 20 + scrollX 50

  executor.removeBadges();
  assert.equal(executor.badgeContainer, null);
  assert.equal(bodyChildren.length, 0);
});

test('2. ensureCursorOverlay, animateCursor, and showClickEffect produce correct overlay structure', () => {
  const bodyChildren: any[] = [];
  const body = {
    appendChild: (el: any) => bodyChildren.push(el),
    contains: (el: any) => bodyChildren.includes(el)
  };

  const fakeDocument = {
    body,
    documentElement: body,
    getElementById: (id: string) => bodyChildren.find((el) => el.id === id) || null,
    createElement: (tag: string) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        appendChild: (child: any) => {
          el.children.push(child);
          bodyChildren.push(child);
        },
        remove: () => {
          const idx = bodyChildren.indexOf(el);
          if (idx >= 0) bodyChildren.splice(idx, 1);
        }
      };
      return el;
    }
  };

  const executor = new ActionExecutor(fakeDocument as any, { scrollY: 0 } as any);
  executor.ensureCursorOverlay();

  assert.ok(executor.cursorContainer);
  assert.equal(executor.cursorContainer!.id, 'scoutfox-cursor-container');
  assert.ok(executor.cursorEl);
  assert.equal(executor.cursorEl!.id, 'scoutfox-cursor-pointer');
  assert.match(executor.cursorEl!.innerHTML, /<svg/);
  assert.match(executor.cursorEl!.innerHTML, /#ff7a00/);

  executor.animateCursor(150, 250);
  assert.equal(executor.cursorEl!.style.opacity, '1');
  assert.match(executor.cursorEl!.style.transform, /translate\(150px, 250px\)/);

  executor.showClickEffect(150, 250);
  assert.ok(executor.cursorFadeTimer);

  executor.removeCursorOverlay();
  assert.equal(executor.cursorContainer, null);
  assert.equal(executor.cursorEl, null);
  assert.equal(executor.cursorFadeTimer, null);
});

test('3. doClick dispatches PointerEvent and MouseEvent sequence when PointerEvent is available', () => {
  const dispatched: string[] = [];

  class MockPointerEvent {
    type: string;
    clientX: number;
    clientY: number;
    constructor(type: string, init: any = {}) {
      this.type = type;
      this.clientX = init.clientX;
      this.clientY = init.clientY;
    }
  }

  class MockMouseEvent {
    type: string;
    clientX: number;
    clientY: number;
    constructor(type: string, init: any = {}) {
      this.type = type;
      this.clientX = init.clientX;
      this.clientY = init.clientY;
    }
  }

  let clicked = false;
  const btn = {
    tagName: 'BUTTON',
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 50, height: 20 }),
    dispatchEvent: (ev: any) => dispatched.push(ev.type),
    click: () => { clicked = true; },
    scrollIntoView: () => {},
    focus: () => {},
    style: {}
  };

  const fakeWindow = {
    domCompressor: { getElement: () => btn },
    scrollY: 0,
    PointerEvent: MockPointerEvent,
    MouseEvent: MockMouseEvent
  };

  const fakeDocument = {
    contains: () => true,
    createElement: () => ({ style: {}, appendChild: () => {}, remove: () => {} }),
    body: { appendChild: () => {}, contains: () => false },
    getElementById: () => null
  };

  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);
  const res = executor.doClick(1);

  assert.equal(res.success, true);
  assert.equal(clicked, true);
  // PointerEvents fire first, then MouseEvents
  assert.ok(dispatched.includes('pointerenter'));
  assert.ok(dispatched.includes('pointerover'));
  assert.ok(dispatched.includes('pointerdown'));
  assert.ok(dispatched.includes('pointerup'));
  assert.ok(dispatched.includes('mouseenter'));
  assert.ok(dispatched.includes('mouseover'));
  assert.ok(dispatched.includes('mousedown'));
  assert.ok(dispatched.includes('mouseup'));
});

test('4. setFieldValue handles select, input/textarea via prototype setter, and contenteditable', () => {
  const executor = new ActionExecutor();

  // Select element
  const selectDispatched: string[] = [];
  const selectEl = {
    tagName: 'SELECT',
    value: 'opt1',
    options: [
      { value: 'opt1', textContent: 'Option 1' },
      { value: 'opt2', textContent: 'Option 2' }
    ],
    dispatchEvent: (ev: any) => selectDispatched.push(ev.type)
  };
  const selRes = executor.setFieldValue(selectEl as any, 'Option 2');
  assert.equal(selRes.success, true);
  assert.equal(selectEl.value, 'opt2');
  assert.deepEqual(selectDispatched, ['input', 'change']);

  // Missing select option returns error
  const selMissing = executor.setFieldValue(selectEl as any, 'Nonexistent');
  assert.equal(selMissing.success, false);
  assert.match(selMissing.error!, /No option matching "Nonexistent"/);

  // Contenteditable
  const editDispatched: string[] = [];
  const editEl = {
    tagName: 'DIV',
    isContentEditable: true,
    textContent: '',
    dispatchEvent: (ev: any) => editDispatched.push(ev.type)
  };
  const editRes = executor.setFieldValue(editEl as any, 'Hello world');
  assert.equal(editRes.success, true);
  assert.equal(editEl.textContent, 'Hello world');
  assert.deepEqual(editDispatched, ['input', 'change']);

  // Unsupported element
  const spanEl = {
    tagName: 'SPAN',
    getAttribute: () => null
  };
  const spanRes = executor.setFieldValue(spanEl as any, 'Text');
  assert.equal(spanRes.success, false);
  assert.match(spanRes.error!, /cannot be typed into/);
});

test('5. the content executor has no synthetic press_key and no browser_batch: those verbs are unknown here', async () => {
  const executor = new ActionExecutor(undefined, { location: { href: 'https://example.com/' } } as any);
  for (const action of ['press_key', 'keypress', 'browser_batch']) {
    await assert.rejects(executor.execute({ action, key: 'Enter', steps: [] }), new RegExp(`Unknown action: ${action}`));
  }
});

test('6. read_page is stateless: the part the request names, the same text for the same part, never a hidden cursor', async () => {
  // The live failure: a model called the old read tool again and again and got the same first
  // part every time (or, with a hidden cursor, a part it could not name). Now the part is in the
  // request and the result says which part it is and how to get the next.
  const longText = Array.from({ length: 300 }, (_, i) => `Line ${i + 1} of the page text`).join('. ');
  const fakeWindow = {
    location: { href: 'https://export.arxiv.test/api/query?x=1' },
    domCompressor: { extractFullPageText: () => longText },
  };
  const executor = new ActionExecutor(undefined, fakeWindow as any);

  const first = await executor.execute({ action: 'read_page' });
  assert.equal(first.success, true);
  const firstPos = first.message.match(/^Page text \(part 1 of (\d+), chars 1-(\d+) of (\d+), next: read_page with part 2\):/);
  assert.ok(firstPos, `the first read says it is part 1 of n and how to go on: ${first.message.slice(0, 120)}`);
  assert.equal(Number(firstPos[1]), 3, 'an 8000-character text is read in three parts of at most 3000');
  assert.equal(first.result.pageText, longText.slice(0, Number(firstPos[2])));
  assert.deepEqual([first.result.part, first.result.parts], [1, 3]);

  const again = await executor.execute({ action: 'read_page', part: 1 });
  assert.equal(again.result.pageText, first.result.pageText, 'part 1 again is part 1: no hidden cursor');

  const second = await executor.execute({ action: 'read_page', part: 2 });
  const secondPos = second.message.match(/part 2 of 3, chars (\d+)-(\d+) of \d+, next: read_page with part 3/);
  assert.ok(secondPos, second.message.slice(0, 120));
  assert.equal(second.result.pageText, longText.slice(Number(secondPos[1]) - 1, Number(secondPos[2])));

  const third = await executor.execute({ action: 'read_page', part: 3 });
  assert.match(third.message, new RegExp(`part 3 of 3, chars \\d+-${longText.length} of ${longText.length}, end of the text`));
  assert.equal([first, second, third].map((r) => r.result.pageText).join(' '), longText, 'the parts are the whole text');

  const past = await executor.execute({ action: 'read_page', part: 4 });
  assert.equal(past.success, false);
  assert.match(past.error, /has only 3 parts, so there is no part 4/);
  for (const bad of [0, -1, 1.5, 'two']) {
    const res = await executor.execute({ action: 'read_page', part: bad });
    assert.equal(res.success, false, String(bad));
    assert.match(res.error, /part must be a whole number from 1 up/);
  }
});

test('7. read_page with element_id returns only that element\'s text, paged the same way', async () => {
  // On a 25-result search page the page text is long, so the model reads result 2, 3, ... by the
  // element id of each result instead of paging through everything.
  const elements = new Map<number, any>();
  elements.set(7, {
    getBoundingClientRect: () => ({ top: 10, left: 20, width: 80, height: 30, right: 100, bottom: 40 }),
    innerText: 'arXiv:2610.02863 Multi-Agent AI as a Nested Principal-Agent Problem. Abstract: In private wealth management...',
  });
  const fakeWindow = {
    location: { href: 'https://arxiv.test/search' },
    domCompressor: { getElement: (id: number) => elements.get(id) || null, extractFullPageText: () => 'The whole search page' },
  };
  const fakeDocument = { contains: () => true };
  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);

  const scoped = await executor.execute({ action: 'read_page', element_id: 7 });
  assert.equal(scoped.success, true);
  assert.match(scoped.message, /^Text of element \[7\] \(part 1 of 1, chars 1-\d+ of \d+, end of the text\):/);
  assert.equal(scoped.result.pageText, elements.get(7).innerText);

  // An id that is not on the page is an error that names the way out, not a wrong read.
  const missing = await executor.execute({ action: 'read_page', element_id: 99 });
  assert.equal(missing.success, false);
  assert.match(missing.error, /not on this page's element list/);

  const pageRead = await executor.execute({ action: 'read_page' });
  assert.equal(pageRead.success, true);
  assert.match(pageRead.message, /^Page text \(part 1 of 1/);
  assert.equal(pageRead.result.pageText, 'The whole search page');
});

// silent-truncation-no-marker: the read used to page the snapshot text, which the extractor had already cut at 4500
// characters, so nothing past 4500 could ever be read, and the parts did not say how many there were.
test('8. read_page pages the whole extracted text, past the snapshot cap, and every part states its position', async () => {
  const full = Array.from({ length: 400 }, (_, i) => `Offer ${i + 1}: seller name, price and shipping line`).join('\n');
  assert.ok(full.length > 12000);
  const capped = `${full.slice(0, 4500)}\n[page text truncated at 4500 characters]`;
  const fakeWindow = {
    location: { href: 'https://offers.test/list' },
    domCompressor: { extractPageText: () => capped, extractFullPageText: () => full },
  };
  const executor = new ActionExecutor(undefined, fakeWindow as any);

  const chunks: string[] = [];
  let total = 0;
  for (let i = 1; i <= 40; i++) {
    const res = await executor.execute({ action: 'read_page', part: i });
    assert.equal(res.success, true);
    const m = res.message.match(/part (\d+) of (\d+), chars (\d+)-(\d+)/);
    assert.ok(m, `part ${i} states its position: ${res.message.slice(0, 120)}`);
    assert.equal(Number(m[1]), i);
    total = Number(m[2]);
    assert.equal(res.result.note, res.message.match(/^Page text \((.*)\):\n/)?.[1], 'the note travels with the result');
    chunks.push(res.result.pageText);
    if (/end of the text/.test(res.message)) break;
  }
  assert.equal(chunks.length, total, 'the read stops at the last part');
  assert.equal(chunks.join('\n'), full, 'every character of the page is reachable');
  assert.ok(chunks.join('\n').includes('Offer 400:'), 'the end of the page is reachable');
});

test('9. read_page with element_id pages a long element text instead of cutting it', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `Result ${i + 1} title and abstract words`).join('\n');
  assert.ok(long.length > 3000);
  const elements = new Map<number, any>([[3, { innerText: long }]]);
  const fakeWindow = { location: { href: 'https://arxiv.test/search' }, domCompressor: { getElement: (id: number) => elements.get(id) || null } };
  const executor = new ActionExecutor({ contains: () => true } as any, fakeWindow as any);
  const first = await executor.execute({ action: 'read_page', element_id: 3 });
  assert.match(first.message, /part 1 of 2, .*next: read_page with part 2/);
  const second = await executor.execute({ action: 'read_page', element_id: 3, part: 2 });
  assert.match(second.message, /part 2 of 2, .*end of the text/);
  assert.equal(`${first.result.pageText}\n${second.result.pageText}`, long, 'nothing of the element is lost');
});

test('10. read_page reads a CodeMirror editor from .cm-content, and says when it hides off-screen lines', async () => {
  // A CodeMirror 6 editor draws only the lines near the view and stands a .cm-gap in for the rest.
  const gap = { className: 'cm-gap' };
  const content = {
    innerText: 'import os\nprint(os.getcwd())',
    querySelector: (sel: string) => (sel === '.cm-gap' ? gap : null),
    closest: (sel: string) => (sel === '.cm-content' ? content : null),
  };
  const line = { innerText: 'print(os.getcwd())', closest: (sel: string) => (sel === '.cm-content' ? content : null) };
  const elements = new Map<number, any>([[4, line]]);
  const fakeDocument = { contains: () => true, querySelector: (sel: string) => (sel === '.cm-content .cm-gap' ? gap : null) };
  const fakeWindow = { location: { href: 'https://lab.test/' }, domCompressor: { getElement: (id: number) => elements.get(id) || null, extractFullPageText: () => 'In [1]:\nimport os' } };
  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);

  const cell = await executor.execute({ action: 'read_page', element_id: 4 });
  assert.equal(cell.result.pageText, 'import os\nprint(os.getcwd())', 'a line of the editor reads the whole editor content');
  assert.match(cell.message, /\(editor may hide off-screen lines\)/);
  assert.equal(cell.result.hidesLines, true);

  const page = await executor.execute({ action: 'read_page' });
  assert.match(page.message, /^Page text \(part 1 of 1, [^)]*\):\nNote: a code editor here draws only the lines near the view \(editor may hide off-screen lines\)/);
  assert.equal(page.result.hidesLines, true);
  assert.doesNotMatch(page.result.note, /editor/, 'the part note stays the part note');

  const plain = new ActionExecutor({ contains: () => true, querySelector: () => null } as any, fakeWindow as any);
  const quiet = await plain.execute({ action: 'read_page' });
  assert.doesNotMatch(quiet.message, /editor may hide/, 'a page whose editors draw every line says nothing');
});
