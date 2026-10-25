// src/background/llm/coordinates.ts
// The scale a model points with when it clicks on a picture.
//
// Vision models do not agree on what a click coordinate means. Claude and GPT answer in pixels of
// the picture they were given. NVIDIA's Nemotron VL, Qwen3-VL and Gemini were trained to point on
// a 0-1000 scale of the picture, whatever its size, and they keep doing it when a prompt asks for
// pixels. Measured with Nemotron 3.5 Super VL on a 1372x858 picture: asked for pixels, it answered
// (950, 965) for a button at (1307, 827), which is 950/1000 and 965/1000 of the picture. Read as
// pixels that click lands 360 px left of the button; read on its own scale it is on the button.
// The same model also answers 0-1 fractions (0.9577, 0.9441) now and then, for the same point.
//
// So the scale is a property of the model, the tool text asks for the scale the model already
// uses, and the reading below accepts the fraction form too. Everything after this module works in
// picture pixels, so the frame check and the mapping to the viewport stay as they are.

import { providerOf } from './settings.ts';
import type { LlmSettings } from './types.ts';

/** 'pixels': x and y are pixels of the picture. 'per-mille': x and y are 0-1000 of its width and height. */
export type CoordinateSpace = 'pixels' | 'per-mille';

/** How a coordinate was read, for the tool result and the log. */
export type CoordinateReading = 'pixels' | 'per-mille' | 'fraction';

/** The model names that point on a 0-1000 scale. */
const PER_MILLE_MODELS: RegExp[] = [
  /nemotron[^/]*(?:-vl|vision)/i,
  /qwen3[-.]?vl/i,
  /gemini/i,
  /glm-4\.\dv/i
];

/** The scale the configured model points with. Gemini as a provider is always per-mille. */
export function coordinateSpaceOf(settings: Partial<LlmSettings> | null | undefined): CoordinateSpace {
  if (!settings) return 'pixels';
  if (providerOf(settings as LlmSettings) === 'gemini') return 'per-mille';
  const model = String(settings.model || '');
  return PER_MILLE_MODELS.some((re) => re.test(model)) ? 'per-mille' : 'pixels';
}

/**
 * A model's coordinate as a pixel of the picture.
 *
 * Both values in [0, 1] with at least one not a whole number is a fraction of the picture, in
 * either space: no model means "the pixel at (0.95, 0.94)". Otherwise the space decides.
 */
export function toPicturePixels(
  space: CoordinateSpace,
  x: number,
  y: number,
  image: { width: number; height: number }
): { x: number; y: number; reading: CoordinateReading } {
  const fraction = x >= 0 && x <= 1 && y >= 0 && y <= 1 && (!Number.isInteger(x) || !Number.isInteger(y));
  if (fraction) return { x: x * image.width, y: y * image.height, reading: 'fraction' };
  if (space === 'per-mille') return { x: (x * image.width) / 1000, y: (y * image.height) / 1000, reading: 'per-mille' };
  return { x, y, reading: 'pixels' };
}

/** How the model is told to give a coordinate, in the click tool and the prompt. */
export function coordinateWords(space: CoordinateSpace): { x: string; y: string; rule: string; example: string } {
  if (space === 'per-mille') {
    return {
      x: 'Horizontal position on the last take_screenshot picture, 0 (left edge) to 1000 (right edge)',
      y: 'Vertical position on the last take_screenshot picture, 0 (top edge) to 1000 (bottom edge)',
      rule: 'x and y are positions on a 0-1000 scale of the picture: (0, 0) is its top left corner and (1000, 1000) its bottom right corner, whatever its size. Aim at the center of the target',
      example: 'click {x: 590, y: 402}'
    };
  }
  return {
    x: 'The x pixel in the picture from take_screenshot',
    y: 'The y pixel in the picture from take_screenshot',
    rule: 'x and y are pixels in the picture you were given, counted from its top left. Aim at the center of the target',
    example: 'click {x: 812, y: 344}'
  };
}

/** The text that goes with a picture: its size, and how a coordinate on it is given. */
export function pictureCaption(space: CoordinateSpace, width: number, height: number): string {
  return space === 'per-mille'
    ? `Here is the picture of the page (${width}x${height}). To click on it, give x and y on a 0-1000 scale of the picture.`
    : `Here is the picture of the page (${width}x${height}). Coordinates you read off it are pixels in this picture.`;
}
