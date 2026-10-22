// Schematic plots of a credential's secret line y = k + a·x.
//
// A burned key: its two shares from one slot lie on one line, and that line
// meets the y-axis at the key. Field values are 254-bit numbers, so the
// positions here are derived from the real values (stable for each key) but
// are not to scale; the page prints the truncated real values beside the plot.

const W = 320;
const H = 172;
const AXIS_X = 30; // the y-axis
const TOP = 14;
const BASE = 150; // the x-axis
const RIGHT = 306;
const GRID = 17;

const fixed = (n) => n.toFixed(1);

/** A number in [0, 1] from 16 bits of a hex value. */
function unit(hex, shift = 0) {
  try {
    return Number((BigInt(hex) >> BigInt(shift)) & 0xffffn) / 0xffff;
  } catch {
    return 0.5;
  }
}

/** Where the key, both shares and the drawn line end sit, in plot coordinates. */
export function lineThroughShares(rev) {
  const [first, second] = rev.shares ?? [];
  const ky = TOP + 30 + unit(rev.secret) * (BASE - TOP - 60);
  const x1 = 116 + unit(first?.x) * 48;
  const x2 = 214 + unit(second?.x) * 64;
  const end = x2 + 16;
  const room = { up: ky - TOP - 6, down: BASE - 6 - ky };
  let dir = unit(rev.nullifier, 16) > 0.5 ? 'up' : 'down';
  if (room[dir] < 40) dir = dir === 'up' ? 'down' : 'up';
  const slope = (room[dir] / (end - AXIS_X)) * (0.55 + 0.4 * unit(rev.nullifier, 32)) * (dir === 'up' ? -1 : 1);
  const yAt = (x) => ky + slope * (x - AXIS_X);
  return { ky, slope, p1: { x: x1, y: yAt(x1) }, p2: { x: x2, y: yAt(x2) }, end: { x: end, y: yAt(end) } };
}

function frame() {
  let grid = '';
  for (let x = AXIS_X + GRID; x <= RIGHT; x += GRID) grid += `M${x} ${TOP}V${BASE}`;
  for (let y = BASE - GRID; y >= TOP; y -= GRID) grid += `M${AXIS_X} ${y}H${RIGHT}`;
  return [
    `<path class="plot-grid" d="${grid}"/>`,
    `<path class="plot-axis" d="M${AXIS_X} ${TOP - 8}V${BASE}H${RIGHT + 8}"/>`,
    `<path class="plot-axis" d="M${AXIS_X - 3.5} ${TOP - 3}L${AXIS_X} ${TOP - 9}L${AXIS_X + 3.5} ${TOP - 3}M${RIGHT + 3} ${BASE - 3.5}L${RIGHT + 9} ${BASE}L${RIGHT + 3} ${BASE + 3.5}"/>`,
    `<text class="plot-axis-label" x="${RIGHT + 8}" y="${BASE + 17}" text-anchor="end">x</text>`,
    `<text class="plot-axis-label" x="${AXIS_X - 9}" y="${TOP + 2}" text-anchor="end">y</text>`,
  ].join('');
}

function point({ x, y }, label, slope) {
  // Put the label on the side of the line with more room.
  const dy = slope < 0 ? 17 : -10;
  return (
    `<circle class="plot-share" cx="${fixed(x)}" cy="${fixed(y)}" r="5"/>` +
    `<text class="plot-share-label" x="${fixed(x)}" y="${fixed(y + dy)}" text-anchor="middle">${label}</text>`
  );
}

/** The burned-key plot. `fresh` adds the classes that animate the reveal. */
export function burnPlot(rev, { fresh = false } = {}) {
  const { ky, slope, p1, p2, end } = lineThroughShares(rev);
  const [first, second] = rev.shares ?? [];
  // Points are labelled with their log entry numbers, as on the tape.
  const label = (share, n) => (Number.isInteger(share?.seq) ? `#${share.seq}` : String(n));
  const labelY = slope < 0 ? ky + 18 : ky - 10;
  return `<svg class="plot${fresh ? ' is-fresh' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Two shares from the same slot lie on one line, which meets the y-axis at the key">
${frame()}
<line class="plot-extension" style="transform-origin:${fixed(p1.x)}px ${fixed(p1.y)}px" x1="${fixed(p1.x)}" y1="${fixed(p1.y)}" x2="${AXIS_X}" y2="${fixed(ky)}"/>
<line class="plot-line" x1="${fixed(p1.x)}" y1="${fixed(p1.y)}" x2="${fixed(end.x)}" y2="${fixed(end.y)}"/>
${point(p1, label(first, 1), slope)}${point(p2, label(second, 2), slope)}
<circle class="plot-key-ring" cx="${AXIS_X}" cy="${fixed(ky)}" r="9"/>
<circle class="plot-key" cx="${AXIS_X}" cy="${fixed(ky)}" r="5.5"/>
<text class="plot-key-label" x="${AXIS_X + 11}" y="${fixed(labelY)}">k</text>
</svg>`;
}

/** Clip y = p.y + s·(x − p.x) to the plot box. */
function clipLine(p, s) {
  let from = AXIS_X;
  let to = RIGHT;
  if (s !== 0) {
    const a = p.x + (TOP - p.y) / s;
    const b = p.x + (BASE - p.y) / s;
    from = Math.max(from, Math.min(a, b));
    to = Math.min(to, Math.max(a, b));
  }
  return { from: { x: from, y: p.y + s * (from - p.x) }, to: { x: to, y: p.y + s * (to - p.x) } };
}

/**
 * The empty state: one share alone. Every line through it is possible, and
 * each meets the axis somewhere else, so one point says nothing about k.
 */
export function onePointPlot() {
  const p = { x: 176, y: 84 };
  const slopes = [-0.42, -0.24, -0.09, 0.07, 0.22, 0.4];
  const lines = slopes.map((s) => clipLine(p, s));
  const guesses = lines.filter((l) => l.from.x === AXIS_X);
  return `<svg class="plot plot--empty" viewBox="0 0 ${W} ${H}" role="img" aria-label="One share alone: many lines pass through it, each meeting the y-axis somewhere else">
${frame()}
${lines.map((l) => `<line class="plot-candidate" x1="${fixed(l.from.x)}" y1="${fixed(l.from.y)}" x2="${fixed(l.to.x)}" y2="${fixed(l.to.y)}"/>`).join('')}
${guesses.map((l) => `<circle class="plot-guess" cx="${AXIS_X}" cy="${fixed(l.from.y)}" r="3.5"/>`).join('')}
<circle class="plot-share" cx="${p.x}" cy="${p.y}" r="5"/>
</svg>`;
}
