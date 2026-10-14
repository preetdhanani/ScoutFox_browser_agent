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

test('5. doBrowserBatch enforces step bounds, forbidden actions, and accurate error reporting', async () => {
  const fakeWindow = {
    location: { href: 'https://example.com/' }
  };
  const executor = new ActionExecutor(undefined, fakeWindow as any);

  // Empty steps
  const emptyRes = await executor.doBrowserBatch([]);
  assert.equal(emptyRes.success, false);
  assert.match(emptyRes.error, /non-empty "steps"/);

  // Exceeds 8 steps
  const tooMany = Array.from({ length: 9 }, () => ({ action: 'scroll' }));
  const tooManyRes = await executor.doBrowserBatch(tooMany);
  assert.equal(tooManyRes.success, false);
  assert.match(tooManyRes.error, /maximum allowed 8 steps/);

  // Forbidden action in batch
  const forbiddenRes = await executor.doBrowserBatch([{ action: 'navigate', url: 'https://other.com' }]);
  assert.equal(forbiddenRes.success, false);
  assert.equal(forbiddenRes.results[0].ok, false);
  assert.match(forbiddenRes.results[0].error, /is forbidden inside browser_batch/);
});

test('6. read_page_text continues where the last read stopped instead of repeating the first chunk', async () => {
  // The live failure: a model on an arXiv feed page called read_page_text five times and got the
  // same first 1500 chars every time, because the prompt says "read more text of this page" while
  // the tool always returned the head of the text. The run burned 23 steps and never answered.
  const longText = Array.from({ length: 300 }, (_, i) => `Line ${i + 1} of the page text`).join('. ');
  const fakeWindow = {
    location: { href: 'https://export.arxiv.test/api/query?x=1' },
    domCompressor: { extractPageText: () => longText },
  };
  const executor = new ActionExecutor(undefined, fakeWindow as any);

  // The parts are line-bounded (here: cut at a space, the text is one line) and numbered "part i of n"
  // (silent-truncation-no-marker); the old reads were unnumbered 1500-character slices.
  const first = await executor.execute({ action: 'read_page_text' });
  assert.equal(first.success, true);
  const firstPos = first.message.match(/^Extracted text snippet \(\d+ chars, part 1 of (\d+), chars 1-(\d+)\):/);
  assert.ok(firstPos, `the first read says it is part 1 of n: ${first.message.slice(0, 80)}`);
  const count = Number(firstPos[1]);
  assert.equal(count, 3, 'an 8000-character text is read in three parts of at most 3000');
  assert.ok(first.message.includes('Line 1 of the page text'));
  assert.equal(first.result.pageText, longText.slice(0, Number(firstPos[2])));

  const second = await executor.execute({ action: 'read_page_text' });
  const secondPos = second.message.match(/part 2 of 3, chars (\d+)-(\d+)\)/);
  assert.ok(secondPos, second.message.slice(0, 120));
  assert.doesNotMatch(second.message, /end of the text/, 'part 2 is not the end');
  assert.equal(second.result.pageText, longText.slice(Number(secondPos[1]) - 1, Number(secondPos[2])));
  assert.notEqual(second.result.pageText, first.result.pageText, 'the second read shows new text');

  const third = await executor.execute({ action: 'read_page_text' });
  assert.match(third.message, new RegExp(`part 3 of 3, chars \\d+-${longText.length}, end of the text`));
  assert.ok(longText.endsWith(third.result.pageText));
  assert.equal([first, second, third].map((r) => r.result.pageText).join(' '), longText, 'the parts are the whole text');

  // After the end, the read starts over - and says so, or the model burns steps re-reading.
  const fourth = await executor.execute({ action: 'read_page_text' });
  assert.match(fourth.message, /whole text already shown/, 'a wrapped read says the text was already shown');
  assert.doesNotMatch(fourth.message, /part \d/, 'a wrapped read is not numbered as a next part');
  assert.equal(fourth.result.pageText, first.result.pageText);

  // A different URL starts the read over.
  const otherWindow = {
    location: { href: 'https://other.test/page' },
    domCompressor: { extractPageText: () => longText },
  };
  const otherExecutor = new ActionExecutor(undefined, otherWindow as any);
  const other = await otherExecutor.execute({ action: 'read_page_text' });
  assert.match(other.message, /part 1 of 3/);
  assert.doesNotMatch(other.message, /whole text already shown/);
  assert.equal(other.result.pageText, first.result.pageText);
});

