/**
 * ScoutFox Perception and Element Representation
 * Computes ARIA roles, field kinds, form kinds, and produces byte-compatible element summaries.
 */

export interface ElementLocator {
  index: number;
  tag: string;
  text: string;
  role: string;
  cssPath: string;
  attrs: {
    id: string;
    name: string;
    'data-testid': string;
  };
}

export interface FormattedElement {
  id: number;
  tagName: string;
  type: string;
  role: string;
  disabled: boolean;
  checked: boolean;
  expanded?: boolean;
  inViewport: boolean;
  text: string;
  locator: ElementLocator;
  formatted: string;
}

export interface ElementInfoRecord {
  role: string;
  label: string;
  formKind?: string;
  fieldKind?: string;
  hrefDomain?: string;
  /**
   * For the risk gate only, never shown to the model: the visible text plus the accessible name, set only when the
   * name adds something the label lacks (an input submit with only a value, an icon-only button named by alt,
   * aria-labelledby or title). The model-facing label keeps its short source order.
   */
  gateLabel?: string;
  /** Set (true) only when clicking the element submits the form it is in. */
  submitControl?: boolean;
  /** Set only when the form sends to another host than the page (form action, or the control's formaction). */
  formActionHost?: string;
  /** Set only when the form (or the control's formmethod) says method="get" explicitly. */
  formMethod?: 'get';
}

/**
 * Best-effort implicit ARIA role for elements without an explicit role attribute.
 */
export function computeRole(el: Element, tagName: string, type: string): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  if (tagName === 'input') {
    const roleMap: Record<string, string> = {
      checkbox: 'checkbox',
      radio: 'radio',
      submit: 'button',
      reset: 'button',
      button: 'button',
      range: 'slider',
      search: 'searchbox'
    };
    return roleMap[type] || 'textbox';
  }
  const tagRoleMap: Record<string, string> = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    option: 'option'
  };
  return tagRoleMap[tagName] || tagName;
}

/**
 * Determine field kind (password, cc, otp, email, address, search, text).
 */
