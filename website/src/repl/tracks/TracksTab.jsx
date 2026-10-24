import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useState } from 'react';
import cx from '@src/cx.mjs';
import { ActionButton } from '../components/button/action-button.jsx';
import { ButtonGroup } from '../components/panel/Forms.jsx';
import { Textbox } from '../components/panel/SettingsTab.jsx';
import { confirmDialog } from '../util.mjs';
import {
  $currentTrack,
  $tracks,
  $versionsChanged,
  deleteTrack,
  duplicateTrack,
  loadVersion,
  newTrack,
  openTrack,
  renameTrack,
  tracks,
} from './tracksStore.mjs';

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString();
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString()} ${time}`;
}

const lines = (code) =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

// what a version changed compared to the one before it: the first new line, else the first removed one
function describeChange(code, previous) {
  const current = lines(code);
  if (previous === undefined) {
    return current[0] ?? '(empty)';
  }
  const before = new Set(lines(previous));
  const added = current.find((line) => !before.has(line));
  if (added) {
    return `+ ${added}`;
  }
  const now = new Set(current);
  const removed = lines(previous).find((line) => !now.has(line));
  return removed ? `- ${removed}` : '(reordered)';
}

function TitleInput({ track }) {
  const [title, setTitle] = useState(track.title);
  useEffect(() => setTitle(track.title), [track.id, track.title]);
  const save = () => title !== track.title && renameTrack(track.id, title.trim());
  return (
    <input
      className="w-full bg-transparent border-0 text-lg px-2 focus:ring-0"
      placeholder="untitled"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
    />
  );
}

function TrackList({ current }) {
  const list = useStore($tracks);
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? list.filter((track) => (track.title || 'untitled').toLowerCase().includes(q)) : list;
  }, [list, search]);
  return (
    <>
      <Textbox className="w-full border-0 shrink-0" placeholder="Search..." value={search} onChange={setSearch} />
      <div className="overflow-auto p-2 space-y-1">
        {visible.map((track) => (
          <button
            key={track.id}
            className={cx(
              'flex w-full justify-between space-x-4 text-left hover:opacity-50 px-1',
              track.id === current?.id && 'outline outline-1',
            )}
            onClick={() => openTrack(track.id)}
          >
            <span className="truncate">{track.title || 'untitled'}</span>
            <span className="text-xs opacity-50 shrink-0">{formatTime(track.updated_at)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function History({ current }) {
  const changed = useStore($versionsChanged);
  const [versions, setVersions] = useState([]);
  useEffect(() => {
    if (current) {
      tracks.versions(current.id).then(setVersions);
    }
  }, [current?.id, changed]);
  if (!versions.length) {
    return (
      <div className="p-2 opacity-50">Every time you evaluate this track (Ctrl+Enter), the code is kept here.</div>
    );
  }
  return (
    <div className="overflow-auto p-2 space-y-1">
      {versions.map((version, i) => (
        <button
          key={version.id}
          title="Put this version in the editor (Cmd+Z goes back)"
          className="flex w-full space-x-4 text-left hover:opacity-50 px-1"
          onClick={() => loadVersion(version.code)}
        >
          <span className="text-xs opacity-50 shrink-0">{formatTime(version.created_at)}</span>
          <span className="truncate text-xs">{describeChange(version.code, versions[i + 1]?.code)}</span>
        </button>
      ))}
    </div>
  );
}

export function TracksTab() {
  const current = useStore($currentTrack);
  const [view, setView] = useState('tracks');
  if (!current) {
    return <div className="p-4 text-foreground">loading…</div>;
  }
  return (
    <div className="w-full h-full text-foreground flex flex-col overflow-hidden">
      <div className="shrink-0 pt-2">
        <TitleInput track={current} />
      </div>
      <div className="px-2 shrink-0 h-8 flex items-center justify-between border-y border-muted">
        <div className="space-x-4 flex">
          <ActionButton label="new" onClick={() => newTrack()} />
          <ActionButton label="duplicate" onClick={duplicateTrack} />
          <ActionButton
            label="delete"
            onClick={async () => {
              const name = current.title || 'this untitled track';
              if (await confirmDialog(`Delete ${name}, its history and its chats?`)) {
                deleteTrack(current.id);
              }
            }}
          />
        </div>
        <ButtonGroup value={view} onChange={setView} items={{ tracks: 'tracks', history: 'history' }} />
      </div>
      {view === 'tracks' ? <TrackList current={current} /> : <History current={current} />}
    </div>
  );
}
