/**
 * A small JSON-schema checker for the tests, covering exactly the keywords the ScoutFox schemas
 * use (background/actionSchema.js). The root package has no dependencies, so ajv is only used
 * by the opt-in eval (tests/evals). `oneOf` follows the spec: exactly one branch must match.
 *
 * Any other keyword is reported by unsupportedKeywords(), so a new keyword in the registry
 * cannot slip past these tests without the checker learning it first.
 */

export const SUPPORTED_KEYWORDS = new Set([
  'type', 'const', 'enum', 'minimum', 'maximum', 'pattern', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'oneOf'
]);

function typeMatches(type, value) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    default: throw new Error(`miniJsonSchema: unknown type "${type}"`);
  }
}

/** Returns a list of error strings; empty means the value matches the schema. */
export function validate(schema, value, path = '$') {
  const errors = [];
  if (schema.oneOf) {
    const matching = schema.oneOf.filter((branch) => validate(branch, value, path).length === 0).length;
    if (matching !== 1) errors.push(`${path}: matches ${matching} oneOf branches, expected exactly 1`);
  }
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}`);
    return errors;
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
    errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validate(props[key], v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected "${key}"`);
    }
  }
  return errors;
}

/** Every keyword used anywhere in the schema that validate() does not understand. */
export function unsupportedKeywords(schema) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) found.add(key);
      if (key === 'properties') Object.values(child).forEach(walk);
      else if (key === 'items') walk(child);
      else if (key === 'oneOf') child.forEach(walk);
    }
  };
  walk(schema);
  return [...found];
}

/** Every sub-schema (the node itself included), for "never X anywhere" checks. */
export function allSubschemas(schema) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    out.push(node);
    if (node.properties) Object.values(node.properties).forEach(walk);
    if (node.items) walk(node.items);
    if (node.oneOf) node.oneOf.forEach(walk);
  };
  walk(schema);
  return out;
}
