// the crate in the renderer: records become strudel sounds (<record>_<stem>, n = bar), imports report progress,
// bars can be auditioned and inserted as code. Records are made by the crate project, run by the main process.
// A record's drum kit is a bank (<record>_bd, _sd, ...), and its drum hits and bass line can be inserted as patterns.
import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { logger } from '@strudel/core';
import { getAudioContext, loadBuffer, onTriggerSample, registerSound, soundMap } from '@strudel/webaudio';
import { atom } from 'nanostores';
import { setActiveFooter, setIsPanelOpened } from '../../settings.mjs';
import { drumLines } from './drumCode.mjs';
import { bassLine } from './noteCode.mjs';

const crate = typeof window !== 'undefined' ? window.tourbillon?.crate : undefined;
const BASE = 'crate://records/';
export const PARTS = ['drums', 'bass', 'other', 'vocals'];

export const $status = atom();
export const $records = atom([]);
export const $jobs = atom([]);
// the bars being auditioned: { name, stem, from, to, loop, startTime, barDuration }
export const $audition = atom();
// the tempo the code plays at, in bpm with one bar per cycle; known after the first evaluation
export const $tempo = atom();
export const setTempo = (cps) => $tempo.set(Math.round(cps * 240 * 100) / 100);

export const barDuration = (record) => 240 / record.bpm;

// a bar of a stem, at the record's own tempo or from its version at bpm;
// created_at keeps a re-imported record from playing cached audio of the old one
const barPath = (record, stem, bar, bpm) =>
  `${record.name}/${bpm ? `tempo/${bpm}` : 'bars'}/${stem}/${String(bar).padStart(3, '0')}.flac?v=${Math.round(record.created_at)}`;
const barUrls = (record, stem, bpm) =>
  Array.from({ length: record.bars }, (_, bar) => BASE + barPath(record, stem, bar, bpm));

const drumsVersion = (record) => `?v=${Math.round(record.drums.created_at)}`;
const kitUrl = (record, drum) => `${BASE}${record.name}/drums/${drum}.flac${drumsVersion(record)}`;

// the version to play at cps with one bar per cycle: the one closest in tempo, unless the record itself is closer
export function versionFor(record, cps) {
  if (!cps || !record.versions?.length) {
    return undefined;
  }
  const distance = (bpm) => Math.abs(Math.log((cps * 240) / bpm));
  const closest = record.versions.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  return distance(closest) < distance(record.bpm) ? closest : undefined;
}

let registered = new Set();

// each stem is a sample sound whose bars come from the version closest to the tempo it is played at, so a record
// keeps its pitch at every tempo it has a version for; .fit() covers what is left
export async function registerCrateSounds(records) {
  if (!crate) {
    return;
  }
  records ??= await crate.records();
  const keys = new Set();
  for (const record of records) {
    for (const stem of record.stems) {
      const key = `${record.name}_${stem}`;
      const original = barUrls(record, stem);
      const versions = new Map(record.versions.map((bpm) => [bpm, barUrls(record, stem, bpm)]));
      const onTrigger = (t, value, onended, cps) =>
        onTriggerSample(t, value, onended, versions.get(versionFor(record, cps)) ?? original);
      registerSound(key, onTrigger, { type: 'sample', samples: original, baseUrl: BASE, prebake: true, tag: 'crate' });
      keys.add(key);
    }
    // the kit: one hit of each drum, e.g. s("bd*4").bank("<record>")
    for (const drum of Object.keys(record.drums?.hits ?? {})) {
      const key = `${record.name}_${drum}`;
      const samples = [kitUrl(record, drum)];
      const onTrigger = (t, value, onended) => onTriggerSample(t, value, onended, samples);
      registerSound(key, onTrigger, { type: 'sample', samples, baseUrl: BASE, prebake: true, tag: 'crate' });
      keys.add(key);
    }
  }
  for (const key of registered) {
    if (!keys.has(key)) {
      soundMap.setKey(key, undefined);
    }
  }
  registered = keys;
  $records.set(records);
}

const isAudio = (file) => $status.get()?.extensions.includes(file.split('.').pop().toLowerCase());

