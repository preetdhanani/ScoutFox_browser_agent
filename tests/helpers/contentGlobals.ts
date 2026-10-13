/**
 * Helper for tests that need DOM/browser globals installed on `globalThis` during execution.
 *
 * Captures previous property descriptors (including accessors and undefined entries) and restores
 * them reliably after execution, ensuring no globals leak across serial test runs.
 */

export type PropertyDescriptorMap = Map<string, PropertyDescriptor>;

export function installGlobals(stubs: Record<string, unknown>): () => void {
  const saved: PropertyDescriptorMap = new Map();
  const unexisted: Set<string> = new Set();

  for (const [name, value] of Object.entries(stubs)) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    if (desc) {
      saved.set(name, desc);
    } else {
      unexisted.add(name);
    }

    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true
    });
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;

    for (const name of unexisted) {
      delete (globalThis as Record<string, unknown>)[name];
    }
    for (const [name, desc] of saved) {
      Object.defineProperty(globalThis, name, desc);
    }
  };
}

export function withGlobals<T>(
  stubs: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T>;
export function withGlobals<T>(
  stubs: Record<string, unknown>,
  fn: () => T
): T;
export function withGlobals<T>(
  stubs: Record<string, unknown>,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const restore = installGlobals(stubs);
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}