export function computeFieldKind(el: Element, tagName: string, type: string): string | undefined {
  if (tagName !== 'input' && tagName !== 'textarea') return undefined;
  const lowerType = (type || '').toLowerCase();
  const name = (el.getAttribute('name') || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  const combined = `${name} ${id} ${autocomplete}`;

  if (lowerType === 'password' || combined.includes('password') || combined.includes('passwort')) return 'password';
  if (lowerType === 'email' || combined.includes('email') || combined.includes('e-mail')) return 'email';
  if (/card|cc-number|cvv|cvc|cardnumber|kreditkarte/i.test(combined) || (lowerType === 'tel' && combined.includes('cc'))) return 'cc';
  if (/otp|2fa|one-time|verification|code|mfa|token/i.test(combined)) return 'otp';
  if (lowerType === 'search' || /search|suche|query/i.test(combined)) return 'search';
  if (/address|street|city|zip|postcode|plz|strasse|ort/i.test(combined)) return 'address';
  return 'text';
}

/**
 * Determine form kind (search, login, checkout, other).
 */
export function computeFormKind(el: Element): string | undefined {
  const form = typeof el.closest === 'function' ? el.closest('form') : null;
  if (!form) return undefined;
  const formRole = (form.getAttribute('role') || '').toLowerCase();
  const formClass = (typeof form.className === 'string' ? form.className : '').toLowerCase();
  const formId = (form.id || '').toLowerCase();
  const formAction = (form.getAttribute('action') || '').toLowerCase();
  const formAria = (form.getAttribute('aria-label') || '').toLowerCase();
  const combined = `${formRole} ${formClass} ${formId} ${formAction} ${formAria}`;

  if (formRole === 'search' || /search|suche/i.test(combined)) return 'search';
  if (/login|signin|anmelden|auth|session/i.test(combined)) return 'login';
  if (/checkout|kasse|payment|order|bestell/i.test(combined)) return 'checkout';
  return 'other';
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

/**
 * Whether clicking the element submits its form: a <button> without a type or with type submit, or an input of type
 * submit or image. Outside a form nothing is submitted.
 */
export function isSubmitControl(el: Element, tagName: string, type: string): boolean {
  if (typeof el.closest !== 'function' || !el.closest('form')) return false;
  const t = (type || '').toLowerCase();
  if (tagName === 'button') return t === '' || t === 'submit';
  return tagName === 'input' && (t === 'submit' || t === 'image');
}

/**
 * Where and how the element's form sends, for the risk gate: formActionHost only when the action (or the control's
 * formaction) is an http(s) URL on another host than the page, formMethod only when "get" is written explicitly.
 */
export function computeFormTarget(el: Element, pageUrl?: string): { formActionHost?: string; formMethod?: 'get' } {
  const form = typeof el.closest === 'function' ? el.closest('form') : null;
  if (!form) return {};
  const out: { formActionHost?: string; formMethod?: 'get' } = {};
  const action = clean(el.getAttribute('formaction')) || clean(form.getAttribute('action'));
  if (action) {
    try {
      const base = new URL(pageUrl || 'https://localhost/');
      const url = new URL(action, base);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
        out.formActionHost = url.hostname.toLowerCase();
      }
    } catch {
      // An action that is no URL sends nowhere else.
    }
  }
  const method = (clean(el.getAttribute('formmethod')) || clean(form.getAttribute('method'))).toLowerCase();
  if (method === 'get') out.formMethod = 'get';
  return out;
}

/**
 * The accessible name of a control, roughly as a screen reader reads it: aria-labelledby, aria-label, the value of an
 * input button, image alt (its own or, with no text, of its images), and title only when nothing else names it.
 */
export function computeAccessibleName(el: Element, tagName: string, type: string, text: string): string {
  const labelledBy = clean(el.getAttribute('aria-labelledby'));
  if (labelledBy) {
    const doc = (el as any).ownerDocument || (typeof document !== 'undefined' ? document : null);
    const parts = labelledBy.split(' ').map((id) => clean(doc && typeof doc.getElementById === 'function' ? doc.getElementById(id)?.textContent : ''));
    const joined = parts.filter(Boolean).join(' ');
    if (joined) return joined;
  }
  const ariaLabel = clean(el.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;
  const t = (type || '').toLowerCase();
  if (tagName === 'input' && (t === 'submit' || t === 'button' || t === 'reset')) {
    const value = clean((el as HTMLInputElement).value) || clean(el.getAttribute('value'));
    if (value) return value;
  }
  if ((tagName === 'input' && t === 'image') || tagName === 'img') {
    const alt = clean(el.getAttribute('alt'));
    if (alt) return alt;
  }
  if (!text && typeof (el as any).querySelectorAll === 'function') {
    const alts = Array.from((el as any).querySelectorAll('img[alt]') as ArrayLike<Element>).map((img) => clean(img.getAttribute('alt'))).filter(Boolean);
    if (alts.length) return alts.join(' ');
  }
  if (text) return text;
  return clean(el.getAttribute('title'));
}

/**
 * The label the risk gate reads: the visible text and the accessible name, each once. Undefined when that says no
 * more than the model-facing label, so ordinary elements carry no extra field.
 */
export function computeGateLabel(el: Element, tagName: string, type: string, text: string, label: string): string | undefined {
  const parts: string[] = [];
  for (const part of [text, computeAccessibleName(el, tagName, type, text)]) {
    const c = clean(part).slice(0, 120);
    if (c && !parts.some((p) => p.toLowerCase() === c.toLowerCase())) parts.push(c);
  }
  const gate = parts.join(' | ');
  return gate && gate !== label ? gate : undefined;
}

/**
 * The risk facts of one element: what elementInfo holds for it.
 */
export function computeElementInfo(el: Element, labelText: string, text: string, win?: Window | null): ElementInfoRecord {
  const tagName = el.tagName.toLowerCase();
  const type = el.getAttribute('type') || '';
  const pageUrl = win && win.location ? win.location.href : undefined;
  const info: ElementInfoRecord = {
    role: computeRole(el, tagName, type),
    label: labelText,
    formKind: computeFormKind(el),
    fieldKind: computeFieldKind(el, tagName, type),
    hrefDomain: computeHrefDomain(el, tagName, pageUrl)
  };
  const gateLabel = computeGateLabel(el, tagName, type, text, labelText);
  if (gateLabel) info.gateLabel = gateLabel;
  if (isSubmitControl(el, tagName, type)) info.submitControl = true;
  Object.assign(info, computeFormTarget(el, pageUrl));
  return info;
}

/**
 * The element that has focus, which is what press_key acts on, as risk facts. Null when nothing (or only the page
 * itself) has focus. Follows focus into open shadow roots. A focused frame reports role "iframe" (its document cannot be
 * read from here) and a focus that cannot be read reports role "unknown"; the risk gate treats both as unknown.
 */
export function getFocusedElementInfo(
  doc: Document | null | undefined = typeof document !== 'undefined' ? document : null,
  win: Window | null | undefined = typeof window !== 'undefined' ? window : null
): ElementInfoRecord | null {
  try {
    let active: any = doc ? doc.activeElement : null;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (!active || typeof active.tagName !== 'string' || typeof active.getAttribute !== 'function') return null;
    const tagName = active.tagName.toLowerCase();
    if (tagName === 'body' || tagName === 'html' || active === (doc && doc.body)) return null;
    const text = clean(active.innerText || active.textContent).slice(0, 60);
    const label = text || clean(active.getAttribute('aria-label')) || clean(active.getAttribute('placeholder')) || 'element';
    if (tagName === 'iframe' || tagName === 'frame' || tagName === 'object' || tagName === 'embed') {
      return { role: 'iframe', label };
    }
    return computeElementInfo(active as Element, label, text, win);
  } catch {
    // Something has focus but it cannot be read: say so, the risk gate treats it as unknown.
    return { role: 'unknown', label: 'element' };
  }
}

/**
 * Extract destination domain for links.
 */
export function computeHrefDomain(
  el: Element,
  tagName: string,
  currentOrigin: string = typeof window !== 'undefined' && window.location ? window.location.href : 'https://localhost'
): string | undefined {
  if (tagName !== 'a' && !(el as HTMLAnchorElement).href) return undefined;
  try {
    const href = (el as HTMLAnchorElement).href || el.getAttribute('href');
    if (!href) return undefined;
    const url = new URL(href, currentOrigin);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname.toLowerCase();
    }
  } catch {
    // URL parse failed
  }
  return undefined;
}

/**
 * Produce concise element string representation with stable locator descriptors.
 */
export function getElementSummary(
  el: Element,
  id: number,
  getCssPath: (el: Element) => string,
  win: Window = typeof window !== 'undefined' ? window : (null as unknown as Window)
): { summary: FormattedElement; info: ElementInfoRecord } {
  const tagName = el.tagName.toLowerCase();
  const type = el.getAttribute('type') || '';
  const placeholder = el.getAttribute('placeholder') || '';
  const ariaLabel = el.getAttribute('aria-label') || '';
  const rawText = (el as HTMLElement).innerText || el.textContent || '';
  const text = rawText.trim().replace(/\s+/g, ' ').slice(0, 60);

  const role = computeRole(el, tagName, type);
  const disabled = Boolean((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true');
  const checked = (tagName === 'input' && (type === 'checkbox' || type === 'radio'))
    ? Boolean((el as HTMLInputElement).checked)
    : (el.getAttribute('aria-checked') === 'true');
  const expandedAttr = el.getAttribute('aria-expanded');
  const expanded = expandedAttr === null ? undefined : expandedAttr === 'true';

  const isPasswordLike = tagName === 'input' && type === 'password';
  const val = (el as HTMLInputElement).value;
  const valuePreview = (!isPasswordLike && (tagName === 'input' || tagName === 'textarea') && typeof val === 'string' && val)
    ? val.slice(0, 40)
    : '';

  const fieldKind = computeFieldKind(el, tagName, type);
  const hrefDomain = computeHrefDomain(el, tagName, win && win.location ? win.location.href : undefined);
  const isForbidden = fieldKind === 'password' || fieldKind === 'cc' || fieldKind === 'otp';

  let inViewport = true;
  try {
    const rect = el.getBoundingClientRect();
    const vw = (win && win.innerWidth) || 0;
    const vh = (win && win.innerHeight) || 0;
    inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  } catch {
    inViewport = true;
  }

  let extraAttrs = '';
  if (placeholder) extraAttrs += ` placeholder="${placeholder}"`;
  if (ariaLabel) extraAttrs += ` label="${ariaLabel}"`;
  if (disabled) extraAttrs += ' disabled';
  if (checked) extraAttrs += ' checked';
  if (expanded === true) extraAttrs += ' expanded';
  else if (expanded === false) extraAttrs += ' collapsed';
  if (valuePreview) extraAttrs += ` value="${valuePreview}"`;

  const currentHost = (win && win.location && win.location.hostname) ? win.location.hostname.toLowerCase() : '';
  if (hrefDomain && currentHost && hrefDomain !== currentHost) {
    extraAttrs += ` domain="${hrefDomain}"`;
  }
  if (isForbidden) {
    extraAttrs += ' (user only)';
  }

  const labelText = text || ariaLabel || placeholder || 'element';

  const locator: ElementLocator = {
    index: id,
    tag: tagName,
    text: labelText,
    role,
    cssPath: getCssPath(el),
    attrs: {
      id: el.id || '',
      name: el.getAttribute('name') || '',
      'data-testid': el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy') || ''
    }
  };

  const info = computeElementInfo(el, labelText, text, win);

  const formatted = `[${id}] ${tagName}${type ? `[${type}]` : ''} "${labelText}"${extraAttrs ? ` (${extraAttrs.trim()})` : ''}${inViewport ? '' : ' [off-screen]'}`;

  const summary: FormattedElement = {
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
    formatted
  };

  return { summary, info };
}
