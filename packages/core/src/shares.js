// "Cheating that confesses": two points on y = k + a*x recover k.
import { div, mul, sub, toField } from './field.js';

/** Interpolate the line through two shares and return its value at x = 0. */
export function recoverSecret(first, second) {
  const [x1, y1, x2, y2] = [first.x, first.y, second.x, second.y].map(toField);
  if (x1 === x2) throw new RangeError('shares share an x coordinate; cannot interpolate');
  const slope = div(sub(y1, y2), sub(x1, x2));
  return sub(y1, mul(slope, x1));
}
