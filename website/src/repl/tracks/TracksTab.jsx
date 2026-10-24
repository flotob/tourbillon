import { PlayIcon } from '@heroicons/react/16/solid';
import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useState } from 'react';
import cx from '@src/cx.mjs';
import { ActionButton } from '../components/button/action-button.jsx';
import { ButtonGroup } from '../components/panel/Forms.jsx';
import { Textbox } from '../components/panel/SettingsTab.jsx';
import { confirmDialog } from '../util.mjs';
import {
  $currentTrack,
  $editorCode,
  $loadedVersion,
  $openTracks,
  $playing,
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

// a click selects a track, a double click opens it in a tab
function TrackList({ current }) {
  const list = useStore($tracks);
  const open = useStore($openTracks);
  const playing = useStore($playing);
  const [selected, setSelected] = useState();
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
            title="double click to open"
            className={cx(
              'flex w-full items-center justify-between space-x-4 text-left px-1 rounded',
              track.id === selected ? 'bg-background' : 'hover:opacity-50',
              track.id === current?.id && 'outline outline-1',
            )}
            onClick={() => setSelected(track.id)}
            onDoubleClick={() => openTrack(track.id)}
          >
            <span className={cx('flex items-center space-x-2 truncate', !open.includes(track.id) && 'opacity-60')}>
              {playing.started && playing.trackId === track.id && <PlayIcon className="w-3 h-3 shrink-0" />}
              <span className="truncate">{track.title || 'untitled'}</span>
            </span>
            <span className="text-xs opacity-50 shrink-0">{formatTime(track.updated_at)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function History({ current }) {
  const changed = useStore($versionsChanged);
  const editorCode = useStore($editorCode);
  const loaded = useStore($loadedVersion);
  const playing = useStore($playing);
  const [versions, setVersions] = useState([]);
  useEffect(() => {
    if (current) {
      tracks.versions(current.id).then(setVersions);
    }
  }, [current?.id, changed]);
  // the same code can be in several versions: prefer the one loaded last, else the newest
  const find = (code, preferred) =>
    versions.find((v) => v.id === preferred && v.code === code)?.id ?? versions.find((v) => v.code === code)?.id;
  const shownId = find(editorCode, loaded);
  const playingId = playing.started && playing.trackId === current.id ? find(playing.code, shownId) : undefined;
  if (!versions.length) {
    return (
      <div className="p-2 opacity-50">Every time you evaluate this track (Ctrl+Enter), the code is kept here.</div>
    );
  }
  return (
    <div className="overflow-auto p-2 space-y-1">
      {!shownId && (
        <div className="px-1 pb-1 text-xs opacity-50">
          The editor has changes that are not in the history yet. Evaluating (Ctrl+Enter) adds them.
        </div>
      )}
      {versions.map((version, i) => (
        <button
          key={version.id}
          title="Put this version in the editor (Cmd+Z goes back)"
          className={cx(
            'flex w-full items-center space-x-4 text-left px-1 rounded',
            version.id === shownId ? 'bg-background' : 'hover:opacity-50',
          )}
          onClick={() => loadVersion(version)}
        >
          <span className="flex items-center space-x-1 text-xs opacity-50 shrink-0">
            <PlayIcon className={cx('w-3 h-3', version.id !== playingId && 'invisible')} />
            <span>{formatTime(version.created_at)}</span>
          </span>
          <span className="grow truncate text-xs">{describeChange(version.code, versions[i + 1]?.code)}</span>
          {version.id === shownId && <span className="text-xs opacity-50 shrink-0">in editor</span>}
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
