/**
 * The fail-fast tool-schema check (llm/index.ts, assertToolSchema): before any tool list is sent to
 * a provider, every `inputSchema` is validated so a `null` where an array (or object) is required
 * never reaches the wire and dies there as an opaque HTTP 400. Instead the run ends with a clear
 * local error that names the tool and the offending field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertToolSchema } from '../../src/background/llm/index.ts';

function tool(name: string, inputSchema: any) {
  return { name, inputSchema };
}

test('every current ScoutFox tool schema passes (get_page_text with empty properties included)', () => {
  assert.doesNotThrow(() => assertToolSchema(tool('get_page_text', { type: 'object', properties: {}, additionalProperties: false })));
  assert.doesNotThrow(() => assertToolSchema(tool('get_page_elements', { type: 'object', properties: {}, additionalProperties: false })));
  assert.doesNotThrow(() => assertToolSchema(tool('read_page_text', { type: 'object', properties: {}, additionalProperties: false })));
  assert.doesNotThrow(() => assertToolSchema(tool('update_plan', {
    type: 'object',
    properties: { plan: { type: 'array', items: { type: 'string' } }, requires_approval: { type: 'boolean', default: true } },
    required: ['plan'],
    additionalProperties: false
  })));
  assert.doesNotThrow(() => assertToolSchema(tool('scroll', {
    type: 'object',
    properties: { direction: { type: 'string', enum: ['up', 'down'] }, reason: { type: 'string' } },
    required: ['direction'],
    additionalProperties: false
  })));
});

test('a null value where an array is required is rejected, naming the tool and the field', () => {
  assert.throws(
    () => assertToolSchema(tool('get_page_text', { type: 'object', properties: {}, required: null, additionalProperties: false })),
    /Tool "get_page_text": inputSchema.required must be an array of strings/
  );
  assert.throws(
    () => assertToolSchema(tool('find', { type: 'object', properties: { query: { type: 'string' } }, enum: null, additionalProperties: false })),
    /Tool "find": inputSchema.enum must be an array/
  );
  assert.throws(
    () => assertToolSchema(tool('x', { type: 'object', properties: {}, allOf: null })),
    /inputSchema.allOf must be an array of schema objects/
  );
});

test('an array property whose items is null is rejected', () => {
  assert.throws(
    () => assertToolSchema(tool('click', { type: 'object', properties: { element_id: { type: 'array', items: null } }, required: ['element_id'], additionalProperties: false })),
    /inputSchema.properties.element_id.items must be a schema object/
  );
});

test('a malformed schema object is rejected', () => {
  assert.throws(() => assertToolSchema(tool('x', null)), /must be an object$/);
  assert.throws(() => assertToolSchema(tool('x', { type: 'object', properties: null })), /inputSchema.properties must be an object/);
  assert.throws(() => assertToolSchema(tool('x', { type: 'array', properties: {} })), /inputSchema.type must be "object"/);
  assert.throws(
    () => assertToolSchema(tool('x', { type: 'object', properties: {}, required: ['plan', 5] })),
    /inputSchema.required must be an array of strings/
  );
});
