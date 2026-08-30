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
        elements: formattedElements
      };
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