test('7. read_page_text with element_id returns only that element\'s text', async () => {
  // The live failure: on a 25-result arXiv search page the full text is capped at 4500 chars, so
  // the model could only ever see result 1. It HALLUCINATED an element_id parameter for
  // read_page_text because it wanted exactly this tool. The element list is how it reads result
  // 2, 3, ... without the cap.
  const elements = new Map<number, any>();
  elements.set(7, {
    getBoundingClientRect: () => ({ top: 10, left: 20, width: 80, height: 30, right: 100, bottom: 40 }),
    innerText: 'arXiv:2610.02863 Multi-Agent AI as a Nested Principal-Agent Problem. Abstract: In private wealth management...',
  });
  const fakeWindow = {
    location: { href: 'https://arxiv.test/search' },
    domCompressor: { getElement: (id: number) => elements.get(id) || null },
  };
  const fakeDocument = { contains: () => true };
  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);

  const scoped = await executor.execute({ action: 'read_page_text', element_id: 7 });
  assert.equal(scoped.success, true);
  assert.match(scoped.message, /^Text of element \[7\] \(\d+ chars\):/);
  assert.ok(scoped.message.includes('Nested Principal-Agent Problem'));
  assert.equal(scoped.result.pageText, elements.get(7).innerText);

  // An id that is not on the page is an error that names the way out, not a wrong read.
  const missing = await executor.execute({ action: 'read_page_text', element_id: 99 });
  assert.equal(missing.success, false);
  assert.match(missing.error, /not on this page's element list/);

  // Without element_id the page-level chunked read is unchanged.
  const pageRead = await executor.execute({ action: 'read_page_text' });
  assert.equal(pageRead.success, true);
  assert.match(pageRead.message, /^Extracted text snippet/);
});

// silent-truncation-no-marker: read_page_text paged the snapshot text, which the extractor had already cut at 4500
// characters, so nothing past 4500 could ever be read, and the parts did not say how many there were.
test('8. read_page_text pages the whole extracted text, past the snapshot cap, and every part states its position', async () => {
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
    const res = await executor.execute({ action: 'read_page_text' });
    assert.equal(res.success, true);
    const m = res.message.match(/part (\d+) of (\d+), chars (\d+)-(\d+)/);
    assert.ok(m, `part ${i} states its position: ${res.message.slice(0, 120)}`);
    assert.equal(Number(m[1]), i);
    total = Number(m[2]);
    assert.equal(res.result.note, res.message.match(/^Extracted text snippet \((.*)\):\n/)?.[1], 'the note travels with the result');
    chunks.push(res.result.pageText);
    if (/end of the text/.test(res.message)) break;
  }
  assert.equal(chunks.length, total, 'the read stops at the last part');
  assert.equal(chunks.join('\n'), full, 'every character of the page is reachable');
  assert.ok(chunks.join('\n').includes('Offer 400:'), 'the end of the page is reachable');

  const wrapped = await executor.execute({ action: 'read_page_text' });
  assert.match(wrapped.message, /whole text already shown - do not read this page again/);
  assert.match(wrapped.result.note, /whole text already shown/);
});

test('9. read_page_text with element_id marks a cut element text with its full size', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `Result ${i + 1} title and abstract words`).join('\n');
  assert.ok(long.length > 2000);
  const elements = new Map<number, any>([[3, { innerText: long }]]);
  const fakeWindow = { location: { href: 'https://arxiv.test/search' }, domCompressor: { getElement: (id: number) => elements.get(id) || null } };
  const executor = new ActionExecutor({ contains: () => true } as any, fakeWindow as any);
  const scoped = await executor.execute({ action: 'read_page_text', element_id: 3 });
  assert.equal(scoped.success, true);
  assert.match(scoped.result.pageText, new RegExp(`\\n\\[element text truncated: showing \\d+ of ${long.length} characters - [^\\]]+\\]$`));
  assert.ok(scoped.message.includes('[element text truncated: showing'));
});
