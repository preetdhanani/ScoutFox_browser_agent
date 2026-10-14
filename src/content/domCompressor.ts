/**
 * ScoutFox DOMCompressor Class
 * Extracts interactive elements from the webpage and produces a concise structured snapshot.
 * Preserves the instance method dispatch seam for all callers and tamper scripts.
 */

import {
  extractPageTextFromDocument,
  extractFullPageTextFromDocument,
  finishPageText,
  collapseRepeatedRuns,
  capPageText,
  PAGE_TEXT_CAP
} from './pageText.ts';
import {
  generateDocId,
  getElementFromMap,
  resolveElementWithStatus,
  type ElementMap,
  type ResolveElementResult
} from './refMap.ts';
import {
  computeRole,
  computeFieldKind,
  computeFormKind,
  computeHrefDomain,
  getElementSummary as formatElementSummary,
  getFocusedElementInfo,
  type FormattedElement,
  type ElementInfoRecord
} from './perception.ts';
import {
  getCssPath,
  findInteractiveElements,
  isVisible,
  orderByViewport
} from './snapshot.ts';

export interface SnapshotOptions {
  maxElements?: number;
  withElementInfo?: boolean;
  showBadges?: boolean;
}

export interface ScrollState {
  scrollY: number;
  pageHeight: number;
  viewportHeight: number;
}

export interface DomSnapshot {
  title: string;
  url: string;
  domain: string;
  scrollState: ScrollState;
  elementCount: number;
  /** How many of the elementCount elements the list cap cut; 0 when everything fit. */
  omittedCount: number;
  elementsText: string;
  elements: FormattedElement[];
  refs: number[];
  shownRefs: number[];
  elementInfo: Record<string | number, ElementInfoRecord>;
  /** What has focus (press_key acts on it), for the risk gate; null when nothing does. */
  focused: ElementInfoRecord | null;
  pageText: string;
}

/** The last line of elementsText when the cap cut elements: the size of what is missing. */
export function omittedElementsNote(omitted: number): string {
  return `[+${omitted} more interactive elements not listed - scroll to bring them into view]`;
}

export class DOMCompressor {
  elementMap: ElementMap;
  counter: number;
  docId: string;
  elements?: FormattedElement[];
  elementInfo: Record<string | number, ElementInfoRecord>;

  constructor() {
    this.elementMap = new Map();
    this.counter = 0;
    this.docId = this.generateDocId();
    this.elementInfo = {};
  }

  generateDocId(): string {
    return generateDocId(typeof crypto !== 'undefined' ? crypto : undefined);
  }

  getSnapshot(options: SnapshotOptions = {}): DomSnapshot {
    const maxElements = options.maxElements || 120;
    this.elementMap.clear();
    this.elementInfo = {};
    this.counter = 0;
    this.docId = this.docId || this.generateDocId();

    const doc = typeof document !== 'undefined' ? document : undefined;
    const win = typeof window !== 'undefined' ? window : undefined;

    const interactiveElements = this.findInteractiveElements();
    // Viewport-first window: in-viewport elements in document order, then the off-screen ones by
    // distance to the viewport, cut at the cap. Scrolling moves the window instead of the cap
    // always keeping the top of the document (docs/langgraph-design.md, element window order).
    const ordered = orderByViewport(interactiveElements, win);
    const listed = ordered.slice(0, maxElements);
    const omittedCount = ordered.length - listed.length;

    const formattedElements: FormattedElement[] = [];

    for (const el of listed) {
      this.counter++;
      const id = this.counter;
      if (typeof WeakRef !== 'undefined') {
        this.elementMap.set(id, new WeakRef(el));
      } else {
        this.elementMap.set(id, el);
      }

      el.setAttribute('data-agent-id', String(id));
      const info = this.getElementSummary(el, id);
      formattedElements.push(info);
    }

    const title = (doc && doc.title) || 'Untitled Page';
    const url = (win && win.location && win.location.href) || '';
    const scrollY = Math.round((win && win.scrollY) || 0);
    const pageHeight = Math.round((doc && doc.documentElement && doc.documentElement.scrollHeight) || 0);
    const viewportHeight = (win && win.innerHeight) || 0;

    this.elements = formattedElements;

    const refs = formattedElements.map((e) => e.id);
    const shownRefs = refs.slice();
    let domain = '';
    try {
      domain = (win && win.location && win.location.hostname) || '';
    } catch {
      // Ignored
    }

    const elementLines = formattedElements.map((e) => e.formatted);
    const elementsText = omittedCount > 0
      ? [...elementLines, omittedElementsNote(omittedCount)].join('\n')
      : elementLines.join('\n');

    return {
      title,
      url,
      domain,
      scrollState: { scrollY, pageHeight, viewportHeight },
      elementCount: interactiveElements.length,
      omittedCount,
      elementsText,
      elements: formattedElements,
      refs,
      shownRefs,
      elementInfo: this.elementInfo || {},
      focused: getFocusedElementInfo(doc, win),
      pageText: this.extractPageText()
    };
  }

  extractPageText(): string {
    const doc = typeof document !== 'undefined' ? document : undefined;
    const win = typeof window !== 'undefined' ? window : undefined;
    return extractPageTextFromDocument(doc, win);
  }

  /** The whole page text, with no cap and no window: what read_page_text pages through. */
  extractFullPageText(): string {
    const doc = typeof document !== 'undefined' ? document : undefined;
    const win = typeof window !== 'undefined' ? window : undefined;
    return extractFullPageTextFromDocument(doc, win);
  }

  finishPageText(text: string): string {
    return finishPageText(text);
  }

  collapseRepeatedRuns(text: string): string {
    return collapseRepeatedRuns(text);
  }

  capPageText(text: string, cap = PAGE_TEXT_CAP, total = text.length): string {
    return capPageText(text, cap, total);
  }

  getElement(id: number | string): Element | null {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return getElementFromMap(this.elementMap, id, doc);
  }

  resolveElementWithStatus(id: number | string, expectedDocId?: string): ResolveElementResult {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return resolveElementWithStatus(this.elementMap, id, this.docId, expectedDocId, doc);
  }

  getCssPath(el: Element): string {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return getCssPath(el, doc);
  }

  findInteractiveElements(): Element[] {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return findInteractiveElements(doc);
  }

  isVisible(el: Element): boolean {
    return isVisible(el);
  }

  computeRole(el: Element, tagName: string, type: string): string {
    return computeRole(el, tagName, type);
  }

  computeFieldKind(el: Element, tagName: string, type: string): string | undefined {
    return computeFieldKind(el, tagName, type);
  }

  computeFormKind(el: Element): string | undefined {
    return computeFormKind(el);
  }

  computeHrefDomain(el: Element, tagName: string): string | undefined {
    const win = typeof window !== 'undefined' ? window : undefined;
    return computeHrefDomain(el, tagName, win && win.location ? win.location.href : undefined);
  }

  getElementSummary(el: Element, id: number): FormattedElement {
    const win = typeof window !== 'undefined' ? window : undefined;
    const { summary, info } = formatElementSummary(el, id, (element) => this.getCssPath(element), win);
    this.elementInfo = this.elementInfo || {};
    this.elementInfo[id] = info;
    return summary;
  }
}
