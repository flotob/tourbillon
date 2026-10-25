// the stem map's view: which bars are visible, zooming and moving it, and how much detail to draw at each zoom

// the closest zoom: this many bars across the map
export const MIN_BARS = 2;

// a view (start: the bar at the left edge, maybe fractional; bars: how many are visible) kept inside the record
export function clampView({ start, bars }, total) {
  const shown = Math.min(total, Math.max(Math.min(MIN_BARS, total), bars));
  return { start: Math.max(0, Math.min(total - shown, start)), bars: shown };
}

// zoomed in (factor < 1) or out (factor > 1) around anchor, the bar under the pointer, which stays where it is
export function zoomView(view, total, factor, anchor) {
  const { bars } = clampView({ start: 0, bars: view.bars * factor }, total);
  return clampView({ start: anchor - ((anchor - view.start) * bars) / view.bars, bars }, total);
}

export const panView = (view, total, bars) => clampView({ start: view.start + bars, bars: view.bars }, total);

export const isZoomed = (view, total) => view.bars < total;

// bar numbers on the ruler: every 1, 2, 4... bars, at least minPx apart
export function rulerStep(pxPerBar, minPx = 36) {
  let step = 1;
  while (step * pxPerBar < minPx) {
    step *= 2;
  }
  return step;
}

// lines across the lanes between bars from and to: every 64 bars strongest, then every 16, every bar and every beat
// when there is room for them
export function gridLines(from, to, pxPerBar) {
  const step = pxPerBar >= 32 ? 1 / 4 : pxPerBar >= 6 ? 1 : 16;
  const lines = [];
  for (let k = Math.max(1, Math.ceil(from / step)); k * step <= to; k++) {
    const bar = k * step;
    const opacity = bar % 64 === 0 ? 0.25 : bar % 16 === 0 ? 0.1 : bar % 1 === 0 ? 0.06 : 0.03;
    lines.push({ bar, opacity });
  }
  return lines;
}

// points of an outline to draw per bar at pxPerBar: one every 2 px or more, a power of two up to the outline's steps
export function resolution(pxPerBar, steps) {
  let per = 1;
  while (per * 2 <= steps && per * 4 <= pxPerBar) {
    per *= 2;
  }
  return per;
}

// an outline (dB per 1/steps of a bar, bar after bar; steps a power of two) at steps, steps / 2, ... 1 points per
// bar, each point as loud as the two it joins together
export function outlineLevels(levels, steps) {
  const byResolution = new Map([[steps, levels]]);
  let current = levels;
  for (let per = steps / 2; per >= 1; per /= 2) {
    const joined = new Float32Array(current.length / 2);
    for (let i = 0; i < joined.length; i++) {
      joined[i] = 10 * Math.log10((10 ** (current[2 * i] / 10) + 10 ** (current[2 * i + 1] / 10)) / 2);
    }
    byResolution.set(per, joined);
    current = joined;
  }
  return byResolution;
}

// outline.json from crate, with each stem's outline at every resolution
export const prepareOutline = ({ steps, levels }) => ({
  steps,
  levels: Object.fromEntries(Object.entries(levels).map(([stem, outline]) => [stem, outlineLevels(outline, steps)])),
});

// the outline between bars from and to as an SVG path: points (dB, per of them per bar) as steps, their height
// (level(dB) * half) mirrored around mid; x turns bars into px
export function lanePath(points, per, from, to, x, mid, half, level) {
  const first = Math.max(0, Math.floor(from * per));
  const last = Math.min(points.length, Math.ceil(to * per));
  if (last <= first) {
    return '';
  }
  const top = [];
  const bottom = [];
  for (let i = first; i < last; i++) {
    const h = level(points[i]) * half;
    const x0 = +x(i / per).toFixed(1);
    const x1 = +x((i + 1) / per).toFixed(1);
    top.push(`L${x0} ${+(mid - h).toFixed(1)}L${x1} ${+(mid - h).toFixed(1)}`);
    bottom.push(`L${x1} ${+(mid + h).toFixed(1)}L${x0} ${+(mid + h).toFixed(1)}`);
  }
  const start = +x(first / per).toFixed(1);
  const end = +x(last / per).toFixed(1);
  return `M${start} ${mid}${top.join('')}L${end} ${mid}${bottom.reverse().join('')}Z`;
}
