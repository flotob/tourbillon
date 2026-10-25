import { describe, expect, it } from 'vitest';
import { mini } from '@strudel/mini';
import { bassLine, noteName, notesCode } from '../website/src/repl/crate/noteCode.mjs';

// the notes a mini-notation pattern plays in a cycle, as [16th, length in 16ths, note]
const played = (code, cycle) =>
  mini(code)
    .queryArc(cycle, cycle + 1)
    .filter((hap) => hap.hasOnset())
    .map((hap) => [
      Math.round((hap.whole.begin.valueOf() - cycle) * 16),
      Math.round(hap.duration.valueOf() * 16),
      hap.value,
    ]);

describe('noteName', () => {
  it('spells notes for the key', () => {
    expect(noteName(33, 'A minor')).toBe('a1');
    expect(noteName(34, 'A minor')).toBe('a#1');
    expect(noteName(34, 'D minor')).toBe('bb1');
    expect(noteName(60, 'C major')).toBe('c4');
  });
});

describe('notesCode', () => {
  it('writes held notes, rests and repeats the short way', () => {
    expect(notesCode([[0, 0, 16, 33]], 'A minor', 0, 1)).toBe('a1');
    expect(
      notesCode(
        [
          [0, 0, 8, 38],
          [0, 12, 4, 29],
        ],
        'A minor',
        0,
        1,
      ),
    ).toBe('d2@8 ~@4 f1@4');
    const beats = [0, 4, 8, 12].map((step) => [0, step, 3, 33]);
    expect(notesCode(beats, 'A minor', 0, 1)).toBe('[a1@3 ~]*4');
    expect(
      notesCode(
        [0, 4, 8, 12].map((step) => [0, step, 4, 33]),
        'A minor',
        0,
        1,
      ),
    ).toBe('a1*4');
    expect(notesCode([], 'A minor', 0, 1)).toBe('~');
  });

  it('writes bars one per cycle', () => {
    const notes = [
      [0, 0, 16, 33],
      [1, 0, 16, 33],
      [2, 0, 16, 29],
      [3, 0, 8, 29],
    ];
    expect(notesCode(notes, 'A minor', 0, 4)).toBe('<a1!2 f1 [f1@8 ~@8]>');
  });

  it('plays exactly the notes, whatever they are', () => {
    const notes = [];
    for (let bar = 0; bar < 6; bar++) {
      let step = (bar * 3) % 4;
      while (step < 16) {
        const length = 1 + ((bar + step) % 5);
        notes.push([bar, step, Math.min(length, 16 - step), 28 + ((bar * 7 + step) % 12)]);
        step += length + (step % 3 === 0 ? 1 : 0);
      }
    }
    const code = notesCode(notes, 'A minor', 0, 6);
    for (let bar = 0; bar < 6; bar++) {
      const want = notes
        .filter(([b]) => b === bar)
        .map(([, step, length, midi]) => [step, length, noteName(midi, 'A minor')]);
      expect(played(code, bar)).toEqual(want);
    }
  });
});

describe('bassLine', () => {
  const record = { key: 'A minor', notes: { bass: [[4, 0, 16, 33]] } };
  it('plays the bass line on a synth', () => {
    expect(bassLine(record, 4, 5)).toBe('$: note("a1").s("sawtooth").lpf(400) // bass line, A minor');
  });
  it('is undefined where the bass is silent', () => {
    expect(bassLine(record, 0, 4)).toBeUndefined();
  });
});
