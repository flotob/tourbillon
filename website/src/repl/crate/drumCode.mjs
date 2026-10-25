// a record's drum hits as strudel code: one line per drum, one bar per cycle, on the record's own kit (a bank).
// crate stores each hit as [bar, 16th, velocity, ms off the 16th]; see crate's drums.py

export const DRUMS = ['bd', 'sd', 'hh', 'perc', 'cr'];
export const DRUM_NAMES = { bd: 'kick', sd: 'snare', hh: 'hi-hats', perc: 'percussion', cr: 'cymbals' };
const STEPS = 16;

// one beat (4 steps, true where the drum hits) in mini-notation
function beatHits(steps, sound) {
  const key = steps.map((on) => (on ? 'x' : '.')).join('');
  if (key === '....') return '~';
  if (key === 'x...') return sound;
  if (key === 'x.x.') return `${sound}*2`;
  if (key === 'xxxx') return `${sound}*4`;
  if (key === '..x.') return `[~ ${sound}]`;
  return `[${steps.map((on) => (on ? sound : '~')).join(' ')}]`;
}

// one bar of 16 steps: "bd*4", "[~ hh]*4", "~ sd ~ sd", or "~" when the drum is silent
function barHits(steps, sound) {
  const beats = [0, 4, 8, 12].map((i) => beatHits(steps.slice(i, i + 4), sound));
  if (beats.every((beat) => beat === '~')) return '~';
  if (beats.every((beat) => beat === beats[0])) {
    const beat = beats[0];
    if (beat === sound) return `${sound}*4`;
    const repeated = beat.match(/^(\w+)\*(\d+)$/);
    return repeated ? `${repeated[1]}*${repeated[2] * 4}` : `${beat}*4`;
  }
  return beats.join(' ');
}

// bars in a row, one per cycle: the bar itself when they are all the same, else "<a!3 b>"
export function sequence(codes) {
  if (codes.every((code) => code === codes[0])) {
    return codes[0];
  }
  const runs = [];
  for (const code of codes) {
    const last = runs.at(-1);
    if (last?.code === code) {
      last.count++;
    } else {
      runs.push({ code, count: 1 });
    }
  }
  return `<${runs.map(({ code, count }) => wrap(code) + (count > 1 ? `!${count}` : '')).join(' ')}>`;
}

// brackets around a bar of several steps, so it takes one place in a sequence
function wrap(code) {
  let depth = 0;
  for (const c of code) {
    depth += c === '[' ? 1 : c === ']' ? -1 : 0;
    if (c === ' ' && depth === 0) {
      return `[${code}]`;
    }
  }
  return code;
}

// mini-notation of several bars of hits (arrays of 16 booleans each)
export const hitsCode = (bars, sound) => sequence(bars.map((steps) => barHits(steps, sound)));

const number = (value) => String(value).replace(/^0\./, '.');
const same = (values) => values.every((value) => value === values[0]);

// a beat of velocities (4 steps, undefined where the drum doesn't hit): one value when its hits share it,
// two when each half does, else four with each held over the steps after it. Returns the code and the
// values it starts and ends with, or undefined without hits
function beatVelocities(values) {
  const hits = values.filter((value) => value !== undefined);
  if (!hits.length) return undefined;
  if (same(hits)) return { code: number(hits[0]), first: hits[0], last: hits[0] };
  const halves = [values.slice(0, 2), values.slice(2)].map((half) => half.filter((value) => value !== undefined));
  if (halves.every(same)) {
    const [a, b] = halves.map((half) => half[0]);
    return { code: `[${number(a ?? b)} ${number(b ?? a)}]`, first: a ?? b, last: b ?? a };
  }
  let held = hits[0];
  const steps = values.map((value) => (held = value ?? held));
  return { code: `[${steps.map(number).join(' ')}]`, first: steps[0], last: steps[3] };
}

// bars without hits take the code of the bar before (or after), which plays the same and repeats with !n
function fillGaps(codes) {
  let held = codes.find((code) => code !== undefined);
  return codes.map((code) => (held = code ?? held));
}

function barVelocities(values) {
  const beats = [0, 4, 8, 12].map((i) => beatVelocities(values.slice(i, i + 4)));
  if (beats.every((beat) => beat === undefined)) return undefined;
  // a beat without hits holds the value the beat before ends on, or takes the one the next starts with
  const codes = beats.map((beat, i) => {
    if (beat) return beat.code;
    const before = beats.slice(0, i).findLast(Boolean);
    return number(before ? before.last : beats.slice(i).find(Boolean).first);
  });
  if (same(codes)) {
    return codes[0].includes(' ') ? `${codes[0]}*4` : codes[0];
  }
  return codes.join(' ');
}

// mini-notation of the velocities of several bars (arrays of 16, undefined where the drum doesn't hit); every
// step gets a value, so a hit added by hand still plays
export const valuesCode = (bars) => sequence(fillGaps(bars.map(barVelocities)));

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// how far hits off the beat come late, as .swingBy(amount, slices): 16ths when there are any off the 8ths,
// else 8ths. hits are [bar, 16th, velocity, ms off]; stepMs is a 16th at the record's tempo
export function swingOf(hits, stepMs) {
  for (const [slices, size] of [
    [8, 2],
    [4, 4],
  ]) {
    const late = hits.filter(([, step]) => step % size === size / 2).map(([, , , ms]) => ms);
    const on = hits.filter(([, step]) => step % size === 0).map(([, , , ms]) => ms);
    if (late.length >= 4 && on.length >= 4) {
      const delay = median(late) - median(on);
      // swingBy delays the second half of each slice by amount * half a slice
      const amount = Math.round((delay / ((stepMs * size) / 2)) * 100) / 100;
      return amount >= 0.06 ? { amount, slices } : undefined;
    }
  }
}

// code lines that play bars [from, to) of a record's drums; data is its drums.json
export function drumLines(record, data, from, to) {
  const count = to - from;
  const stepMs = (240 / record.bpm / STEPS) * 1000;
  const lines = [];
  for (const drum of DRUMS) {
    const hits = (data.hits[drum] ?? []).filter(([bar]) => bar >= from && bar < to);
    if (!hits.length) {
      continue;
    }
    const steps = Array.from({ length: count }, () => Array(STEPS).fill(false));
    const velocities = Array.from({ length: count }, () => Array(STEPS).fill(undefined));
    for (const [bar, step, velocity] of hits) {
      steps[bar - from][step] = true;
      velocities[bar - from][step] = velocity;
    }
    let line = `$: s("${hitsCode(steps, drum)}").bank("${record.name}")`;
    if (hits.some(([, , velocity]) => velocity !== 1)) {
      line += `.velocity("${valuesCode(velocities)}")`;
    }
    const swing = swingOf(hits, stepMs);
    if (swing) {
      line += `.swingBy(${number(swing.amount)}, ${swing.slices})`;
    }
    lines.push(`${line} // ${DRUM_NAMES[drum]}`);
  }
  return lines;
}
