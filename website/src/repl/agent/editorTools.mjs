// tools the agent uses on the editor and the strudel runtime; called from the main process via the preload bridge
import { isolateHistory } from '@codemirror/commands';
import { isPattern, Pattern, silence, stack } from '@strudel/core';
import { evaluate } from '@strudel/transpiler';
import { getSound, soundMap } from '@strudel/webaudio';
import { $records, drumsCode, notesCode } from '../crate/crateStore.mjs';

function getEditor() {
  const editor = window.strudelMirror;
  if (!editor) {
    throw new Error('The editor is not ready yet.');
  }
  return editor;
}

const fence = (code) => '```js\n' + code + '\n```';

function getCode() {
  const view = getEditor().editor;
  const { doc, selection } = view.state;
  const code = doc.toString();
  let text = code.trim() ? fence(code) : '(the editor is empty)';
  const { from, to } = selection.main;
  if (from !== to) {
    const fromLine = doc.lineAt(from).number;
    const toLine = doc.lineAt(to).number;
    text += `\n\nThe user selected lines ${fromLine}-${toLine}:\n${fence(view.state.sliceDoc(from, to))}`;
  }
  return text;
}

// one transaction, isolated in history, so a single undo reverts the whole agent edit
function replace(changes) {
  const view = getEditor().editor;
  view.dispatch({ changes, annotations: isolateHistory.of('full') });
  return view.state.doc.toString();
}

function editCode({ edits }) {
  const code = getEditor().editor.state.doc.toString();
  const changes = edits.map(({ old_str, new_str }, i) => {
    if (!old_str) {
      throw new Error(`Edit ${i + 1}: old_str is empty.`);
    }
    const from = code.indexOf(old_str);
    if (from === -1) {
      throw new Error(`Edit ${i + 1}: old_str was not found in the editor. Call get_code to see the current code.`);
    }
    if (code.indexOf(old_str, from + 1) !== -1) {
      throw new Error(`Edit ${i + 1}: old_str occurs more than once. Include more surrounding text.`);
    }
    return { from, to: from + old_str.length, insert: new_str };
  });
  changes.sort((a, b) => a.from - b.from);
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].from < changes[i - 1].to) {
      throw new Error('Edits overlap. Combine them into one edit.');
    }
  }
  return `Applied ${changes.length} edit(s). The editor now contains:\n${fence(replace(changes))}`;
}

function setCode({ code }) {
  const view = getEditor().editor;
  replace({ from: 0, to: view.state.doc.length, insert: code });
  return 'Replaced the editor content.';
}

