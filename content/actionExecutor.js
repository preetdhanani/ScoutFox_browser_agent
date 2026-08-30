/**
 * ActionExecutor - Handles element highlighting overlay and executes actions (click, type, scroll, keypress).
 */

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
    this.badgeContainer.id = 'strawberry-badge-container';
    this.badgeContainer.style.position = 'absolute';
    this.badgeContainer.style.top = '0';
    this.badgeContainer.style.left = '0';
    this.badgeContainer.style.width = '100%';
    this.badgeContainer.style.height = '100%';
    this.badgeContainer.style.pointerEvents = 'none';
    this.badgeContainer.style.zIndex = '2147483647'; // Max z-index

    document.body.appendChild(this.badgeContainer);

    elements.forEach(item => {
      const el = window.domCompressor.getElement(item.id);
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const badge = document.createElement('div');
      badge.className = 'strawberry-badge';
      badge.textContent = item.id;
      badge.style.position = 'absolute';
      badge.style.top = `${rect.top + window.scrollY}px`;
      badge.style.left = `${rect.left + window.scrollX}px`;
      badge.style.backgroundColor = '#ec4899'; // Vibrant pink/magenta
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
   * Execute action requested by agent
   */
  async execute(actionPayload) {
    const { action, element_id, text, submit, direction, amount, key, url } = actionPayload;

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
      case 'wait':
        await new Promise(r => setTimeout(r, (amount || 1) * 1000));
        return { success: true, message: `Waited ${amount || 1}s` };
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Simulate realistic click on element
   */
  doClick(elementId) {
    const el = window.domCompressor.getElement(elementId);
    if (!el) {
      return { success: false, error: `Element [${elementId}] not found on page. Please choose a valid index from the list.` };
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
   * Simulate realistic typing into input field
   */
  doType(elementId, text, submit = false) {
    const el = window.domCompressor.getElement(elementId);
    if (!el) {
      return { success: false, error: `Element [${elementId}] not found on page.` };
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.highlightElement(el);

    el.focus();
    el.value = text;

    // Dispatch input and change events so modern frameworks (React, Vue, Angular) register changes
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    if (submit) {
      const form = el.closest('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.submit();
        }
      } else {
        // Fallback: Dispatch Enter key
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
    }

    return { success: true, message: `Typed "${text}" into element [${elementId}]${submit ? ' and submitted' : ''}` };
  }

  /**
   * Scroll window or container
   */
  doScroll(direction = 'down', amount = 500) {
    const distance = direction === 'up' ? -amount : amount;
    window.scrollBy({ top: distance, behavior: 'smooth' });
    return { success: true, message: `Scrolled ${direction} by ${amount}px` };
  }

  /**
   * Press key event
   */
  doPressKey(key = 'Enter') {
    const activeEl = document.activeElement || document.body;
    activeEl.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    activeEl.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    return { success: true, message: `Pressed key "${key}"` };
  }

  /**
   * Temporarily pulse highlight an element
   */
  highlightElement(el) {
    const originalOutline = el.style.outline;
    const originalTransition = el.style.transition;
    el.style.transition = 'outline 0.2s ease';
    el.style.outline = '3px solid #ec4899';
    setTimeout(() => {
      el.style.outline = originalOutline;
      el.style.transition = originalTransition;
    }, 1200);
  }
}

window.actionExecutor = new ActionExecutor();
