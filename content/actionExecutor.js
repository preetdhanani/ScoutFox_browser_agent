/**
 * ActionExecutor - Handles element highlighting overlay, stable locator re-resolution,
 * and executes actions (click, type, scroll, keypress, read_page_text, browser_batch).
 * Encapsulated in an IIFE to prevent V8 parse-time redeclaration errors upon re-injection.
 */

(function() {
  class ActionExecutor {
    constructor() {
      this.badgeContainer = null;
    }

    /**
     * Render floating visual badges on the webpage for indexed elements
     */
    renderBadges(elements) {
      this.removeBadges();

      this.badgeContainer = document.createElement('div');
      this.badgeContainer.id = 'scoutfox-badge-container';
      this.badgeContainer.style.position = 'absolute';
      this.badgeContainer.style.top = '0';
      this.badgeContainer.style.left = '0';
      this.badgeContainer.style.width = '100%';
      this.badgeContainer.style.height = '100%';
      this.badgeContainer.style.pointerEvents = 'none';
      this.badgeContainer.style.zIndex = '2147483647'; // Max z-index

      document.body.appendChild(this.badgeContainer);

      elements.forEach(item => {
        const el = window.domCompressor ? window.domCompressor.getElement(item.id) : null;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        const badge = document.createElement('div');
        badge.className = 'scoutfox-badge';
        badge.textContent = item.id;
        badge.style.position = 'absolute';
        badge.style.top = `${rect.top + window.scrollY}px`;
        badge.style.left = `${rect.left + window.scrollX}px`;
        badge.style.backgroundColor = '#a85f34'; // Studio Mono copper accent
        badge.style.color = '#ffffff';
        badge.style.fontFamily = 'monospace, sans-serif';
        badge.style.fontSize = '11px';
        badge.style.fontWeight = 'bold';
        badge.style.padding = '1px 5px';
        badge.style.borderRadius = '4px';
        badge.style.boxShadow = '0 2px 4px rgba(0,0,0,0.4)';
        badge.style.border = '1px solid #ffffff';
        badge.style.pointerEvents = 'none';
        badge.style.transform = 'translate(-40%, -40%)';
        badge.style.transition = 'all 0.2s ease';

        this.badgeContainer.appendChild(badge);
      });
    }

    /**
     * Remove floating visual badges
     */
    removeBadges() {
      if (this.badgeContainer) {
        this.badgeContainer.remove();
        this.badgeContainer = null;
      }
    }

    /**
     * Re-resolve element using Stable Locator descriptors to prevent stale index execution
     */
    resolveElement(elementId) {
      const compressor = window.domCompressor || window.domCompressorInstance;
      const liveNode = compressor ? compressor.getElement(elementId) : null;

      // 1. Live Node Reference (if still attached to DOM)
      if (liveNode && document.contains(liveNode)) {
        return liveNode;
      }

      // Find descriptor from snapshot elements cache if available
      let locator = null;
      if (compressor && compressor.elements) {
        const item = compressor.elements.find(e => e.id === Number(elementId));
        if (item) locator = item.locator;
      }

      if (!locator) {
        return null;
      }

      // 2. Stable attributes (#id / [data-testid] / [name])
      if (locator.attrs) {
        if (locator.attrs.id) {
          const el = document.getElementById(locator.attrs.id);
          if (el && document.contains(el)) return el;
        }
        if (locator.attrs['data-testid']) {
          const el = document.querySelector(`[data-testid="${CSS.escape ? CSS.escape(locator.attrs['data-testid']) : locator.attrs['data-testid']}"]`);
          if (el && document.contains(el)) return el;
        }
        if (locator.attrs.name) {
          const el = document.querySelector(`[name="${CSS.escape ? CSS.escape(locator.attrs.name) : locator.attrs.name}"]`);
          if (el && document.contains(el)) return el;
        }
      }

      // 3. CSS Path
      if (locator.cssPath) {
        try {
          const el = document.querySelector(locator.cssPath);
          if (el && document.contains(el)) return el;
        } catch (_) {}
      }

      // 4. Tag + Text + Role Match
      if (locator.tag) {
        const candidates = Array.from(document.querySelectorAll(locator.tag));
        const matched = candidates.find(candidate => {
          const txt = (candidate.innerText || candidate.textContent || '').trim().replace(/\s+/g, ' ');
          return txt === locator.text;
        });
        if (matched) return matched;
      }

      return null;
    }

    /**
     * Execute action requested by agent
     */
    async execute(actionPayload) {
      const { action, element_id, text, submit, direction, amount, key, url, steps, stopOnError = true } = actionPayload;

      switch (action) {
        case 'click':
          return this.doClick(element_id);
        case 'type':
          return this.doType(element_id, text, submit);
        case 'scroll':
          return this.doScroll(direction, amount);
        case 'press_key':
          return this.doPressKey(key);
        case 'navigate':
          window.location.href = url;
          return { success: true, message: `Navigating to ${url}` };
        case 'go_back':
          window.history.back();
          return { success: true, message: 'Going back' };
        case 'go_forward':
          window.history.forward();
          return { success: true, message: 'Going forward' };
        case 'read_page_text':
        case 'extract_page_text': {
          const compressor = window.domCompressor || window.domCompressorInstance || (window.DOMCompressor ? new window.DOMCompressor() : null);
          const pageText = compressor ? compressor.extractPageText() : (document.body ? document.body.innerText : '');
          return { success: true, message: `Extracted text snippet (${pageText.length} chars):\n"""\n${pageText.slice(0, 1500)}\n"""` };
        }
        case 'browser_batch':
          return this.doBrowserBatch(steps, stopOnError);
        case 'wait':
          await new Promise(r => setTimeout(r, (amount || 1) * 1000));
          return { success: true, message: `Waited ${amount || 1}s` };
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }

    /**
     * Execute deterministic sequence of primitives in one round trip with stable locator re-resolution
     */
    async doBrowserBatch(steps, stopOnError = true) {
      if (!Array.isArray(steps) || steps.length === 0) {
        return { success: false, error: 'browser_batch requires a non-empty "steps" array' };
      }

      if (steps.length > 8) {
        return { success: false, error: 'browser_batch exceeds maximum allowed 8 steps limit' };
      }

      const forbidden = ['navigate', 'go_back', 'go_forward', 'ask_user', 'finish', 'browser_batch'];
      const results = [];
      let completed = 0;
      let abortedAt = null;
      let terminatedBy = null;

      const initialUrl = window.location.href;

      for (let i = 0; i < steps.length; i++) {
        const step = { ...steps[i] };
        
        // Key aliases
        const actName = step.action || (step.click !== undefined ? 'click' : step.type !== undefined ? 'type' : '');
        const targetId = step.element_id || step.index || step.elementId || step.element;

        if (forbidden.includes(actName)) {
          const err = `Action "${actName}" is forbidden inside browser_batch`;
          results.push({ step: i, action: actName, ok: false, error: err });
          abortedAt = i;
          if (stopOnError) break;
          continue;
        }

        // Execute primitive step
        try {
          const stepPayload = { ...step, action: actName, element_id: targetId };
          const stepRes = await this.execute(stepPayload);

          if (stepRes.success !== false) {
            results.push({ step: i, action: actName, ok: true, message: stepRes.message });
            completed++;
          } else {
            results.push({ step: i, action: actName, ok: false, error: stepRes.error });
            abortedAt = i;
            if (stopOnError) break;
          }
        } catch (stepErr) {
          results.push({ step: i, action: actName, ok: false, error: stepErr.message });
          abortedAt = i;
          if (stopOnError) break;
        }

        // Check if page started navigating
        if (window.location.href !== initialUrl) {
          terminatedBy = 'navigation';
          break;
        }

        // Auto-wait between batch steps (readyState + DOM quiet window)
        await this.waitForDomQuiet(300, 1500);
      }

      const ok = completed > 0 && (abortedAt === null);
      return {
        success: ok,
        completed,
        total: steps.length,
        results,
        abortedAt,
        terminatedBy
      };
    }

    /**
     * Helper to wait for DOM quietness between batch steps
     */
    waitForDomQuiet(quietMs = 300, timeoutCeilingMs = 1500) {
      return new Promise((resolve) => {
        let timer = null;
        let ceilingTimer = null;
        let observer = null;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (ceilingTimer) clearTimeout(ceilingTimer);
          if (observer) observer.disconnect();
        };

        ceilingTimer = setTimeout(() => {
          cleanup();
          resolve();
        }, timeoutCeilingMs);

        const resetTimer = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            cleanup();
            resolve();
          }, quietMs);
        };

        if (typeof MutationObserver !== 'undefined' && document.body) {
          observer = new MutationObserver(resetTimer);
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        }

        resetTimer();
      });
    }

    /**
     * Simulate realistic click on element with stable locator re-resolution
     */
    doClick(elementId) {
      const el = this.resolveElement(elementId);
      if (!el) {
        return { success: false, error: `Element [${elementId}] no longer resolvable in DOM.` };
      }

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.highlightElement(el);

      // Dispatch click mouse events
      ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(eventType => {
        const event = new MouseEvent(eventType, {
          view: window,
          bubbles: true,
          cancelable: true
        });
        el.dispatchEvent(event);
      });

      if (typeof el.click === 'function') {
        el.click();
      }

      return { success: true, message: `Clicked element [${elementId}]` };
    }

    /**
     * Simulate realistic typing into input field with stable locator re-resolution
     */
    doType(elementId, text, submit = false) {
      const el = this.resolveElement(elementId);
      if (!el) {
        return { success: false, error: `Element [${elementId}] no longer resolvable in DOM.` };
      }

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.highlightElement(el);

      el.focus();
      el.value = text;

      // Dispatch input and change events so modern frameworks register changes
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      if (submit) {
        const form = el.closest('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        } else {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        }
      }

      return { success: true, message: `Typed "${text}" into element [${elementId}]` };
    }

    /**
     * Scroll webpage smoothly
     */
    doScroll(direction = 'down', amount = 500) {
      const distance = direction === 'up' ? -amount : amount;
      window.scrollBy({ top: distance, behavior: 'smooth' });
      return { success: true, message: `Scrolled ${direction} by ${amount}px` };
    }

    /**
     * Dispatch keypress event
     */
    doPressKey(key = 'Enter') {
      const activeEl = document.activeElement || document.body;
      activeEl.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      activeEl.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      return { success: true, message: `Pressed key [${key}]` };
    }

    /**
     * Temporary visual highlight ring around target element
     */
    highlightElement(el) {
      const origOutline = el.style.outline;
      const origTransition = el.style.transition;

      el.style.transition = 'outline 0.2s ease';
      el.style.outline = '3px solid #a85f34';

      setTimeout(() => {
        el.style.outline = origOutline;
        el.style.transition = origTransition;
      }, 1000);
    }
  }

  // Window global attachment with re-injection protection
  if (typeof window !== 'undefined') {
    window.ActionExecutor = window.ActionExecutor || ActionExecutor;
    window.actionExecutorInstance = window.actionExecutorInstance || new ActionExecutor();
    window.actionExecutor = window.actionExecutor || window.actionExecutorInstance;
  }
})();
