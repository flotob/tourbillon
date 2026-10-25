import { describe, expect, it } from 'vitest';
import {
  clampView,
  gridLines,
  lanePath,
  outlineLevels,
  panView,
  resolution,
  rulerStep,
  zoomView,
} from '../website/src/repl/crate/mapView.mjs';

describe('zoomView', () => {
  it('keeps the bar under the pointer in place', () => {
    const view = zoomView({ start: 0, bars: 256 }, 256, 0.25, 128);
    expect(view).toEqual({ start: 96, bars: 64 });
    // bar 128 was halfway across, and still is
    expect((128 - view.start) / view.bars).toBe(0.5);
  });

  it('stops at the whole record and at two bars', () => {
    expect(zoomView({ start: 96, bars: 64 }, 256, 10, 100)).toEqual({ start: 0, bars: 256 });
    expect(zoomView({ start: 96, bars: 64 }, 256, 0.001, 100).bars).toBe(2);
  });

  it('stays inside the record', () => {
    expect(zoomView({ start: 0, bars: 64 }, 256, 2, 60)).toEqual({ start: 0, bars: 128 });
    expect(zoomView({ start: 192, bars: 64 }, 256, 2, 250)).toEqual({ start: 128, bars: 128 });
  });
});

describe('panView', () => {
  it('moves and stops at the ends', () => {
    expect(panView({ start: 10, bars: 16 }, 100, 5)).toEqual({ start: 15, bars: 16 });
    expect(panView({ start: 10, bars: 16 }, 100, -50)).toEqual({ start: 0, bars: 16 });
    expect(panView({ start: 10, bars: 16 }, 100, 500)).toEqual({ start: 84, bars: 16 });
  });

  it('keeps short records whole', () => {
    expect(clampView({ start: 3, bars: 1 }, 1)).toEqual({ start: 0, bars: 1 });
  });
});

describe('rulerStep', () => {
  it('numbers bars far enough apart', () => {
    expect(rulerStep(2)).toBe(32);
    expect(rulerStep(16)).toBe(4);
    expect(rulerStep(260)).toBe(1);
  });
});

describe('gridLines', () => {
  it('draws phrases when zoomed out and beats when zoomed in', () => {
    expect(gridLines(0, 128, 2)).toEqual([
      { bar: 16, opacity: 0.1 },
      { bar: 32, opacity: 0.1 },
      { bar: 48, opacity: 0.1 },
      { bar: 64, opacity: 0.25 },
      { bar: 80, opacity: 0.1 },
      { bar: 96, opacity: 0.1 },
      { bar: 112, opacity: 0.1 },
      { bar: 128, opacity: 0.25 },
    ]);
    expect(gridLines(15.5, 16.5, 100).map(({ bar }) => bar)).toEqual([15.5, 15.75, 16, 16.25, 16.5]);
    expect(gridLines(15.5, 16.5, 100)[2].opacity).toBe(0.1);
  });
});

describe('outline', () => {
  it('draws about one point every 2 px', () => {
    expect(resolution(2, 64)).toBe(1);
    expect(resolution(16, 64)).toBe(8);
    expect(resolution(1000, 64)).toBe(64);
  });

  it('joins points by their power', () => {
    const levels = outlineLevels([-6, -60, -20, -20], 2);
    expect(levels.get(2)).toEqual([-6, -60, -20, -20]);
    expect(levels.get(1)[0]).toBeCloseTo(-9.01, 2);
    expect(levels.get(1)[1]).toBeCloseTo(-20, 5);
  });

  it('draws only the visible points, mirrored', () => {
    const x = (bar) => bar * 10;
    const path = lanePath([-10, -20, -30, -40], 1, 1, 3, x, 10, 5, () => 1);
    expect(path).toBe('M10 10L10 5L20 5L20 5L30 5L30 10L30 15L20 15L20 15L10 15Z');
  });
});