// evaluates without the repl: captures $: patterns and tempo calls instead of sending them to the scheduler
async function checkPattern({ code, cycles = 4 }) {
  code ??= getEditor().editor.state.doc.toString();
  const patterns = new Map();
  const transforms = { all: [], each: [] };
  let anonymous = 0;
  let cps;
  const stubs = {
    setcps: (value) => (cps = value),
    setCps: (value) => (cps = value),
    setcpm: (value) => (cps = value / 60),
    setCpm: (value) => (cps = value / 60),
    hush: () => {},
    all: (fn) => transforms.all.push(fn),
    each: (fn) => transforms.each.push(fn),
  };
  const savedGlobals = Object.fromEntries(Object.keys(stubs).map((name) => [name, globalThis[name]]));
  const savedP = Pattern.prototype.p;
  Object.assign(globalThis, stubs);
  Pattern.prototype.p = function (id) {
    if (typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'))) {
      return silence;
    }
    if (String(id).includes('$')) {
      id = `${id}${anonymous++}`;
    }
    patterns.set(id, this);
    return this;
  };
  let pattern;
  try {
    ({ pattern } = await evaluate(code));
  } catch (err) {
    return `Evaluation error: ${err.message}`;
  } finally {
    Object.assign(globalThis, savedGlobals);
    Pattern.prototype.p = savedP;
  }

  if (patterns.size) {
    pattern = stack(...[...patterns.values()].map((pat) => transforms.each.reduce((p, fn) => fn(p), pat)));
  }
  if (!isPattern(pattern)) {
    return 'The code evaluates without errors but produces no pattern. Use $: before each pattern or end with a pattern expression.';
  }
  pattern = transforms.all.reduce((p, fn) => fn(p), pattern);

  let haps;
  try {
    haps = pattern.queryArc(0, cycles).filter((hap) => hap.hasOnset());
  } catch (err) {
    return `Runtime error while querying the pattern: ${err.message}`;
  }

  const sounds = new Map();
  const notes = new Set();
  let withoutSound = 0;
  for (const { value } of haps) {
    if (typeof value !== 'object' || value === null) {
      withoutSound++;
      continue;
    }
    const s = value.s ?? (value.note !== undefined || value.freq !== undefined ? 'triangle' : undefined);
    if (s === undefined) {
      withoutSound++;
    } else if (!['-', '~', '_'].includes(s)) {
      const name = value.bank ? `${value.bank}_${s}` : s;
      sounds.set(name, (sounds.get(name) ?? 0) + 1);
    }
    if (value.note !== undefined && notes.size < 32) {
      notes.add(value.note);
    }
  }
  const unknown = [...sounds.keys()].filter((name) => typeof name !== 'string' || !getSound(name));

  const lines = [];
  lines.push(unknown.length ? `PROBLEM: sounds not loaded: ${unknown.join(', ')}. Use list_sounds.` : 'No errors.');
  if (withoutSound) {
    lines.push(`PROBLEM: ${withoutSound} events have no sound (no s, note or freq), they will be silent.`);
  }
  if (cps !== undefined) {
    lines.push(
      `Tempo: ${+(cps * 60).toFixed(2)} cycles per minute (${+(cps * 240).toFixed(1)} bpm at 4 beats per cycle).`,
    );
  }
  if (patterns.size) {
    lines.push(`Patterns: ${[...patterns.keys()].join(', ')}`);
  }
  lines.push(`${haps.length} events in ${cycles} cycles.`);
  if (sounds.size) {
    lines.push(`Sounds: ${[...sounds].map(([name, count]) => `${name} (${count})`).join(', ')}`);
  }
  if (notes.size) {
    lines.push(`Notes: ${[...notes].join(' ')}`);
  }
  // the first cycle in time order shows how the patterns interlock
  const firstCycle = haps.filter((hap) => hap.whole.begin.lt(1)).sort((a, b) => a.whole.begin.compare(b.whole.begin));
  const shown = firstCycle.slice(0, 32).map((hap) => hap.show(true));
  lines.push(`Events in the first cycle:\n${shown.join('\n')}${firstCycle.length > shown.length ? '\n...' : ''}`);
  return lines.join('\n');
}

function getStatus() {
  const editor = getEditor();
  const { state, scheduler } = editor.repl;
  const cps = scheduler?.cps;
  const lines = [
    state.started ? 'Music is playing.' : 'Music is stopped.',
    cps
      ? `Tempo: ${+(cps * 60).toFixed(2)} cycles per minute (${+(cps * 240).toFixed(1)} bpm at 4 beats per cycle).`
      : '',
    editor.code !== state.activeCode
      ? 'The editor has changes that were not evaluated yet.'
      : 'The editor matches what is playing.',
    state.error ? `Last error: ${state.error.message}` : 'No error.',
  ];
  return lines.filter(Boolean).join('\n');
}

