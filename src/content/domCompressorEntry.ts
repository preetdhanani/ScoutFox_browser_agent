/**
 * ScoutFox DOMCompressor Content Script Entry
 * Injected in ISOLATED world at document_idle.
 * Attaches DOMCompressor class and singleton instances to window.
 */
import { DOMCompressor } from './domCompressor.ts';

declare global {
  interface Window {
    DOMCompressor: typeof DOMCompressor;
    domCompressorInstance: DOMCompressor;
    domCompressor: DOMCompressor;
  }
}

if (typeof window !== 'undefined') {
  window.DOMCompressor = window.DOMCompressor || DOMCompressor;
  window.domCompressorInstance = window.domCompressorInstance || new DOMCompressor();
  window.domCompressor = window.domCompressor || window.domCompressorInstance;
}
