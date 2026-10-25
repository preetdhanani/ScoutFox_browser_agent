/**
 * redact.ts: Sanitization and redaction of sensitive credentials and PII.
 */

export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'token',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'ssn',
  'card',
  'cvv'
];

/**
 * Deeply clone an object or array, redacting any properties whose keys match sensitive terms.
 * Every string leaf (and a top-level string) also gets value-level redaction, so a Bearer
 * token, a JWT or a `password=...` pair under an innocent key name does not leak.
 * Never mutates input.
 */
export function redactObject<T>(obj: T, sensitiveKeys: readonly string[] = SENSITIVE_KEYS): T {
  if (typeof obj === 'string') return redactString(obj, sensitiveKeys) as unknown as T;
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, sensitiveKeys)) as unknown as T;
  }

  const copy: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const isSensitive = sensitiveKeys.some((s) => k.toLowerCase().includes(s));
    if (isSensitive) {
      copy[k] = '[REDACTED]';
    } else {
      copy[k] = redactObject(v, sensitiveKeys);
    }
  }
  return copy as T;
}

/**
 * Value-level redaction of free text: quoted JSON fields, key=value / key: value pairs
 * (form bodies, cookie strings, header lines), Bearer tokens and bare JWTs.
 */
function redactString(input: string, sensitiveKeys: readonly string[]): string {
  let str = input;
  for (const key of sensitiveKeys) {
    // Double-quoted JSON value ("key":"value") - catches single fields embedded in text.
    const regex = new RegExp(`("${key}"\\s*:\\s*")([^"]+)(")`, 'gi');
    str = str.replace(regex, '$1[REDACTED]$3');
    // Non-JSON string forms (BUG-22): form bodies (`password=hunter2` with
    // &/;/newline separators), cookie strings and single-quoted values. The
    // key matches with optional -/_ separators (api_key, csrftoken), the
    // value runs to the next separator or quote, so neighbouring pairs
    // survive.
    const flexible = key.split('').join('[-_]?');
    const plain = new RegExp(
      `((?:${flexible})\\s*["']?\\s*[=:]\\s*["']?)([^&;\\r\\n"']+)`,
      'gi',
    );
    str = str.replace(plain, '$1[REDACTED]');
  }
  // Bearer / JWT tokens in header text (e.g. "Bearer eyJ..."), plus bare
  // JWTs (base64url JSON header always starts with eyJ).
  str = str.replace(
    /(bearer\s+)[A-Za-z0-9\-_+=/.]{8,}/gi,
    '$1[REDACTED]',
  );
  str = str.replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
    '[REDACTED]',
  );
  return str;
}

/**
 * Redact sensitive data from JSON strings, regex-matched key-value strings, or object structures.
 * A string that parses as JSON is redacted by key name AND by value on every string leaf.
 * Falsy values are returned as-is.
 */
export function redactSensitiveData<T>(data: T, sensitiveKeys: readonly string[] = SENSITIVE_KEYS): T {
  if (!data) return data;

  if (typeof data === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (_) {
      return redactString(data, sensitiveKeys) as unknown as T;
    }
    return JSON.stringify(redactObject(parsed, sensitiveKeys)) as unknown as T;
  }

  if (typeof data === 'object') {
    return redactObject(data, sensitiveKeys);
  }

  return data;
}

/** Query or fragment parameter names that carry a credential even though no SENSITIVE_KEYS term matches. */
const SENSITIVE_URL_PARAMS: ReadonlySet<string> = new Set([
  'key', 'auth', 'sig', 'signature', 'session', 'sessionid', 'sid', 'code', 'otp', 'pin', 'jwt', 'credential', 'credentials'
]);

function isSensitiveUrlParam(name: string, sensitiveKeys: readonly string[]): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch (_) {}
  const norm = decoded.toLowerCase().replace(/[-_.\s]/g, '');
  if (!norm) return false;
  return SENSITIVE_URL_PARAMS.has(norm) || norm.endsWith('apikey') || sensitiveKeys.some((s) => norm.includes(s));
}

/**
 * Redact the values of sensitive query and fragment parameters in a URL
 * (?access_token=..., #id_token=..., &api_key=...). The path and every other
 * parameter stay as they are, so the line still says which endpoint was hit.
 */
export function redactUrl(url: string, sensitiveKeys: readonly string[] = SENSITIVE_KEYS): string {
  if (!url) return url;
  const firstSep = url.search(/[?#]/);
  if (firstSep < 0) return url;
  const head = url.slice(0, firstSep);
  const tail = url.slice(firstSep).replace(
    /([?&#;])([^=&#;]+)=([^&#;]*)/g,
    (whole, sep: string, name: string, value: string) =>
      value && isSensitiveUrlParam(name, sensitiveKeys) ? `${sep}${name}=[REDACTED]` : whole
  );
  return head + tail;
}
