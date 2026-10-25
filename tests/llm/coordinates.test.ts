/**
 * The scale a model points with on a picture: src/background/llm/coordinates.ts.
 *
 * Measured in the click lab with Nemotron 3.5 Super VL: asked for pixels of a 1372x858 picture,
 * it answered (950, 965) for a button whose center is (1307, 827). That is 0-1000 of the picture.
 * Read as pixels, every one of its clicks missed; read on its own scale, 22 of 25 hit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateSpaceOf, coordinateWords, pictureCaption, toPicturePixels } from '../../src/background/llm/coordinates.ts';
import { clickToolFor } from '../../src/background/mcp/client.ts';
import { SCOUTFOX_TOOLS } from '../../src/background/mcp/tools.ts';

test('Nemotron VL, Qwen3-VL and Gemini point on a 0-1000 scale; other models in pixels', () => {
  assert.equal(coordinateSpaceOf({ provider: 'nvidia', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' } as any), 'per-mille');
  assert.equal(coordinateSpaceOf({ provider: 'nvidia', model: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1' } as any), 'per-mille');
  assert.equal(coordinateSpaceOf({ provider: 'ollama', model: 'qwen3-vl:8b' } as any), 'per-mille');
  assert.equal(coordinateSpaceOf({ provider: 'gemini', model: 'gemini-2.5-flash' } as any), 'per-mille');
  assert.equal(coordinateSpaceOf({ provider: 'anthropic', model: 'claude-sonnet-5-5' } as any), 'pixels');
  assert.equal(coordinateSpaceOf({ provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b' } as any), 'pixels', 'a text-only Nemotron is not a VL model');
  assert.equal(coordinateSpaceOf(null), 'pixels');
});

test('the measured Nemotron answer lands on the button when read on its scale', () => {
  const image = { width: 1372, height: 858 };
  const button = { left: 1270, top: 814, width: 74, height: 27 };
  for (const [x, y] of [[950, 965], [0.9541, 0.9639]]) {
    const p = toPicturePixels('per-mille', x, y, image);
    assert.ok(p.x >= button.left && p.x <= button.left + button.width, `x ${p.x}`);
    assert.ok(p.y >= button.top && p.y <= button.top + button.height, `y ${p.y}`);
  }
});

test('a fraction is a fraction in either scale; whole 0 and 1 are pixels or per-mille', () => {
  assert.deepEqual(toPicturePixels('pixels', 0.5, 0.25, { width: 1000, height: 800 }), { x: 500, y: 200, reading: 'fraction' });
  assert.deepEqual(toPicturePixels('pixels', 1, 1, { width: 1000, height: 800 }), { x: 1, y: 1, reading: 'pixels' });
  assert.deepEqual(toPicturePixels('per-mille', 500, 500, { width: 1000, height: 800 }), { x: 500, y: 400, reading: 'per-mille' });
  assert.deepEqual(toPicturePixels('pixels', 812, 344, { width: 1000, height: 800 }), { x: 812, y: 344, reading: 'pixels' });
});

test('the click tool and the picture caption ask for the scale the model points with', () => {
  const click = SCOUTFOX_TOOLS.find((tool) => tool.name === 'click')!;
  assert.equal(clickToolFor(click, 'pixels'), click, 'a pixel model gets the tool unchanged');
  const perMille = clickToolFor(click, 'per-mille');
  assert.match(perMille.description, /0-1000 scale/);
  assert.match(perMille.inputSchema.properties.x.description, /0 \(left edge\) to 1000/);
  assert.ok(perMille.inputSchema.properties.element_id, 'element ids are still offered');
  assert.match(pictureCaption('per-mille', 1372, 858), /1372x858.*0-1000/);
  assert.match(pictureCaption('pixels', 1372, 858), /pixels in this picture/);
  assert.match(coordinateWords('per-mille').example, /click \{x: \d+, y: \d+\}/);
});