export async function importFiles(files) {
  setActiveFooter('crate');
  setIsPanelOpened(true);
  await crate.import(files);
}

export const pickFiles = () => crate.pick();
export const cancelJob = (id) => crate.cancel(id);
export const clearJobs = () => crate.clearJobs();

export const makeVersion = (name, bpm) => crate.makeVersion(name, bpm);
export const deleteVersion = (name, bpm) => crate.deleteVersion(name, bpm);
export const findDrums = (name) => crate.findDrums(name);

// a record's drums.json: every hit as [bar, 16th, velocity, ms off the 16th] per drum
const drumData = new Map();
export function loadDrums(record) {
  const url = `${BASE}${record.name}/drums/drums.json${drumsVersion(record)}`;
  if (!drumData.has(url)) {
    drumData.set(
      url,
      fetch(url).then((response) => {
        if (!response.ok) {
          drumData.delete(url);
          throw new Error(`the drums of ${record.name} could not be read`);
        }
        return response.json();
      }),
    );
  }
  return drumData.get(url);
}

// code that plays bars [from, to) of a record's drums as patterns on its kit
export async function drumsCode(record, from, to) {
  const lines = drumLines(record, await loadDrums(record), from, to);
  const span = to - from > 1 ? `bars ${from}–${to - 1}` : `bar ${from}`;
  if (!lines.length) {
    return `// no drums in ${span} of ${record.name}`;
  }
  return [`// the drums of ${record.name}, ${span}; .bank("tr909") plays them on a 909`, ...lines].join('\n');
}

// code that plays bars [from, to) of a record's bass line as notes on a synth
export function notesCode(record, from, to) {
  const span = to - from > 1 ? `bars ${from}–${to - 1}` : `bar ${from}`;
  const line = bassLine(record, from, to);
  return line
    ? `// the bass line of ${record.name}, ${span}\n${line}`
    : `// no bass notes in ${span} of ${record.name}`;
}

export function insertNotes(record, from, to) {
  appendCode(record, notesCode(record, from, to).split('\n'));
}

export async function insertDrums(record, from, to) {
  appendCode(record, (await drumsCode(record, from, to)).split('\n'));
}

// one hit of the kit, straight to the output
export async function playDrum(record, drum) {
  const ac = getAudioContext();
  if (ac.state === 'suspended') {
    await ac.resume();
  }
  const buffer = await loadBuffer(kitUrl(record, drum), ac, `${record.name}_${drum}`, 0);
  const source = ac.createBufferSource();
  source.buffer = buffer;
  source.connect(ac.destination);
  source.start();
}

export async function deleteRecord(name) {
  if ($audition.get()?.name === name) {
    stopAudition();
  }
  await crate.remove(name);
}

let initialized = false;

export function initCrate() {
  if (!crate || initialized) {
    return;
  }
  initialized = true;
  crate.status().then((status) => $status.set(status));
  crate.jobs().then((jobs) => $jobs.set(jobs));
  crate.onEvent((event) => {
    if (event.type === 'jobs') {
      $jobs.set(event.jobs);
    } else if (event.type === 'records') {
      registerCrateSounds(event.records);
    }
  });
  // Escape stops a preview from anywhere, Space too unless it types or presses a button
  const typing = (target) => target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName);
  window.addEventListener('keydown', (event) => {
    if (!$audition.get() || event.defaultPrevented) {
      return;
    }
    if (event.key === 'Escape' || (event.key === ' ' && !typing(event.target))) {
      event.preventDefault();
      stopAudition();
    }
  });
  // audio files dropped anywhere on the window go into the crate, instead of the window navigating to them
  const hasFiles = (event) => event.dataTransfer?.types.includes('Files');
  window.addEventListener(
    'dragover',
    (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    },
    true,
  );
  window.addEventListener(
    'drop',
    (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const files = [...event.dataTransfer.files].map((file) => crate.pathForFile(file)).filter(isAudio);
      if (files.length) {
        importFiles(files);
      }
    },
    true,
  );
}

// auditioning plays bars straight to the output, next to whatever the code plays
let session;

