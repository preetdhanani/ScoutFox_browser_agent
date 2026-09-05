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
     * Check if element is visible on screen
     */
    isVisible(el) {
      if (!el) return false;
      
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;

      return true;
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

      let desc = `<${tagName}`;
      if (type) desc += ` type="${type}"`;
      if (placeholder) desc += ` placeholder="${placeholder}"`;
      if (ariaLabel) desc += ` label="${ariaLabel}"`;
      desc += '>';

      let labelText = text || ariaLabel || placeholder || 'element';

      const locator = {
        index: id,
        tag: tagName,
        text: labelText,
        role: el.getAttribute('role') || tagName,
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
        text: labelText,
        locator,
        formatted: `[${id}] ${tagName}${type ? `[${type}]` : ''} "${labelText}" (${desc})`
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
