// a record's bass line as strudel code: one bar per cycle, each note with its length in 16ths.
// crate stores each note as [bar, 16th, length in 16ths, midi note]; see crate's bass.py
import { sequence } from './drumCode.mjs';

const STEPS = 16;
const SHARPS = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLATS = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
// keys written with flats; the others with sharps
const FLAT_KEYS = ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']
  .map((tonic) => `${tonic} major`)
  .concat(['D', 'G', 'C', 'F', 'Bb', 'Eb'].map((tonic) => `${tonic} minor`));

// "a1", "eb2": strudel note names, spelled for the key
export const noteName = (midi, key) =>
  `${(FLAT_KEYS.includes(key) ? FLATS : SHARPS)[midi % 12]}${Math.floor(midi / 12) - 1}`;

// steps (16 per bar, each a note name where a note starts, '_' where it holds, '~' where nothing plays) as
// mini-notation: "a1@3 ~ c2@4 ...", with lengths after @
function segments(steps) {
  const runs = [];
  for (const step of steps) {
    const last = runs.at(-1);
    if (step === '_' || (step === '~' && last?.token === '~')) {
      last.length++;
    } else {
      runs.push({ token: step, length: 1 });
    }
  }
  return runs.map(({ token, length }) => (length > 1 ? `${token}@${length}` : token)).join(' ');
}

// one bar; a note or rest for the whole bar is written alone, the same beat four times or half twice once
function barNotes(steps) {
  const code = segments(steps);
  if (!code.includes(' ')) {
    return code.replace(/@\d+$/, '');
  }
  for (const parts of [4, 2]) {
    const size = STEPS / parts;
    const chunks = Array.from({ length: parts }, (_, i) => steps.slice(i * size, (i + 1) * size));
    // a note held over from the chunk before can't be repeated on its own
    if (chunks.every((chunk) => chunk.join() === chunks[0].join() && chunk[0] !== '_')) {
      const chunk = segments(chunks[0]);
      return chunk.includes(' ') ? `[${chunk}]*${parts}` : `${chunk.replace(/@\d+$/, '')}*${parts}`;
    }
  }
  return code;
}

// mini-notation of bars [from, to) of a bass line
export function notesCode(notes, key, from, to) {
  const bars = Array.from({ length: to - from }, () => Array(STEPS).fill('~'));
  for (const [bar, step, length, midi] of notes) {
    if (bar < from || bar >= to) {
      continue;
    }
    const steps = bars[bar - from];
    steps[step] = noteName(midi, key);
    for (let i = step + 1; i < Math.min(STEPS, step + length); i++) {
      steps[i] = '_';
    }
  }
  return sequence(bars.map(barNotes));
}

// a code line that plays bars [from, to) of a record's bass line on a synth, or undefined when it is silent there
export function bassLine(record, from, to) {
  const notes = record.notes?.bass ?? [];
  if (!notes.some(([bar]) => bar >= from && bar < to)) {
    return undefined;
  }
  const key = record.key ? `, ${record.key}` : '';
  return `$: note("${notesCode(notes, record.key, from, to)}").s("sawtooth").lpf(400) // bass line${key}`;
}
