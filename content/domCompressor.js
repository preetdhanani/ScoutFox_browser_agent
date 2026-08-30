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
     * Dedicated Text Body Extraction Module
     * Extracts readable text content across rendered HTML, raw text files, and documentation containers.
     */
    extractPageText() {
      try {
        // 1. Raw Markdown / Plain Text Pages (e.g. raw.githubusercontent.com)
        if (window.location.hostname.includes('raw.githubusercontent.com') || (document.contentType && document.contentType.startsWith('text/'))) {
          const rawText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          return rawText.trim().slice(0, 4000);
        }

        // 2. Targeted Article / README / Documentation Containers
        const targetedContainer = document.querySelector('article, main, #readme, .markdown-body, [role="main"]');
        const container = targetedContainer || document.body;
        if (!container) return '';

        // Extract headings, paragraphs, list items, table text, and code snippets
        const textNodes = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, code, blockquote'));
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
            .slice(0, 80)
            .join('\n');
        }

        // 3. Fallback to container innerText if targeted extraction is sparse
        if (!extractedText || extractedText.length < 100) {
          extractedText = (container.innerText || container.textContent || '').trim();
        }

        return extractedText.slice(0, 4000);
      } catch (_) {
        return (document.body ? (document.body.innerText || document.body.textContent || '') : '').slice(0, 2500);
      }
    }

    /**
     * Retrieve element by assigned ID
     */
    getElement(id) {
      return this.elementMap.get(Number(id));
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
     * Produce concise element string representation
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

      return {
        id,
        tagName,
        type,
        text: labelText,
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
