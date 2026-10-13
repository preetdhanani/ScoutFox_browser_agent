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
 * Never mutates input.
 */
export function redactObject<T>(obj: T, sensitiveKeys: readonly string[] = SENSITIVE_KEYS): T {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, sensitiveKeys)) as unknown as T;
  }

  const copy: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const isSensitive = sensitiveKeys.some((s) => k.toLowerCase().includes(s));
    if (isSensitive) {
      copy[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      copy[k] = redactObject(v, sensitiveKeys);
    } else {
      copy[k] = v;
    }
  }
  return copy as T;
}

/**
 * Redact sensitive data from JSON strings, regex-matched key-value strings, or object structures.
 * Falsy values are returned as-is.
 */
export function redactSensitiveData<T>(data: T, sensitiveKeys: readonly string[] = SENSITIVE_KEYS): T {
  if (!data) return data;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      const redacted = redactObject(parsed, sensitiveKeys);
      return JSON.stringify(redacted) as unknown as T;
    } catch (_) {
      let str = data as string;
      for (const key of sensitiveKeys) {
        // Double-quoted JSON value ("key":"value") - the JSON.parse branch above
        // covers well-formed objects, this catches single fields embedded in text.
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
      return str as unknown as T;
    }
  }

  if (typeof data === 'object') {
    return redactObject(data, sensitiveKeys);
  }

  return data;
}
