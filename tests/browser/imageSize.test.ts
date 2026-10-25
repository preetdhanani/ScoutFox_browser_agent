/**
 * The image header decoder: src/background/browser/imageSize.ts.
 *
 * The capture cannot trust a computed size. CDP's clip scale and the device pixel ratio do not
 * combine the way the schema's wording suggests, and a size that is wrong by a factor of two
 * makes every coordinate read off the picture land in the wrong place. So the size is read out
 * of the image that actually came back.
 *
 * What these tests hold on to:
 *   1. A real JPEG header gives the width and height it holds.
 *   2. A real PNG header gives the width and height it holds.
 *   3. A data: URL works the same as bare base64.
 *   4. A truncated, unknown or non-image input returns null, never a guessed size.
 *   5. The decoder never throws, whatever it is given.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeImageSize } from '../../src/background/browser/imageSize.ts';

/** The bytes of a minimal but real JPEG that carries a frame header of w by h. */
function jpegBytes(w: number, h: number): number[] {
  return [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0, length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // "JFIF" + version + density
    0xff, 0xc0, 0x00, 0x11, // SOF0, length 17
    0x08, // precision
    (h >> 8) & 0xff, h & 0xff, // height, big-endian
    (w >> 8) & 0xff, w & 0xff, // width, big-endian
    0x03, // three components
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
    0xff, 0xd9 // EOI
  ];
}

/** The bytes of a PNG signature and IHDR chunk of w by h. The CRC is not read, so it is zeroes. */
function pngBytes(w: number, h: number): number[] {
  return [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length 13
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    (w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff, // width, big-endian
    (h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff, // height, big-endian
    0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, colour type, compression, filter, interlace
    0x00, 0x00, 0x00, 0x00 // CRC
  ];
}

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');

test('a JPEG header gives its real width and height', () => {
  assert.deepEqual(decodeImageSize(b64(jpegBytes(1568, 892))), { width: 1568, height: 892 });
});

test('a JPEG header gives a size that does not fit one byte per axis', () => {
  // 3024 does not fit a byte: the 16-bit big-endian read has to be right, not merely close.
  assert.deepEqual(decodeImageSize(b64(jpegBytes(3024, 1720))), { width: 3024, height: 1720 });
});

test('a PNG header gives its real width and height', () => {
  assert.deepEqual(decodeImageSize(b64(pngBytes(1280, 720))), { width: 1280, height: 720 });
  assert.deepEqual(decodeImageSize(b64(pngBytes(1, 1))), { width: 1, height: 1 });
});

test('a data URL is read the same as bare base64', () => {
  const bare = b64(pngBytes(640, 480));
  assert.deepEqual(decodeImageSize(`data:image/png;base64,${bare}`), { width: 640, height: 480 });
});

test('a truncated JPEG returns null instead of a size it did not read', () => {
  const full = jpegBytes(800, 600);
  // Cut in the middle of the frame header: the size bytes are not all there.
  assert.equal(decodeImageSize(b64(full.slice(0, 24))), null);
  // Only the two start-of-image bytes.
  assert.equal(decodeImageSize(b64([0xff, 0xd8])), null);
});

test('a truncated PNG returns null instead of a size it did not read', () => {
  const full = pngBytes(800, 600);
  assert.equal(decodeImageSize(b64(full.slice(0, 16))), null);
});

test('an input that is not an image returns null', () => {
  assert.equal(decodeImageSize(''), null);
  assert.equal(decodeImageSize('not base64 at all !!!'), null);
  assert.equal(decodeImageSize(b64(Array.from(Buffer.from('hello world, this is plain text')))), null);
  // A GIF is a real image but not one Chrome captures, and its size lives elsewhere.
  assert.equal(decodeImageSize(b64(Array.from(Buffer.from('GIF89a')))), null);
});

test('the decoder never throws, whatever it is handed', () => {
  const inputs: unknown[] = [null, undefined, 42, {}, 'data:image/jpeg;base64,', 'A'.repeat(1000)];
  for (const input of inputs) {
    assert.doesNotThrow(() => decodeImageSize(input as string));
  }
});

test('a size of zero is refused, because no picture has one', () => {
  assert.equal(decodeImageSize(b64(pngBytes(0, 0))), null);
  assert.equal(decodeImageSize(b64(jpegBytes(0, 600))), null);
});
