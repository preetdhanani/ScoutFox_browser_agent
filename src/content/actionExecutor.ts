/**
 * ScoutFox ActionExecutor Class
 * Handles element highlighting overlay, stable locator re-resolution,
 * and executes actions (click, type, scroll, keypress, read_page_text, browser_batch).
 * Preserves the instance method dispatch seam for all callers and tamper scripts.
 */

import { renderBadges, removeBadges, type BadgeElementItem } from './badges.ts';
import {
  ensureCursorOverlay,
  animateCursor,
  showClickEffect,
  removeCursorOverlay,
  highlightElement
} from './cursor.ts';
import { resolveElement } from './resolve.ts';
import { waitForDomQuiet } from './domQuiet.ts';
import {
  describeElement,
  setFieldValue,
  doClick,
  doType,
  doScroll,
  doPressKey,
  doBrowserBatch,
  execute,
  type ActionExecutionContext
} from './actions.ts';

export class ActionExecutor implements ActionExecutionContext {
  badgeContainer: HTMLElement | null;
  cursorContainer: HTMLElement | null;
  cursorEl: HTMLElement | null;
  cursorFadeTimer: ReturnType<typeof setTimeout> | null;
  doc?: Document;
  win?: Window & typeof globalThis;

  constructor(doc?: Document, win?: Window & typeof globalThis) {
    this.badgeContainer = null;
    this.cursorContainer = null;
    this.cursorEl = null;
    this.cursorFadeTimer = null;
    this.doc = doc;
    this.win = win;
  }

  private getDoc(): Document {
    return this.doc || (typeof document !== 'undefined' ? document : (null as unknown as Document));
  }

  private getWin(): (Window & typeof globalThis) | undefined {
    return this.win || (typeof window !== 'undefined' ? window : undefined);
  }

  renderBadges(elements: BadgeElementItem[]): void {
    this.badgeContainer = renderBadges(elements, this.getDoc(), this.getWin());
  }

  removeBadges(): void {
    removeBadges(this.badgeContainer, this.getDoc());
    this.badgeContainer = null;
  }

  ensureCursorOverlay(): void {
    const state = ensureCursorOverlay(this.cursorContainer, this.cursorEl, this.getDoc());
    this.cursorContainer = state.container;
    this.cursorEl = state.pointer;
  }

  animateCursor(x: number, y: number): void {
    this.ensureCursorOverlay();
    animateCursor(
      x,
      y,
      this.cursorEl,
      () => this.cursorFadeTimer,
      (t) => {
        this.cursorFadeTimer = t;
      }
    );
  }

  showClickEffect(x: number, y: number): void {
    this.ensureCursorOverlay();
    this.animateCursor(x, y);
    showClickEffect(x, y, this.cursorContainer, this.cursorEl, this.getDoc());
  }

  removeCursorOverlay(): void {
    removeCursorOverlay(this.cursorContainer, () => {
      if (this.cursorFadeTimer) {
        clearTimeout(this.cursorFadeTimer);
        this.cursorFadeTimer = null;
      }
    });
    this.cursorContainer = null;
    this.cursorEl = null;
  }

  highlightElement(el: HTMLElement | null): void {
    highlightElement(el);
  }

  resolveElement(elementId: number | string): Element | null {
    return resolveElement(elementId, this.getDoc(), this.getWin());
  }

  describeElement(el: Element | null): string {
    return describeElement(el);
  }

  setFieldValue(el: Element, text: unknown): { success: boolean; error?: string } {
    return setFieldValue(el, text);
  }

  doClick(elementId: number | string): any {
    return doClick(elementId, this, this.getWin());
  }

  doType(elementId: number | string, text: unknown, submit: unknown = false): any {
    return doType(elementId, text, submit, this);
  }

  doScroll(direction: any = 'down', amount: any = 500): any {
    return doScroll(direction, amount, this.getWin());
  }

  doPressKey(key = 'Enter'): any {
    return doPressKey(key, this.getDoc());
  }

  waitForDomQuiet(quietMs = 300, timeoutCeilingMs = 1500): Promise<void> {
    return waitForDomQuiet(quietMs, timeoutCeilingMs, this.getDoc());
  }

  doBrowserBatch(steps: any[], stopOnError = true): Promise<any> {
    return doBrowserBatch(steps, stopOnError, this, this.getWin());
  }

  execute(actionPayload: any): Promise<any> {
    return execute(actionPayload, this, this.getDoc(), this.getWin());
  }
}
