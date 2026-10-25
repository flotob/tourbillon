// the crate in the renderer: records become strudel sounds (<record>_<stem>, n = bar), imports report progress,
// bars can be auditioned and inserted as code. Records are made by the crate project, run by the main process.
import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { logger } from '@strudel/core';
import { getAudioContext, loadBuffer, onTriggerSample, registerSound, soundMap } from '@strudel/webaudio';
import { atom } from 'nanostores';
import { setActiveFooter, setIsPanelOpened } from '../../settings.mjs';

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

// appends the code to the editor as one undo step; sets the record's tempo if the code has none
export function insertBars(record, stem, from, to) {
  const editor = window.strudelMirror;
  const view = editor.editor;
  const code = view.state.doc.toString();
  const bpm = +record.bpm.toFixed(2);
  const lines = [];
  if (!/\bset(cpm|cps|bpm)\s*\(/.test(code)) {
    lines.push(`setcpm(${bpm}/4) // the tempo of ${record.name}: one cycle is one bar`);
  }
  let line = barsCode(record, stem, from, to);
  const tempo = Math.round(editor.repl.scheduler.cps * 240 * 100) / 100;
  if (lines.length === 0 && Math.abs(tempo - bpm) > 0.5) {
    // fit stretches each bar to a cycle, which shifts its pitch like a turntable; a version at this tempo keeps it
    line += `.fit() // ${record.name} is ${bpm} bpm`;
    makeVersion(record.name, tempo).catch((err) => logger(`[crate] ${err.message}`, 'error'));
  }
  lines.push(line);
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
