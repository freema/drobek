/**
 * The drobek mascot — a crumb on a 16 × 11 pixel grid, the same one www
 * shows. One source of pixels for every place that draws it: the dashboard
 * (`<DrobekMark>`), the favicon and the e-mail layout. E-mail gets it as a
 * table of coloured cells, so it shows even where a client blocks images.
 */
export const MASCOT_COLORS = { body: '#d99a4e', eye: '#2a2119' } as const;

export const MASCOT_WIDTH = 16;
export const MASCOT_HEIGHT = 11;

export interface MascotRect {
  x: number;
  y: number;
  w: number;
  fill: string;
  /** `eye` rects are the eyes; `lid` marks their top row (it blinks). */
  part: 'body' | 'lid' | 'eye' | 'crumb';
}

const BODY_ROWS: ReadonlyArray<readonly [y: number, x: number, w: number]> = [
  [1, 5, 5],
  [2, 3, 9],
  [3, 2, 11],
  [4, 1, 13],
  [5, 1, 13],
  [6, 1, 13],
  [7, 1, 12],
  [8, 2, 11],
  [9, 3, 8],
];

/** Every 1-pixel-high rect of the mascot, body first, then the eyes, then the crumb. */
export const MASCOT_RECTS: readonly MascotRect[] = [
  ...BODY_ROWS.map(([y, x, w]) => ({ x, y, w, fill: MASCOT_COLORS.body, part: 'body' as const })),
  { x: 4, y: 4, w: 1, fill: MASCOT_COLORS.eye, part: 'lid' },
  { x: 9, y: 4, w: 1, fill: MASCOT_COLORS.eye, part: 'lid' },
  { x: 4, y: 5, w: 1, fill: MASCOT_COLORS.eye, part: 'eye' },
  { x: 9, y: 5, w: 1, fill: MASCOT_COLORS.eye, part: 'eye' },
  { x: 15, y: 9, w: 1, fill: MASCOT_COLORS.body, part: 'crumb' },
];

/** The mascot as a standalone SVG document (favicon, `<img>`). */
export function mascotSvg(): string {
  const rects = MASCOT_RECTS.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.fill}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MASCOT_WIDTH} ${MASCOT_HEIGHT}" shape-rendering="crispEdges">${rects}</svg>`;
}

/** The favicon: the mascot as a `data:` URI (no request, no 404). */
export function mascotDataUri(): string {
  return `data:image/svg+xml,${encodeURIComponent(mascotSvg())}`;
}

/** The colour of one pixel, or null where the grid is empty. */
function pixel(x: number, y: number): string | null {
  let fill: string | null = null;
  for (const r of MASCOT_RECTS) if (r.y === y && x >= r.x && x < r.x + r.w) fill = r.fill;
  return fill;
}

/**
 * The mascot as an e-mail-safe table: one row per pixel row (the empty top
 * and bottom rows dropped), each row its own small table so runs of one
 * colour merge into one cell without the rows' columns having to line up.
 * `px` is the size of one pixel.
 */
export function mascotEmailHtml(px = 3): string {
  const rows: string[] = [];
  for (let y = 1; y < MASCOT_HEIGHT - 1; y++) {
    const cells: string[] = [];
    let x = 0;
    while (x < MASCOT_WIDTH) {
      const fill = pixel(x, y);
      let run = 1;
      while (x + run < MASCOT_WIDTH && pixel(x + run, y) === fill) run++;
      const w = run * px;
      const bg = fill ? `background:${fill};` : '';
      cells.push(`<td width="${w}" height="${px}" style="width:${w}px;height:${px}px;${bg}font-size:0;line-height:0;padding:0;"></td>`);
      x += run;
    }
    rows.push(`<tr><td style="padding:0;font-size:0;line-height:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>${cells.join('')}</tr></table></td></tr>`);
  }
  return `<table role="presentation" aria-hidden="true" cellpadding="0" cellspacing="0" border="0" width="${MASCOT_WIDTH * px}" style="border-collapse:collapse;width:${MASCOT_WIDTH * px}px;">${rows.join('')}</table>`;
}
