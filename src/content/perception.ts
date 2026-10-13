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
  const formKind = computeFormKind(el);
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

  const info: ElementInfoRecord = {
    role,
    label: labelText,
    formKind,
    fieldKind,
    hrefDomain
  };

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
