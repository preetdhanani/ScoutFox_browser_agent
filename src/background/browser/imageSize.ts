// src/background/browser/imageSize.ts
// Reads the pixel size out of an image's own header.
//
// The capture cannot trust a computed size: CDP's clip scale and the device pixel ratio do not
// combine the way the schema's brief wording suggests, and a size that is wrong by a factor of
// two makes every coordinate read off the picture land in the wrong place. So the size is taken
// from the image that actually came back.
//
// Chrome produces JPEG or PNG, so this reads both, and nothing else:
//   - JPEG: FFD8, then a walk over the marker segments to SOF0..SOF15 (minus the four markers
//     that share that range but are not a frame header), whose payload starts with the height
//     and the width, both 16-bit big-endian, after one precision byte.
//   - PNG: 89504E47 0D0A1A0A, then the IHDR chunk, whose width and height are 32-bit
//     big-endian at offset 16.
//
// It never throws and never guesses. A truncated, unknown or non-image input returns null, so a
// caller can refuse the capture instead of reasoning about a size that is not real.

/** The size of an image, in its own pixels. */
export interface DecodedImageSize {
  width: number;
  height: number;
}

/** The SOF markers that carry a frame header. C4 (Huffman table), C8 (JPEG extension) and CC (arithmetic table) share the range but hold no frame. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

/** The bytes base64 encodes three to four, so a decoded length follows from the length of the text. */
function decodeBase64(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  // A data URL is accepted too, so the same helper serves a stored picture as well as a capture.
  const comma = text.startsWith('data:') ? text.indexOf(',') : -1;
  const body = comma >= 0 ? text.slice(comma + 1) : text;
  const clean = body.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  try {
    // atob is a worker and a page global in the extension's contexts, and present in Node 22.
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (_) {
    return null;
  }
}

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

function pngSize(bytes: Uint8Array): DecodedImageSize | null {
  // The 8-byte signature, then a 4-byte length, then "IHDR", then the 8 bytes of size.
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function jpegSize(bytes: Uint8Array): DecodedImageSize | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let at = 2;
  while (at + 3 < bytes.length) {
    // Every marker starts with FF, and any number of FF bytes may pad it.
    if (bytes[at] !== 0xff) return null;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) return null;
    const marker = bytes[at];
    at++;
    // Standalone markers carry no length: TEM, RST0..RST7, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (at + 1 >= bytes.length) return null;
    const length = u16be(bytes, at);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      // precision (1), height (2), width (2) at the start of the payload.
      if (at + 7 > bytes.length) return null;
      const height = u16be(bytes, at + 3);
      const width = u16be(bytes, at + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    at += length;
  }
  return null;
}

/**
 * The pixel size of a base64 JPEG or PNG, or null when the input is not a whole image whose size
 * can be read. Never throws.
 */
export function decodeImageSize(base64: string): DecodedImageSize | null {
  const bytes = decodeBase64(base64);
  if (!bytes || bytes.length < 4) return null;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngSize(bytes);
    return null;
  } catch (_) {
    return null;
  }
}
