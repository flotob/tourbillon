// tracks are the code pages of the desktop app, stored in the main process database.
// the editor always shows the open track: edits are saved shortly after typing, every evaluation adds a version
import { isolateHistory } from '@codemirror/commands';
import { nanoid } from 'nanoid';
import { atom } from 'nanostores';
import { openTrackChats } from '../agent/agentStore.mjs';

export const tracks = typeof window !== 'undefined' ? window.tourbillon?.tracks : undefined;

const SAVE_DELAY_MS = 800;

// [{ id, title, created_at, updated_at }], most recently changed first
export const $tracks = atom([]);
export const $currentTrack = atom(undefined);
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

// typing or agent edits
export function codeChanged(code) {
  const track = $currentTrack.get();
  if (!track || code === savedCode) return;
  savedCode = code;
  clearTimeout(pendingSave?.timer);
  pendingSave = { id: track.id, code, timer: setTimeout(flushSave, SAVE_DELAY_MS) };
}

export async function evaluated(code) {
  const track = $currentTrack.get();
  if (!track) return;
  if (pendingSave?.id === track.id) {
    clearTimeout(pendingSave.timer);
    pendingSave = undefined;
  }
  savedCode = code;
  if (await tracks.evaluated(track.id, code)) {
    $versionsChanged.set($versionsChanged.get() + 1);
  }
  refreshTracks();
}

export async function openTrack(id) {
  await flushSave();
  const track = await tracks.get(id);
  if (!track) return;
  savedCode = track.code;
  $currentTrack.set({ id: track.id, title: track.title });
  // a fresh undo history, so undo cannot bring back code of the previous track
  editor.resetCode(track.code);
  tracks.setLast(id);
  openTrackChats(id);
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
  await tracks.remove(id);
  await refreshTracks();
  if ($currentTrack.get()?.id === id) {
    const next = $tracks.get()[0];
    await (next ? openTrack(next.id) : newTrack());
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

// opens the track used last, or creates the first one
export async function initTracks(strudelMirror, firstCode) {
  editor = strudelMirror;
  await refreshTracks();
  const lastId = await tracks.getLast();
  const list = $tracks.get();
  const id = list.find((track) => track.id === lastId)?.id ?? list[0]?.id;
  await (id ? openTrack(id) : newTrack({ code: firstCode }));
}
