/**
 * DOMCompressor - Extracts interactive elements from the webpage and produces a concise,
 * clean structured snapshot optimized for small LLMs (8B, 9B, 27B, 32B).
 * Encapsulated in an IIFE to prevent V8 parse-time redeclaration errors upon re-injection.
 */

(function() {
  // ---------------------------------------------------------------------------------------------
  // Repeated text
  //
  // extractPageText() reads textContent, which also holds hidden markup, so a page can hand it the
  // same few words again and again. On frame.work's laptop configurator every option <li> was about
  // 5000 characters of "Batch 1 Shipped Batch 2 Shipped Batch 3 Ships December - Sold Out ..." (the
  // list once where people see it, then in several hidden copies). That filled the whole cap, so the
  // price, the shipping and the delivery text never reached the model, and read_page_text returns the
  // same text, so the model could not get past it. collapseRepeatedRuns() shortens such runs before
  // the cap is applied.
  // ---------------------------------------------------------------------------------------------
  const PAGE_TEXT_CAP = 4500;
  // How much text is searched for repeats. Bounds the work on a page with megabytes of text.
  const PAGE_TEXT_SCAN_LIMIT = 1000000;
  // A run needs this many identical units in a row. Fewer are a short list, and stay as they are.
  const REPEAT_MIN_RUN = 4;
  // The longest unit, in words. A cycle of runs ("9 shipped, 7 sold out, 1 Q1") is one unit on the
  // second pass, after its runs are short.
  const REPEAT_MAX_UNIT_WORDS = 64;
  // Each pass shortens the text or stops, this only bounds the work.
  const REPEAT_MAX_PASSES = 4;
  // A unit that holds no letter ("1 2 3 4", "- - - -") is numbers or a separator, not an entry.
  const HAS_LETTER = /\p{L}/u;
  // When the digits of a run carry a price or a lead time, dropping the middle of the run would
  // drop information, so such a run is kept whole. "Ships" and "Shipped" are deliberately not
  // here: "Batch 3 Ships December - Sold Out" is a batch status, not a shipping cost or lead time,
  // and it is exactly the noise this exists for.
  const PRICE_LIKE = /[€$£¥₹]\s?\d|\d\s?(?:[€$£¥₹]|EUR\b|USD\b|GBP\b|CHF\b|CAD\b|AUD\b|Euro\b)/i;
  const DELIVERY_LIKE = /\b(?:shipping|shipment\w*|deliver\w*|arriv\w*|versand\w*|liefer\w*|werktag\w*|business days?|working days?|porto)\b/i;

  /**
   * One pass: finds runs of REPEAT_MIN_RUN or more identical units (the same words after masking
   * digits, each unit 1 to REPEAT_MAX_UNIT_WORDS words, line breaks ignored) and replaces each run by
   *   - "unit (repeated N times)" when every unit is word for word the same, which loses nothing,
   *   - "first ... last (N similar entries)" when only digits differ,
   *   - nothing at all (the run stays) when the digits differ and carry a price or a delivery time,
   *     or when the replacement would not be shorter than the run.
   * Everything outside the runs keeps its words and its white space.
   */
  function collapseRepeatedRunsOnce(text) {
    const lead = text.match(/^\s*/)[0];
    const words = [];
    const gaps = []; // gaps[i] is the white space after words[i]
    for (const [, word, gap] of text.matchAll(/(\S+)(\s*)/g)) {
      words.push(word);
      gaps.push(gap);
    }
    const n = words.length;
    if (n < REPEAT_MIN_RUN) return text;
    const shapes = words.map((word) => word.replace(/\d+/g, '#'));

    const sameShape = (a, b, size) => {
      for (let t = 0; t < size; t++) {
        if (shapes[a + t] !== shapes[b + t]) return false;
      }
      return true;
    };
    // The unit of `size` words that starts at word `start`, without the white space after it.
    const unitText = (start, size) => {
      let out = '';
      for (let t = 0; t < size; t++) out += words[start + t] + (t < size - 1 ? gaps[start + t] : '');
      return out;
    };
    // The run at word `i` that covers the most words, the smaller unit when two cover the same (so
    // "Batch 1 Shipped" x 8 is one run of 8, not two of 4). Taking the first unit that repeats would
    // take the inner run of a repeated cycle and leave the cycle itself cut at the wrong place.
    // `skip` is how many words a run without letters covers there, so that a long "1 2 3 4 ..." is
    // passed once and not searched again from every word of it.
    const runAt = (i) => {
      let best = { size: 0, count: 0 };
      let skip = 0;
      const longest = Math.min(REPEAT_MAX_UNIT_WORDS, Math.floor((n - i) / REPEAT_MIN_RUN));
      for (let size = 1; size <= longest; size++) {
        let count = 1;
        while (i + (count + 1) * size <= n && sameShape(i, i + count * size, size)) count++;
        if (count < REPEAT_MIN_RUN) continue;
        if (!HAS_LETTER.test(unitText(i, size))) {
          skip = Math.max(skip, size * count);
        } else if (size * count > best.size * best.count) {
          best = { size, count };
        }
      }
      return { ...best, skip };
    };

    const out = [lead];
    let i = 0;
    while (i < n) {
      const { size, count, skip } = runAt(i);
      if (size === 0) {
        const stay = Math.max(1, skip);
        for (let t = 0; t < stay; t++) out.push(words[i + t], gaps[i + t]);
        i += stay;
        continue;
      }

      const end = i + size * count; // the word after the run
      const first = unitText(i, size);
      let identical = true;
      for (let u = 1; u < count && identical; u++) identical = unitText(i + u * size, size) === first;

      let summary = null;
      if (identical) summary = `${first} (repeated ${count} times)`;
      else if (!PRICE_LIKE.test(first) && !DELIVERY_LIKE.test(first)) summary = `${first} ... ${unitText(end - size, size)} (${count} similar entries)`;

      let runLength = words[end - 1].length;
      for (let t = i; t < end - 1; t++) runLength += words[t].length + gaps[t].length;
      if (summary !== null && summary.length < runLength) {
        out.push(summary, gaps[end - 1]);
      } else {
        for (let t = i; t < end; t++) out.push(words[t], gaps[t]);
      }
      i = end;
    }
    return out.join('');
  }

  class DOMCompressor {
    constructor() {
      this.elementMap = new Map(); // Maps numeric ID to DOM Element reference (WeakRef if supported)
      this.counter = 0;
      this.docId = this.generateDocId();
    }

    generateDocId() {
      try {
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          const buf = new Uint32Array(2);
          crypto.getRandomValues(buf);
          return `${buf[0].toString(36)}-${buf[1].toString(36)}`;
        }
      } catch (_) {}
      return Math.random().toString(36).slice(2);
    }

    /**
     * Main method to generate DOM snapshot
     */
    getSnapshot(options = {}) {
      const maxElements = options.maxElements || 120;
      this.elementMap.clear();
      this.elementInfo = {};
      this.counter = 0;
      this.docId = this.docId || this.generateDocId();

      const interactiveElements = this.findInteractiveElements();
      const formattedElements = [];

      for (const el of interactiveElements) {
        if (this.counter >= maxElements) break;

        this.counter++;
        const id = this.counter;
        if (typeof WeakRef !== 'undefined') {
          this.elementMap.set(id, new WeakRef(el));
        } else {
          this.elementMap.set(id, el);
        }

        // Store ID on element attribute for visual highlighting
        el.setAttribute('data-agent-id', id);

        const info = this.getElementSummary(el, id);
        formattedElements.push(info);
      }

      const title = document.title || 'Untitled Page';
      const url = window.location.href;
      const scrollY = Math.round(window.scrollY);
      const pageHeight = Math.round(document.documentElement.scrollHeight);
      const viewportHeight = window.innerHeight;

      // actionExecutor.js's resolveElement() falls back to this cache (by #id, cssPath, or
      // tag+text) when an element's live reference has gone stale - but this snapshot object
      // was only ever returned, never stored on the instance, so that fallback chain has always
      // read `compressor.elements` as undefined and returned null immediately. Stable-locator
      // re-resolution has never actually run; only the live-reference tier ever worked.
      this.elements = formattedElements;

      const result = {
        title,
        url,
        scrollState: { scrollY, pageHeight, viewportHeight },
        elementCount: formattedElements.length,
        elementsText: formattedElements.map(e => e.formatted).join('\n'),
        elements: formattedElements,
        pageText: this.extractPageText()
      };
      if (options && options.withElementInfo) {
        result.elementInfo = this.elementInfo || {};
      }
      return result;
    }

    /**
     * Dedicated Scroll-Aware Text Body Extraction Module
     * Extracts readable text content relative to current scroll viewport or full document.
     */
    extractPageText() {
      try {
        // 1. Raw Markdown / Plain Text Pages (e.g. raw.githubusercontent.com)
        //
        // document.contentType for an ORDINARY rendered HTML page is "text/html" - which also
        // starts with "text/". A bare .startsWith('text/') check therefore matched every
        // normal web page, not just genuinely raw text/markdown files, and returned early with
        // unstructured innerText before ever reaching the targeted-container selection,
        // heading-aware formatting, or the scroll-viewport-aware extraction below - all of
        // which never actually ran on a real page as a result. Excluding the structured
        // document types (html, xml) that also happen to start with "text/" is what makes this
        // check match only what its own name says: raw markdown/plain text, not rendered HTML.
        const rawContentType = document.contentType && document.contentType.startsWith('text/')
          && document.contentType !== 'text/html' && document.contentType !== 'text/xml';
        if (window.location.hostname.includes('raw.githubusercontent.com') || rawContentType) {
          const rawText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          // The text of a raw markdown or plain text file IS the content (a log, a table, source), so
          // it is capped and marked but never collapsed.
          return this.capPageText(rawText.trim());
        }

        // 2. Targeted Article / README / Documentation Containers
        const targetedContainer = document.querySelector('article, main, #readme, .markdown-body, [role="main"]');
        const container = targetedContainer || document.body;
        if (!container) return '';

        // Extract headings, paragraphs, list items, table text, and code snippets
        const allTextNodes = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, code, blockquote'));
        
        let textNodes = allTextNodes;

        // If page is scrolled down, filter nodes to current viewport window so scrolling reveals new text
        if (window.scrollY > 200 && allTextNodes.length > 30) {
          const vHeight = window.innerHeight || 800;
          textNodes = allTextNodes.filter(node => {
            const rect = node.getBoundingClientRect();
            return rect.bottom >= -200 && rect.top <= vHeight + 1500;
          });
          if (textNodes.length < 10) {
            // A sparse match (a handful of huge <p> tags, or a page that leans on <div>s
            // instead of the semantic tags this selector looks for) can leave fewer than 10
            // nodes in the whole generous +-window above, even with plenty of on-screen text.
            // allTextNodes.slice(-50) picked the last 50 nodes in DOCUMENT order regardless of
            // where the user has scrolled to - on a long docs page that is the footer, not
            // whatever is actually visible. Sort every node by its distance from the viewport
            // instead, so the fallback always centers on where the user is looking, not on
            // wherever the document happens to end.
            textNodes = allTextNodes
              .map(node => ({ node, dist: Math.abs(node.getBoundingClientRect().top) }))
              .sort((a, b) => a.dist - b.dist)
              .slice(0, 50)
              .map(entry => entry.node);
          }
        } else {
          textNodes = allTextNodes.slice(0, 90);
        }

        let extractedText = '';

        if (textNodes.length > 0) {
          extractedText = textNodes
            .map(node => {
              const str = node.textContent.trim().replace(/\s+/g, ' ');
              if (/^h[1-6]$/i.test(node.tagName)) {
                return `\n### ${str}\n`;
              }
              return str;
            })
            .filter(t => t.length > 3)
            .join('\n');
        }

        // Fallback to container innerText if targeted extraction is sparse
        if (!extractedText || extractedText.length < 100) {
          extractedText = (container.innerText || container.textContent || '').trim();
        }

        return this.finishPageText(extractedText);
      } catch (_) {
        return this.capPageText(document.body ? (document.body.innerText || document.body.textContent || '') : '', 3000);
      }
    }

    /**
     * Collapses the repeated text of a rendered page, then applies the cap (see the notes above
     * collapseRepeatedRunsOnce). Only the first PAGE_TEXT_SCAN_LIMIT characters are searched.
     */
    finishPageText(text) {
      const scanned = text.length > PAGE_TEXT_SCAN_LIMIT ? text.slice(0, PAGE_TEXT_SCAN_LIMIT) : text;
      return this.capPageText(this.collapseRepeatedRuns(scanned), PAGE_TEXT_CAP, scanned.length < text.length);
    }

    /**
     * Runs of repeated units (REPEAT_MIN_RUN or more, the same after masking digits) become
     * "first ... last (N similar entries)", or "unit (repeated N times)" when they are word for word
     * the same. A second pass collapses a cycle of such runs, which is what a page that repeats a
     * list several times leaves after the first. Runs whose digits carry a price or a delivery time
     * are kept. See collapseRepeatedRunsOnce.
     */
    collapseRepeatedRuns(text) {
      let current = text;
      for (let pass = 0; pass < REPEAT_MAX_PASSES; pass++) {
        const next = collapseRepeatedRunsOnce(current);
        if (next === current) break;
        current = next;
      }
      return current;
    }

    /**
     * Cuts the text at the cap. A text that is cut ends with a marker line, so the model knows it
     * saw part of the page and can scroll or read on. `cutEarlier` says the page was already cut
     * before this (the scan limit) even though what is left fits.
     */
    capPageText(text, cap = PAGE_TEXT_CAP, cutEarlier = false) {
      if (text.length > cap) return `${text.slice(0, cap)}\n[page text truncated at ${cap} characters]`;
      return cutEarlier ? `${text}\n[page text truncated]` : text;
    }

    /**
     * Retrieve element by assigned ID
     */
    getElement(id) {
      const entry = this.elementMap.get(Number(id));
      if (!entry) return null;
      const el = (typeof WeakRef !== 'undefined' && entry instanceof WeakRef) ? entry.deref() : entry;
      if (!el) return null;
      if (typeof document !== 'undefined' && typeof document.contains === 'function' && !document.contains(el)) {
        return null;
      }
      return el;
    }

    /**
     * Resolve element with docId check and status
     */
    resolveElementWithStatus(id, expectedDocId) {
      if (expectedDocId && this.docId && expectedDocId !== this.docId) {
        return { success: false, stale: true, error: `Document navigated (expected ${expectedDocId}, got ${this.docId}).` };
      }
      const el = this.getElement(id);
      if (!el) {
        return { success: false, stale: true, error: `Element [${id}] is no longer attached to the document.` };
      }
      return { success: true, element: el };
    }

    /**
     * Compute stable CSS selector path for an element
     */
    getCssPath(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
      if (el.id) return `#${CSS.escape ? CSS.escape(el.id) : el.id}`;
      
      const path = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        let selector = current.tagName.toLowerCase();
        if (current.id) {
          selector = `#${CSS.escape ? CSS.escape(current.id) : current.id}`;
          path.unshift(selector);
          break;
        } else {
          let sibling = current;
          let nth = 1;
          while (sibling = sibling.previousElementSibling) {
            if (sibling.tagName.toLowerCase() === selector) nth++;
          }
          if (nth > 1) selector += `:nth-of-type(${nth})`;
        }
        path.unshift(selector);
        current = current.parentElement;
      }
      return path.join(' > ');
    }

    /**
     * Find interactive and focusable elements on the page
     */
    findInteractiveElements() {
      const selector = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="textbox"]',
        '[role="combobox"]',
        '[role="tab"]',
        '[tabindex="0"]',
        '[onclick]'
      ].join(',');

      const candidates = Array.from(document.querySelectorAll(selector));
      
      return candidates.filter(el => this.isVisible(el));
    }

    /**
     * Check if element is visible on screen.
     *
     * checkVisibility() (Chrome 105+, well below the 111+ this extension's MAIN-world
     * injection already requires) also walks ANCESTOR opacity/visibility, which a
     * getComputedStyle(el) read on the element itself cannot see at all.
     */
    isVisible(el) {
      if (!el) return false;
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;

      return true;
    }

    /**
     * A best-effort implicit ARIA role, for elements with no explicit [role] attribute. Not a
     * full HTML-AAM implementation - just enough for the model to tell a link from a button
     * from a form field, which the raw tag name alone (e.g. every clickable thing is just
     * "div" or "span" with [onclick]) does not convey.
     */
    computeRole(el, tagName, type) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      if (tagName === 'input') {
        return { checkbox: 'checkbox', radio: 'radio', submit: 'button', reset: 'button', button: 'button', range: 'slider', search: 'searchbox' }[type] || 'textbox';
      }
      return { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', option: 'option' }[tagName] || tagName;
    }

    /**
     * Determine field kind (password, cc, otp, email, address, search, text)
     */
    computeFieldKind(el, tagName, type) {
      if (tagName !== 'input' && tagName !== 'textarea') return undefined;
      const lowerType = (type || '').toLowerCase();
      const name = (el.getAttribute('name') || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
      const combined = `${name} ${id} ${autocomplete}`;

      if (lowerType === 'password' || combined.includes('password') || combined.includes('passwort')) return 'password';
      if (lowerType === 'email' || combined.includes('email') || combined.includes('e-mail')) return 'email';
      if (/card|cc-number|cvv|cvc|cardnumber|kreditkarte/i.test(combined) || (lowerType === 'tel' && combined.includes('cc'))) return 'cc';
      if (/otp|2fa|one-time|verification|code|mfa|token/i.test(combined)) return 'otp';
      if (lowerType === 'search' || /search|suche|query/i.test(combined)) return 'search';
      if (/address|street|city|zip|postcode|plz|strasse|ort/i.test(combined)) return 'address';
      return 'text';
    }

    /**
     * Determine form kind (search, login, checkout, other)
     */
    computeFormKind(el) {
      const form = typeof el.closest === 'function' ? el.closest('form') : null;
      if (!form) return undefined;
      const formRole = (form.getAttribute('role') || '').toLowerCase();
      const formClass = (typeof form.className === 'string' ? form.className : '').toLowerCase();
      const formId = (form.id || '').toLowerCase();
      const formAction = (form.getAttribute('action') || '').toLowerCase();
      const formAria = (form.getAttribute('aria-label') || '').toLowerCase();
      const combined = `${formRole} ${formClass} ${formId} ${formAction} ${formAria}`;

      if (formRole === 'search' || /search|suche/i.test(combined)) return 'search';
      if (/login|signin|anmelden|auth|session/i.test(combined)) return 'login';
      if (/checkout|kasse|payment|order|bestell/i.test(combined)) return 'checkout';
      return 'other';
    }

    /**
     * Extract destination domain for links
     */
    computeHrefDomain(el, tagName) {
      if (tagName !== 'a' && !el.href) return undefined;
      try {
        const href = el.href || el.getAttribute('href');
        if (!href) return undefined;
        const currentOrigin = (typeof window !== 'undefined' && window.location && window.location.href) || 'https://localhost';
        const url = new URL(href, currentOrigin);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return url.hostname.toLowerCase();
        }
      } catch (_) {}
      return undefined;
    }

    /**
     * Produce concise element string representation with stable locator descriptors
     */
    getElementSummary(el, id) {
      const tagName = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);

      const role = this.computeRole(el, tagName, type);
      const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
      const checked = (tagName === 'input' && (type === 'checkbox' || type === 'radio'))
        ? !!el.checked
        : (el.getAttribute('aria-checked') === 'true');
      const expandedAttr = el.getAttribute('aria-expanded');
      const expanded = expandedAttr === null ? undefined : expandedAttr === 'true';
      // Never surface a password field's actual value - this is a snapshot the model reads and
      // that later becomes part of the LLM prompt, not a private in-browser value.
      const isPasswordLike = tagName === 'input' && type === 'password';
      const valuePreview = (!isPasswordLike && (tagName === 'input' || tagName === 'textarea') && typeof el.value === 'string' && el.value)
        ? el.value.slice(0, 40)
        : '';

      const fieldKind = this.computeFieldKind(el, tagName, type);
      const formKind = this.computeFormKind(el);
      const hrefDomain = this.computeHrefDomain(el, tagName);
      const isForbidden = fieldKind === 'password' || fieldKind === 'cc' || fieldKind === 'otp';

      let inViewport = true;
      try {
        const rect = el.getBoundingClientRect();
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
        inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
      } catch (_) {
        // A measurement failure must never hide an element the model could otherwise act on.
        inViewport = true;
      }

      // tagName/type are already in `formatted`'s own prefix below - only placeholder/aria-label
      // are worth repeating here, since labelText can drop one of them (e.g. real innerText
      // wins over an aria-label that says something different, like an icon button).
      let extraAttrs = '';
      if (placeholder) extraAttrs += ` placeholder="${placeholder}"`;
      if (ariaLabel) extraAttrs += ` label="${ariaLabel}"`;
      if (disabled) extraAttrs += ' disabled';
      if (checked) extraAttrs += ' checked';
      if (expanded === true) extraAttrs += ' expanded';
      else if (expanded === false) extraAttrs += ' collapsed';
      if (valuePreview) extraAttrs += ` value="${valuePreview}"`;
      if (hrefDomain && typeof window !== 'undefined' && window.location && window.location.hostname && hrefDomain !== window.location.hostname.toLowerCase()) {
        extraAttrs += ` domain="${hrefDomain}"`;
      }
      if (isForbidden) {
        extraAttrs += ' (user only)';
      }

      let labelText = text || ariaLabel || placeholder || 'element';

      const locator = {
        index: id,
        tag: tagName,
        text: labelText,
        role,
        cssPath: this.getCssPath(el),
        attrs: {
          id: el.id || '',
          name: el.getAttribute('name') || '',
          'data-testid': el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy') || ''
        }
      };

      this.elementInfo = this.elementInfo || {};
      this.elementInfo[id] = {
        role,
        label: labelText,
        formKind,
        fieldKind,
        hrefDomain
      };

      return {
        id,
        tagName,
        type,
        role,
        disabled,
        checked,
        expanded,
        inViewport,
        text: labelText,
        locator,
        formatted: `[${id}] ${tagName}${type ? `[${type}]` : ''} "${labelText}"${extraAttrs ? ` (${extraAttrs.trim()})` : ''}${inViewport ? '' : ' [off-screen]'}`
      };
    }
  }

  // Window global attachment with re-injection protection & key alias fallback
  if (typeof window !== 'undefined') {
    window.DOMCompressor = window.DOMCompressor || DOMCompressor;
    window.domCompressorInstance = window.domCompressorInstance || new DOMCompressor();
    window.domCompressor = window.domCompressor || window.domCompressorInstance;
  }
})();
