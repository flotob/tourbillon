// tracks are the code pages of the desktop app, stored in the main process database.
// open tracks are tabs above the editor, which shows the active one: edits are saved shortly after typing,
// every evaluation adds a version
import { isolateHistory } from '@codemirror/commands';
import { nanoid } from 'nanoid';
import { atom } from 'nanostores';
import { openTrackChats } from '../agent/agentStore.mjs';

export const tracks = typeof window !== 'undefined' ? window.tourbillon?.tracks : undefined;

const SAVE_DELAY_MS = 800;

// [{ id, title, created_at, updated_at }], most recently changed first
export const $tracks = atom([]);
// the active tab
export const $currentTrack = atom(undefined);
// track ids of the open tabs, in order
export const $openTracks = atom([]);
// the music that plays comes from the track evaluated last, also after switching tabs
export const $playing = atom({ trackId: undefined, started: false });
// bumped when the open track gets a new version
export const $versionsChanged = atom(0);

let editor;
// code of the open track as last loaded or saved, to skip saves without changes
let savedCode;
let pendingSave;

export async function refreshTracks() {
  $tracks.set(await tracks.list());
}

async function flushSave() {
  if (!pendingSave) return;
  const { id, code } = pendingSave;
  clearTimeout(pendingSave.timer);
  pendingSave = undefined;
  if (await tracks.save(id, code)) {
    refreshTracks();
  }
}

const saveTabs = () => tracks.setTabs({ open: $openTracks.get(), active: $currentTrack.get()?.id });

// typing or agent edits
function codeChanged(code) {
  const track = $currentTrack.get();
  if (!track || code === savedCode) return;
  savedCode = code;
  clearTimeout(pendingSave?.timer);
  pendingSave = { id: track.id, code, timer: setTimeout(flushSave, SAVE_DELAY_MS) };
}

export function replStateChanged({ code, started }) {
  codeChanged(code);
  if (started !== $playing.get().started) {
    $playing.set({ ...$playing.get(), started });
  }
}

export async function evaluated(code) {
  const track = $currentTrack.get();
  if (!track) return;
  if (pendingSave?.id === track.id) {
    clearTimeout(pendingSave.timer);
    pendingSave = undefined;
  }
  savedCode = code;
  $playing.set({ ...$playing.get(), trackId: track.id });
  if (await tracks.evaluated(track.id, code)) {
    $versionsChanged.set($versionsChanged.get() + 1);
  }
  refreshTracks();
}

// highlighting and widgets only fit the code they were evaluated from
function showEvalDecorations() {
  const isEvaluatedCode =
    $currentTrack.get()?.id === $playing.get().trackId && editor.code === editor.repl.state.activeCode;
  if (isEvaluatedCode) {
    editor.restoreEvalDecorations();
  } else {
    editor.clearEvalDecorations();
  }
}

// shows a track in the editor, opening a tab for it if needed
export async function openTrack(id) {
  if ($currentTrack.get()?.id === id) return;
  await flushSave();
  const track = await tracks.get(id);
  if (!track) return;
  if (!$openTracks.get().includes(id)) {
    $openTracks.set([...$openTracks.get(), id]);
  }
  savedCode = track.code;
  $currentTrack.set({ id: track.id, title: track.title });
  // a fresh undo history, so undo cannot bring back code of the previous track
  editor.resetCode(track.code);
  showEvalDecorations();
  saveTabs();
  openTrackChats(id);
}

// the last tab cannot be closed unless another track can take its place
export async function closeTab(id = $currentTrack.get()?.id) {
  const open = $openTracks.get();
  const index = open.indexOf(id);
  if (index === -1) return;
  let rest = open.filter((other) => other !== id);
  if (!rest.length) {
    const other = $tracks.get().find((track) => track.id !== id);
    if (!other) return;
    rest = [other.id];
  }
  $openTracks.set(rest);
  if ($currentTrack.get()?.id === id) {
    await openTrack(rest[Math.min(index, rest.length - 1)]);
  } else {
    saveTabs();
  }
  if (await tracks.removeIfEmpty(id)) {
    refreshTracks();
  }
}

export async function newTrack({ code = '', title = '' } = {}) {
  await flushSave();
  const id = nanoid(12);
  await tracks.create({ id, title, code });
  await refreshTracks();
  await openTrack(id);
}

export function duplicateTrack() {
  const title = $currentTrack.get()?.title;
  return newTrack({ code: editor.code, title: `${title || 'untitled'} copy` });
}

export async function deleteTrack(id) {
  if (pendingSave?.id === id) {
    clearTimeout(pendingSave.timer);
    pendingSave = undefined;
  }
  const open = $openTracks.get();
  const index = open.indexOf(id);
  const rest = open.filter((other) => other !== id);
  $openTracks.set(rest);
  await tracks.remove(id);
  await refreshTracks();
  if ($currentTrack.get()?.id === id) {
    const next = rest[Math.min(index, rest.length - 1)] ?? $tracks.get()[0]?.id;
    await (next ? openTrack(next) : newTrack());
  } else {
    saveTabs();
  }
}

export async function renameTrack(id, title) {
  await tracks.rename(id, title);
  if ($currentTrack.get()?.id === id) {
    $currentTrack.set({ ...$currentTrack.get(), title });
  }
  await refreshTracks();
}

// puts an earlier version in the editor as one undoable change, without evaluating it
export function loadVersion(code) {
  const view = editor.editor;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: code },
    annotations: isolateHistory.of('full'),
  });
}

function handleMenu(action) {
  if (action === 'new-track') {
    newTrack();
  } else if (action === 'close-tab') {
    closeTab();
  }
}

// restores the tabs of the last session, or creates the first track
export async function initTracks(strudelMirror, firstCode) {
  editor = strudelMirror;
  window.tourbillon.onMenu(handleMenu);
  await refreshTracks();
  const existing = new Set($tracks.get().map((track) => track.id));
  const tabs = (await tracks.getTabs()) ?? { open: [] };
  const open = tabs.open.filter((id) => existing.has(id));
  $openTracks.set(open);
  const active = open.includes(tabs.active) ? tabs.active : (open[0] ?? $tracks.get()[0]?.id);
  await (active ? openTrack(active) : newTrack({ code: firstCode }));
}
