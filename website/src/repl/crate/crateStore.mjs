// the crate in the renderer: records become strudel sounds (<record>_<stem>, n = bar), imports report progress,
// bars can be auditioned and inserted as code. Records are made by the crate project, run by the main process.
import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { getAudioContext, loadBuffer, samples, soundMap } from '@strudel/webaudio';
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

export const barDuration = (record) => 240 / record.bpm;

// created_at keeps a re-imported record from playing cached audio of the old one
const barPath = (record, stem, bar) =>
  `${record.name}/bars/${stem}/${String(bar).padStart(3, '0')}.flac?v=${Math.round(record.created_at)}`;

let registered = new Set();

export async function registerCrateSounds(records) {
  if (!crate) {
    return;
  }
  records ??= await crate.records();
  const sounds = {};
  for (const record of records) {
    for (const stem of record.stems) {
      sounds[`${record.name}_${stem}`] = Array.from({ length: record.bars }, (_, bar) => barPath(record, stem, bar));
    }
  }
  for (const key of registered) {
    if (!(key in sounds)) {
      soundMap.setKey(key, undefined);
    }
  }
  registered = new Set(Object.keys(sounds));
  await samples(sounds, BASE, { prebake: true, tag: 'crate' });
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

// the bar an audition is playing right now
export function auditionBar(audition) {
  const elapsed = getAudioContext().currentTime - audition.startTime;
  const index = Math.max(0, Math.floor(elapsed / audition.barDuration));
  return audition.loop ? audition.from + (index % (audition.to - audition.from)) : audition.from + index;
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
  const cpm = editor.repl.scheduler.cps * 60;
  if (lines.length === 0 && Math.abs(cpm * 4 - bpm) > 0.5) {
    // fit stretches each bar to a cycle, which shifts its pitch like a turntable
    line += `.fit() // ${record.name} is ${bpm} bpm`;
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
