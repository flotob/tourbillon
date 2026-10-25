import { describe, expect, it } from 'vitest';
import { mini } from '@strudel/mini';
import { drumLines, hitsCode, swingOf, valuesCode } from '../website/src/repl/crate/drumCode.mjs';

const bar = (key) => [...key.replace(/ /g, '')].map((c) => c === 'x');
// onsets per cycle of a mini-notation pattern, as 16ths
const onsets = (code, cycle) =>
  mini(code)
    .queryArc(cycle, cycle + 1)
    .filter((hap) => hap.hasOnset())
    .map((hap) => Math.round((hap.whole.begin.valueOf() - cycle) * 16))
    .sort((a, b) => a - b);
const valueAt = (code, cycle, step) => mini(code).queryArc(cycle + step / 16, cycle + step / 16 + 1e-6)[0].value;

describe('hitsCode', () => {
  it('writes common bars the short way', () => {
    expect(hitsCode([bar('x... x... x... x...')], 'bd')).toBe('bd*4');
    expect(hitsCode([bar('..x. ..x. ..x. ..x.')], 'hh')).toBe('[~ hh]*4');
    expect(hitsCode([bar('x.x. x.x. x.x. x.x.')], 'hh')).toBe('hh*8');
    expect(hitsCode([bar('.... x... .... x...')], 'sd')).toBe('~ sd ~ sd');
    expect(hitsCode([bar('.... .... .... ....')], 'sd')).toBe('~');
  });

  it('writes several bars as a sequence of one bar per cycle', () => {
    const four = bar('x... x... x... x...');
    const fill = bar('x... x... xx.. x...');
    expect(hitsCode([four, four, four, fill], 'bd')).toBe('<bd*4!3 [bd bd [bd bd ~ ~] bd]>');
  });

  it('plays exactly the hits, whatever they are', () => {
    const random = (seed) => Array.from({ length: 16 }, (_, i) => (seed * 7919 + i * 104729) % 13 < 4);
    const bars = Array.from({ length: 12 }, (_, i) => random(i + 1));
    const code = hitsCode(bars, 'x');
    bars.forEach((steps, cycle) => {
      expect(onsets(code, cycle)).toEqual(steps.flatMap((on, i) => (on ? [i] : [])));
    });
  });
});

describe('valuesCode', () => {
  it('gives each hit its value, in as few values as it can', () => {
    const offbeats = [undefined, undefined, 1, undefined, undefined, undefined, 0.5, undefined];
    expect(valuesCode([[...offbeats, ...offbeats]])).toBe('1 .5 1 .5');
    const mixed = [1, undefined, 0.5, 0.5, 1, 0.71, undefined, 0.25, ...Array(8).fill(undefined)];
    const code = valuesCode([mixed, Array(16).fill(undefined)]);
    expect(code).toBe('[1 .5] [1 .71 .71 .25] .25 .25');
    [0, 2, 3, 4, 5, 7].forEach((step) => expect(valueAt(code, 1, step)).toBe(mixed[step]));
  });

  it('holds values over the steps between them', () => {
    expect(valuesCode([Array(16).fill(1)])).toBe('1');
    expect(valuesCode([[1, 1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1, 1, 0.5, 0.5]])).toBe('[1 .5]*4');
    const code = valuesCode([Array(16).fill(1), [1, 1, 1, 1, 0.71, 0.71, 0.71, 0.71, 1, 0.5, 0.25, 1, 1, 1, 1, 1]]);
    expect(code).toBe('<1 [1 .71 [1 .5 .25 1] 1]>');
    expect(valueAt(code, 1, 9)).toBe(0.5);
    expect(valueAt(code, 1, 10)).toBe(0.25);
    expect(valueAt(code, 0, 10)).toBe(1);
  });
});

describe('swingOf', () => {
  it('finds late 16ths', () => {
    const hits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((step) => [0, step, 1, step % 2 ? 31 : 1]);
    // 30 ms on 125 ms 16ths
    expect(swingOf(hits, 125)).toEqual({ amount: 0.24, slices: 8 });
  });
  it('finds late 8ths when nothing plays on the 16ths between them', () => {
    const hits = [0, 2, 4, 6, 8, 10, 12, 14].map((step) => [0, step, 1, step % 4 ? 50 : 0]);
    expect(swingOf(hits, 125)).toEqual({ amount: 0.2, slices: 4 });
  });
  it('ignores what is straight', () => {
    const hits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((step) => [0, step, 1, step % 2 ? 3 : 1]);
    expect(swingOf(hits, 125)).toBeUndefined();
  });
});

describe('drumLines', () => {
  const record = { name: 'synth', bpm: 120 };
  const data = {
    hits: {
      bd: [0, 4, 8, 12, 16, 20, 24, 28].map((i) => [Math.floor(i / 16), i % 16, 1, 0]),
      hh: [
        [0, 2, 1, 0],
        [0, 6, 0.5, 0],
        [0, 10, 1, 0],
        [0, 14, 0.5, 0],
        [5, 2, 1, 0],
      ],
    },
  };
  it('writes a line per drum on the record kit, with velocities where they vary', () => {
    expect(drumLines(record, data, 0, 2)).toEqual([
      '$: s("bd*4").bank("synth") // kick',
      '$: s("<[~ hh]*4 ~>").bank("synth").velocity("1 .5 1 .5") // hi-hats',
    ]);
  });
  it('leaves out drums that are silent in those bars', () => {
    expect(drumLines(record, data, 2, 4)).toEqual([]);
  });
});