function listSounds({ query }) {
  const entries = Object.entries(soundMap.get() ?? {}).filter(([name]) => !name.startsWith('_'));
  if (query) {
    const q = query.toLowerCase();
    const matches = entries.filter(([name]) => name.includes(q)).map(([name, { data }]) => `${name} (${data?.type})`);
    if (!matches.length) {
      return `No loaded sound matches "${query}".`;
    }
    const shown = matches.slice(0, 200);
    return shown.join('\n') + (matches.length > shown.length ? `\n... ${matches.length - shown.length} more` : '');
  }
  const synths = [];
  const banks = new Map();
  const samples = [];
  const soundfonts = [];
  const wavetables = [];
  for (const [name, { data }] of entries) {
    if (data?.type === 'synth') {
      synths.push(name);
    } else if (data?.type === 'soundfont') {
      soundfonts.push(name);
    } else if (data?.type === 'wavetable') {
      wavetables.push(name);
    } else if (data?.tag === 'drum-machines' && name.includes('_')) {
      const [bank, sound] = name.split('_');
      banks.set(bank, [...(banks.get(bank) ?? []), sound]);
    } else {
      samples.push(name);
    }
  }
  return [
    `Synths: ${synths.join(', ')}`,
    `Drum machine banks, use s("bd sd").bank("<bank>") (${banks.size}):\n${[...banks]
      .map(([bank, sounds]) => `${bank}: ${sounds.join(' ')}`)
      .join('\n')}`,
    `Sample sets (${samples.length}): ${samples.join(', ')}`,
    `Soundfonts (${soundfonts.length}), e.g. ${soundfonts.slice(0, 12).join(', ')}. Use a query to find more.`,
    `Wavetables (${wavetables.length}), e.g. ${wavetables.slice(0, 8).join(', ')}.`,
  ].join('\n\n');
}

// a record and bars [from_bar, to_bar] of it, at most 32
function recordBars(name, from_bar, to_bar) {
  const records = $records.get();
  const record = records.find((r) => r.name === name.trim().toLowerCase());
  if (!record) {
    throw new Error(`No record named "${name}". Records: ${records.map((r) => r.name).join(', ') || 'none'}`);
  }
  const from = Math.max(0, Math.floor(from_bar));
  const to = Math.min(record.bars, Math.floor(to_bar) + 1);
  if (to <= from) {
    throw new Error(`${record.name} has bars 0-${record.bars - 1}.`);
  }
  if (to - from > 32) {
    throw new Error('At most 32 bars at a time.');
  }
  return { record, from, to };
}

// the drums of a record's bars as patterns on its kit
async function getDrumPattern({ name, from_bar, to_bar }) {
  const { record, from, to } = recordBars(name, from_bar, to_bar);
  if (!record.drums) {
    throw new Error(`The drum patterns of ${record.name} have not been found yet; use find_drum_patterns.`);
  }
  const kit = Object.keys(record.drums.hits).join(' ');
  return [
    fence(await drumsCode(record, from, to)),
    `The kit is the bank "${record.name}" (${kit}); another bank plays the same patterns on a drum machine. .velocity() is each hit's loudness, .swingBy() the record's swing. Add setcpm() if the code has no tempo; the patterns need no .fit().`,
  ].join('\n');
}

// the bass line of a record's bars as notes
function getBassNotes({ name, from_bar, to_bar }) {
  const { record, from, to } = recordBars(name, from_bar, to_bar);
  if (!record.notes?.bass) {
    throw new Error(`The bass notes of ${record.name} are not there yet; the app updates records when it starts.`);
  }
  return [
    fence(notesCode(record, from, to)),
    `One bar per cycle; a@n holds a note for n 16ths. The sound is a placeholder: change .s() and the filter freely, transpose with .transpose(semitones), or play the record's own bass stem (${record.name}_bass) instead.`,
  ].join('\n');
}

const tools = {
  get_code: getCode,
  edit_code: editCode,
  set_code: setCode,
  check_pattern: checkPattern,
  get_status: getStatus,
  list_sounds: listSounds,
  get_drum_pattern: getDrumPattern,
  get_bass_notes: getBassNotes,
};

export async function runEditorTool(name, args) {
  const tool = tools[name];
  if (!tool) {
    return { error: `Unknown tool ${name}` };
  }
  try {
    return { text: await tool(args ?? {}) };
  } catch (err) {
    return { error: err.message };
  }
}
