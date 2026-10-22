// Tiny DOM builders shared by the popup and the in-page card. Text always goes
// in through textContent; nothing is parsed as HTML.
import { GLYPH_SHAPES, GLYPH_SIZE } from './glyph.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('button', { class: 'primary', onclick }, 'Allow') */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** The Fuse glyph as an SVG element. */
export function glyph(size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  for (const { x, y, w, h: height, r, fill, rotate } of GLYPH_SHAPES) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x, y, width: w, height, rx: r, fill })) rect.setAttribute(k, String(v));
    if (rotate) rect.setAttribute('transform', `rotate(${rotate.angle} ${rotate.cx} ${rotate.cy})`);
    svg.append(rect);
  }
  return svg;
}

/**
 * Slot meter: one segment per slot for small budgets, a bar otherwise.
 * `remaining` segments are filled.
 */
export function meter({ limit, remaining }, className = 'meter') {
  const level = remaining === 0 ? 'empty' : remaining / limit <= 0.2 ? 'low' : 'ok';
  const label = `${remaining} of ${limit} slots left today`;
  if (limit <= 30) {
    const segments = Array.from({ length: limit }, (_, i) => h('span', { class: i < remaining ? 'seg on' : 'seg' }));
    return h('div', { class: `${className} segments ${level}`, role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(remaining) }, segments);
  }
  const fill = h('span', { class: 'fill' });
  fill.style.width = `${(100 * remaining) / limit}%`;
  return h('div', { class: `${className} bar ${level}`, role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(remaining) }, fill);
}
