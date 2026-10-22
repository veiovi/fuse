// The Fuse glyph: a cartridge fuse on an ink tile. One geometry feeds both
// the inline SVG used by the popup and in-page card, and the PNG toolbar icons
// rasterized at build time (scripts/icons.js).

export const GLYPH_SIZE = 128;

export const GLYPH_COLORS = {
  tile: '#141b2d',
  glass: '#46577f',
  glint: '#6b7ca6',
  filament: '#f5a524',
  cap: '#e4e8f0',
};

const AXIS = { angle: -45, cx: 64, cy: 64 };

/** Rounded rectangles in a 128 x 128 box, back to front. `rotate` is about (cx, cy) in degrees. */
export const GLYPH_SHAPES = [
  { x: 0, y: 0, w: 128, h: 128, r: 28, fill: GLYPH_COLORS.tile },
  { x: 30, y: 47, w: 68, h: 34, r: 4, fill: GLYPH_COLORS.glass, rotate: AXIS },
  { x: 34, y: 51, w: 60, h: 4, r: 2, fill: GLYPH_COLORS.glint, rotate: AXIS },
  { x: 32, y: 61, w: 64, h: 6, r: 3, fill: GLYPH_COLORS.filament, rotate: AXIS },
  { x: 13, y: 44, w: 24, h: 40, r: 6, fill: GLYPH_COLORS.cap, rotate: AXIS },
  { x: 91, y: 44, w: 24, h: 40, r: 6, fill: GLYPH_COLORS.cap, rotate: AXIS },
];

/** Inline SVG markup for the glyph (static, no user data). */
export function glyphSvg(size = 20) {
  const shapes = GLYPH_SHAPES.map(({ x, y, w, h, r, fill, rotate }) => {
    const transform = rotate ? ` transform="rotate(${rotate.angle} ${rotate.cx} ${rotate.cy})"` : '';
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${transform}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}" width="${size}" height="${size}" aria-hidden="true" focusable="false">${shapes}</svg>`;
}
