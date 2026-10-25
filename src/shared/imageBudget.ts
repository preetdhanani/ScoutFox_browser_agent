// src/shared/imageBudget.ts
// The image budget: how large a screenshot may be before it is sent to a model.
//
// A vision model is billed per token, and an image costs about one token per 28 by 28 pixel
// cell. A full-resolution retina capture is far over any sane budget: a 3024 by 1720 picture is
// 108 by 62 cells, which is 6,696 tokens for one look at the page, and the same picture is sent
// again on every later round.
//
// So a capture is scaled down into the budget before it is sent, and this module owns that
// arithmetic. It has no imports, the same shape as src/shared/answerText.ts, so the background
// and the tests can both use it without Chrome.
//
// Two caps, both of which must hold:
//   - every side stays at or under maxTargetPx, so a wide or tall capture still fits a model's
//     per-axis limit;
//   - the token count stays at or under maxTargetTokens.
// Which cap limits a given picture is read from the arithmetic, not assumed: a very wide short
// picture is stopped by the pixel cap alone, a square one by the token cap.

/** The caps one picture has to fit. */
export interface ImageBudget {
  /** How many pixels of one axis make one token. 28 is the pixel size of a vision model's token cell. */
  pxPerToken: number;
  /** The longest side a picture may have. */
  maxTargetPx: number;
  /** The most tokens a picture may cost. */
  maxTargetTokens: number;
}

/** The budget a screenshot is fitted to, the same numbers Claude in Chrome uses. */
export const IMAGE_BUDGET: ImageBudget = {
  pxPerToken: 28,
  maxTargetPx: 1568,
  maxTargetTokens: 1568
};

/**
 * The tokens one axis of px pixels costs: floor((px - 1) / pxPerToken) + 1.
 *
 * A 1 pixel axis is one cell, and an axis grows by one cell every pxPerToken pixels after that,
 * so 28 is one cell, 29 is two, 56 is two and 57 is three. An empty or negative axis costs
 * nothing.
 */
export function tokensPerAxis(px: number, pxPerToken = IMAGE_BUDGET.pxPerToken): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  if (!Number.isFinite(pxPerToken) || pxPerToken <= 0) return 0;
  return Math.floor((px - 1) / pxPerToken) + 1;
}

/** The tokens a w by h picture costs: the product of the two axes, as the models count it. */
export function imageTokens(w: number, h: number, pxPerToken = IMAGE_BUDGET.pxPerToken): number {
  return tokensPerAxis(w, pxPerToken) * tokensPerAxis(h, pxPerToken);
}

/** The shape of a picture: its size on both axes. */
export interface ImageSize {
  width: number;
  height: number;
}

/** Whether a size is inside both caps. */
function withinBudget(width: number, height: number, budget: ImageBudget): boolean {
  return (
    width <= budget.maxTargetPx &&
    height <= budget.maxTargetPx &&
    imageTokens(width, height, budget.pxPerToken) <= budget.maxTargetTokens
  );
}

/** The height that follows the input's aspect ratio at a given width, never below one pixel. */
function heightAt(width: number, height: number, atWidth: number): number {
  return Math.max(1, Math.round((atWidth * height) / width));
}

/** The largest width that fits both caps at the input's aspect ratio, by binary search. */
function widestFitting(width: number, height: number, budget: ImageBudget): number {
  let lo = 1;
  let hi = Math.min(width, budget.maxTargetPx);
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (withinBudget(mid, heightAt(width, height, mid), budget)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * The largest picture that fits both caps while keeping the input's shape.
 *
 * A size already inside the budget comes back exactly as it was: a capture that does not need
 * to shrink is not touched, so no pixel is thrown away for nothing.
 *
 * A picture that has to shrink has its width rounded DOWN to a whole number of token cells
 * (a multiple of pxPerToken), and its height derived from the aspect ratio.
 * Some vision models pad the picture they are given up to a multiple of 28 (Qwen2.5-VL among
 * them), so an aligned width is a picture the model does not resize again. The result is never
 * larger than the input on either axis.
 */
export function fitToBudget(deviceWidth: number, deviceHeight: number, budget: ImageBudget = IMAGE_BUDGET): ImageSize {
  const width = Math.floor(Number(deviceWidth));
  const height = Math.floor(Number(deviceHeight));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  if (withinBudget(width, height, budget)) return { width, height };

  const best = widestFitting(width, height, budget);
  if (best <= 0) return { width: 1, height: 1 };

  // Align down to a whole number of cells. The aligned width is one cell-or-more smaller than
  // the widest that fits, so it fits too; the loop is a guard, not the normal path, and it also
  // covers a picture narrower than one cell, where there is no aligned width to use.
  const cell = Math.max(1, Math.floor(budget.pxPerToken));
  let aligned = best >= cell ? Math.floor(best / cell) * cell : best;
  while (aligned >= 1 && !withinBudget(aligned, heightAt(width, height, aligned), budget)) {
    aligned = aligned >= cell ? aligned - cell : aligned - 1;
  }
  if (aligned < 1) return { width: 1, height: 1 };
  return { width: aligned, height: heightAt(width, height, aligned) };
}

/**
 * The scale a capture at a known measured size needs so its output lands on the target size:
 * targetWidth / measuredWidth. 1 means the capture is already the size it should be.
 *
 * The measured size is what the browser actually produced, so this is what turns "how big it
 * came out" into "how much to scale the next capture", with no rule about what the device
 * pixel ratio should have been.
 */
export function scaleForTarget(target: ImageSize, measured: ImageSize): number {
  if (measured.width <= 0 || target.width <= 0) return 1;
  return target.width / measured.width;
}
