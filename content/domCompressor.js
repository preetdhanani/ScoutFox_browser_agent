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

      // Check if within bounds or reasonable scroll distance
      const inViewport = (
        rect.top < window.innerHeight * 1.5 &&
        rect.bottom > -window.innerHeight * 0.5 &&
        rect.left < window.innerWidth * 1.5 &&
        rect.right > -window.innerWidth * 0.5
      );

      return inViewport;
    }

    /**
     * Summarize element into concise string for prompt context
     */
    getElementSummary(el, id) {
      const tagName = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      let role = el.getAttribute('role') || '';
      
      // Determine label / text content
      let label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        this.getLabelForInput(el) ||
        el.innerText ||
        el.textContent ||
        ''
      ).replace(/\s+/g, ' ').trim();

      if (label.length > 50) {
        label = label.substring(0, 47) + '...';
      }

      // Determine current value for inputs/selects
      let valueStr = '';
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
        if (type === 'checkbox' || type === 'radio') {
          valueStr = el.checked ? ' [checked]' : ' [unchecked]';
        } else if (el.value) {
          const val = el.value.length > 30 ? el.value.substring(0, 27) + '...' : el.value;
          valueStr = ` value="${val}"`;
        }
      }

      let hrefStr = '';
      if (tagName === 'a' && el.getAttribute('href')) {
        const href = el.getAttribute('href');
        if (href.startsWith('http') || href.startsWith('/')) {
          hrefStr = ` href="${href.length > 40 ? href.substring(0, 37) + '...' : href}"`;
        }
      }

      let tagDescription = tagName;
      if (type) tagDescription += `:${type}`;
      else if (role) tagDescription += `:${role}`;

      const formatted = `[${id}] ${tagDescription}${label ? ` "${label}"` : ''}${valueStr}${hrefStr}`;

      return {
        id,
        tagName,
        type,
        label,
        value: el.value || '',
        formatted
      };
    }

    /**
     * Helper to check associated label tag for inputs
     */
    getLabelForInput(el) {
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${el.id}"]`);
        if (labelEl) return labelEl.innerText;
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.innerText;
      return '';
    }
  }

  // Attach instance to window object cleanly
  window.DOMCompressor = DOMCompressor;
  window.domCompressor = window.domCompressor || new DOMCompressor();
})();
