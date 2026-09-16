/**
 * DOMCompressor - Extracts interactive elements from the webpage and produces a concise,
 * clean structured snapshot optimized for small LLMs (8B, 9B, 27B, 32B).
 * Encapsulated in an IIFE to prevent V8 parse-time redeclaration errors upon re-injection.
 */

(function() {
  class DOMCompressor {
    constructor() {
      this.elementMap = new Map(); // Maps numeric ID to DOM Element reference
      this.counter = 0;
    }

    /**
     * Main method to generate DOM snapshot
     */
    getSnapshot(options = {}) {
      const maxElements = options.maxElements || 120;
      this.elementMap.clear();
      this.counter = 0;

      const interactiveElements = this.findInteractiveElements();
      const formattedElements = [];

      for (const el of interactiveElements) {
        if (this.counter >= maxElements) break;

        this.counter++;
        const id = this.counter;
        this.elementMap.set(id, el);

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

      return {
        title,
        url,
        scrollState: { scrollY, pageHeight, viewportHeight },
        elementCount: formattedElements.length,
        elementsText: formattedElements.map(e => e.formatted).join('\n'),
        elements: formattedElements,
        pageText: this.extractPageText()
      };
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
          return rawText.trim().slice(0, 4500);
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

        return extractedText.slice(0, 4500);
      } catch (_) {
        return (document.body ? (document.body.innerText || document.body.textContent || '') : '').slice(0, 3000);
      }
    }

    /**
     * Retrieve element by assigned ID
     */
    getElement(id) {
      return this.elementMap.get(Number(id));
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