export function stopAudition() {
  if (!session) {
    return;
  }
  session.stopped = true;
  clearTimeout(session.timer);
  for (const source of session.sources) {
    source.stop();
  }
  session = undefined;
  $audition.set(undefined);
}

// plays a stem from bar `from` on: through to the end of the record, or looping bars [from, to)
export async function audition(record, stem, from, to = record.bars, loop = false) {
  stopAudition();
  const ac = getAudioContext();
  if (ac.state === 'suspended') {
    await ac.resume();
  }
  const current = { stopped: false, sources: new Set() };
  session = current;
  let bar = from;
  let time = ac.currentTime + 0.05;
  $audition.set({ name: record.name, stem, from, to, loop, startTime: time, barDuration: barDuration(record) });
  // bars are scheduled a second ahead, back to back
  const schedule = async () => {
    while (!current.stopped && time < ac.currentTime + 1) {
      if (bar >= to) {
        if (!loop) {
          current.timer = setTimeout(() => session === current && stopAudition(), (time - ac.currentTime) * 1000);
          return;
        }
        bar = from;
      }
      const buffer = await loadBuffer(BASE + barPath(record, stem, bar), ac, `${record.name}_${stem}`, bar);
      if (current.stopped) {
        return;
      }
      const source = ac.createBufferSource();
      source.buffer = buffer;
      source.connect(ac.destination);
      source.onended = () => current.sources.delete(source);
      source.start(time);
      current.sources.add(source);
      time += buffer.duration;
      bar++;
    }
    current.timer = setTimeout(schedule, 250);
  };
  await schedule();
}

// where an audition is right now, in bars from the start of the record
export function auditionPosition(audition) {
  const elapsed = Math.max(0, getAudioContext().currentTime - audition.startTime) / audition.barDuration;
  return audition.loop ? audition.from + (elapsed % (audition.to - audition.from)) : audition.from + elapsed;
}

// code that plays bars [from, to) of a stem, one bar per cycle
export function barsCode(record, stem, from, to) {
  const count = to - from;
  const bars =
    count === 1
      ? `${from}`
      : count <= 16
        ? `"<${Array.from({ length: count }, (_, i) => from + i).join(' ')}>"`
        : `run(${count}).slow(${count}).add(${from})`;
  return `$: s("${record.name}_${stem}").n(${bars})`;
}

const hasTempo = (code) => /\bset(cpm|cps|bpm)\s*\(/.test(code);

// appends bars of a stem to the editor; sets the record's tempo if the code has none, and at another tempo
// stretches the bars and makes a version of the record at that tempo
export function insertBars(record, stem, from, to) {
  const editor = window.strudelMirror;
  const bpm = +record.bpm.toFixed(2);
  let line = barsCode(record, stem, from, to);
  const tempo = Math.round(editor.repl.scheduler.cps * 240 * 100) / 100;
  if (hasTempo(editor.editor.state.doc.toString()) && Math.abs(tempo - bpm) > 0.5) {
    // fit stretches each bar to a cycle, which shifts its pitch like a turntable; a version at this tempo keeps it
    line += `.fit() // ${record.name} is ${bpm} bpm`;
    makeVersion(record.name, tempo).catch((err) => logger(`[crate] ${err.message}`, 'error'));
  }
  appendCode(record, [line]);
}

// appends lines to the editor as one undo step, after the record's tempo if the code has none
function appendCode(record, added) {
  const view = window.strudelMirror.editor;
  const code = view.state.doc.toString();
  const lines = [...added];
  if (!hasTempo(code)) {
    lines.unshift(`setcpm(${+record.bpm.toFixed(2)}/4) // the tempo of ${record.name}: one cycle is one bar`);
  }
  const prefix = code.length === 0 || code.endsWith('\n\n') ? '' : code.endsWith('\n') ? '\n' : '\n\n';
  const insert = prefix + lines.join('\n') + '\n';
  view.dispatch({
    changes: { from: code.length, insert },
    selection: { anchor: code.length + insert.length - 1 },
    annotations: isolateHistory.of('full'),
    effects: EditorView.scrollIntoView(code.length + insert.length - 1),
  });
  view.focus();
}
