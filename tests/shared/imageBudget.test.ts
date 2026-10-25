/**
 * The image budget: src/shared/imageBudget.ts.
 *
 * A screenshot is scaled into a token budget before a model sees it. This is the arithmetic
 * that decides the size, so it is tested against the numbers rather than against a formula
 * copied from the implementation.
 *
 * What these tests hold on to:
 *   1. One token cell is 28 pixels, and an axis costs one cell per 28 pixels after the first.
 *   2. A picture already inside the budget is not touched at all.
 *   3. A square picture is stopped by the TOKEN cap, not the pixel cap: 39 by 39 cells is 1,521
 *      tokens and 40 by 40 is 1,600, so the widest square is 1,092 pixels, not 1,568.
 *   4. A very wide, very short picture is stopped by the PIXEL cap: its token count is tiny, and
 *      only the 1,568-pixel side limit applies.
 *   5. A shrunk picture has a width that is a whole number of token cells, so a model that pads
 *      to a multiple of 28 does not resize it again.
 *   6. The result is never larger than the input on either axis, and never over either cap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_BUDGET,
  fitToBudget,
  imageTokens,
  scaleForTarget,
  tokensPerAxis
} from '../../src/shared/imageBudget.ts';

test('the budget is 28 pixels per token, 1568 pixels, 1568 tokens', () => {
  assert.deepEqual(IMAGE_BUDGET, { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 });
});

test('one token cell is 28 pixels, and the axis grows by one cell per 28 pixels after that', () => {
  assert.equal(tokensPerAxis(0), 0);
  assert.equal(tokensPerAxis(1), 1);
  assert.equal(tokensPerAxis(27), 1);
  assert.equal(tokensPerAxis(28), 1);
  assert.equal(tokensPerAxis(29), 2);
  assert.equal(tokensPerAxis(56), 2);
  assert.equal(tokensPerAxis(57), 3);
  // 1568 is exactly 56 cells, which is why the pixel cap needs no rounding.
  assert.equal(tokensPerAxis(1568), 56);
  // 1092 is exactly 39 cells: the widest square the token cap allows.
  assert.equal(tokensPerAxis(1092), 39);
});

test('a nonsense axis costs nothing rather than NaN', () => {
  assert.equal(tokensPerAxis(-10), 0);
  assert.equal(tokensPerAxis(Number.NaN), 0);
  assert.equal(tokensPerAxis(100, 0), 0);
});

test('the tokens of a picture are the product of its two axes', () => {
  assert.equal(imageTokens(28, 28), 1);
  assert.equal(imageTokens(1092, 1092), 39 * 39);
  assert.equal(imageTokens(1092, 1092), 1521);
});

test('a picture already inside the budget comes back exactly as it was', () => {
  // 1280 by 720 is the size the e2e harness runs at today: 46 by 26 cells is 1,196 tokens.
  assert.deepEqual(fitToBudget(1280, 720), { width: 1280, height: 720 });
  assert.equal(imageTokens(1280, 720) <= IMAGE_BUDGET.maxTargetTokens, true);
  // A small picture is not enlarged to fill the budget either.
  assert.deepEqual(fitToBudget(320, 200), { width: 320, height: 200 });
});

test('a square picture is stopped by the token cap, not the pixel cap', () => {
  // 39 by 39 cells is 1,521 tokens and fits; 40 by 40 is 1,600 and does not.
  // So the widest square is 39 cells = 1,092 pixels, well under the 1,568 pixel cap.
  const out = fitToBudget(3024, 3024);
  assert.deepEqual(out, { width: 1092, height: 1092 });
  assert.equal(imageTokens(out.width, out.height) <= IMAGE_BUDGET.maxTargetTokens, true);
  assert.equal(imageTokens(out.width, out.height), 1521);

  // One cell wider would not fit, so the result is the largest square that does.
  assert.equal(imageTokens(1120, 1120) > IMAGE_BUDGET.maxTargetTokens, true);
});

test('a very wide, very short picture is stopped by the pixel cap', () => {
  // 2,000 by 10 is 72 by 1 cells, which is 72 tokens: the token cap is nowhere near.
  // Only the 1,568-pixel side limit applies, and the width lands on 56 whole cells.
  const out = fitToBudget(2000, 10);
  assert.equal(out.width, 1568);
  assert.equal(out.width, 56 * 28);
  assert.equal(out.width <= IMAGE_BUDGET.maxTargetPx, true);
  assert.equal(imageTokens(out.width, out.height) <= IMAGE_BUDGET.maxTargetTokens, true);
});

test('a shrunk picture has a width that is a whole number of token cells', () => {
  // A retina 16:9 capture. The result must be a multiple of 28 so a model that pads to a
  // multiple of 28 does not resize it again and move every coordinate.
  const out = fitToBudget(1920, 1080);
  assert.equal(out.width % 28, 0, `width ${out.width} must be a multiple of 28`);
  assert.equal(imageTokens(out.width, out.height) <= IMAGE_BUDGET.maxTargetTokens, true);
  assert.equal(out.width <= IMAGE_BUDGET.maxTargetPx, true);
  // It is the largest such width: one more cell would break the token cap.
  const wider = out.width + 28;
  const widerHeight = Math.round((wider * 1080) / 1920);
  assert.equal(imageTokens(wider, widerHeight) > IMAGE_BUDGET.maxTargetTokens, true);
});

test('a retina 3024 by 1720 capture fits the budget and keeps its shape', () => {
  const out = fitToBudget(3024, 1720);
  assert.equal(out.width <= 1568, true);
  assert.equal(imageTokens(out.width, out.height) <= 1568, true);
  assert.equal(out.width % 28, 0);
  // The aspect ratio is kept to within a pixel of rounding.
  const expected = Math.round((out.width * 1720) / 3024);
  assert.equal(Math.abs(out.height - expected) <= 1, true);
});

test('the result is never larger than the input', () => {
  const shapes: Array<[number, number]> = [[4000, 3000], [3000, 4000], [200, 5000], [1920, 1080], [1, 1], [5000, 1]];
  for (const [w, h] of shapes) {
    const out = fitToBudget(w, h);
    assert.ok(out.width <= w, `${w}x${h} came back wider (${out.width})`);
    assert.ok(out.height <= h, `${w}x${h} came back taller (${out.height})`);
    assert.ok(out.width >= 1 && out.height >= 1, `${w}x${h} came back empty`);
  }
});

test('every result is inside both caps, whatever shape it started as', () => {
  const shapes: Array<[number, number]> = [
    [3024, 1720], [1720, 3024], [3840, 2160], [1569, 883], [1568, 1568],
    [1120, 1120], [1093, 900], [2000, 10], [100, 10000], [1, 5000], [9999, 9999]
  ];
  for (const [w, h] of shapes) {
    const out = fitToBudget(w, h);
    assert.ok(out.width <= IMAGE_BUDGET.maxTargetPx, `${w}x${h} -> width ${out.width} over the pixel cap`);
    assert.ok(out.height <= IMAGE_BUDGET.maxTargetPx, `${w}x${h} -> height ${out.height} over the pixel cap`);
    assert.ok(
      imageTokens(out.width, out.height) <= IMAGE_BUDGET.maxTargetTokens,
      `${w}x${h} -> ${out.width}x${out.height} is ${imageTokens(out.width, out.height)} tokens`
    );
  }
});

test('an empty size gives an empty size, not an exception', () => {
  assert.deepEqual(fitToBudget(0, 100), { width: 0, height: 0 });
  assert.deepEqual(fitToBudget(-5, 10), { width: 0, height: 0 });
  assert.deepEqual(fitToBudget(Number.NaN, 10), { width: 0, height: 0 });
});

test('the scale for the real capture comes from the measured size, not from a rule', () => {
  // A 3024-pixel capture of a 1512-pixel viewport came out at exactly twice the CSS pixels.
  // To land on 1456 the second capture is scaled by 1456 / 3024.
  assert.equal(scaleForTarget({ width: 1456, height: 828 }, { width: 3024, height: 1720 }), 1456 / 3024);
  // A capture that already is the target size needs no second one.
  assert.equal(scaleForTarget({ width: 1280, height: 720 }, { width: 1280, height: 720 }), 1);
  // A missing measurement is not a scale of zero: the capture is left alone.
  assert.equal(scaleForTarget({ width: 100, height: 100 }, { width: 0, height: 0 }), 1);
});
