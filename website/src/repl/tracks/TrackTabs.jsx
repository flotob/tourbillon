import { PlayIcon, PlusIcon, XMarkIcon } from '@heroicons/react/16/solid';
import { useStore } from '@nanostores/react';
import { useRef, useState } from 'react';
import cx from '@src/cx.mjs';
import { useSettings } from '../../settings.mjs';
import {
  $currentTrack,
  $openTracks,
  $playing,
  $tracks,
  closeTab,
  newTrack,
  openTrack,
  renameTrack,
} from './tracksStore.mjs';

// Enter or leaving the field saves, Escape cancels
function TitleField({ id, title, onDone }) {
  const [value, setValue] = useState(title);
  // removing the field can fire blur after Escape, which must not save
  const finished = useRef(false);
  const finish = (save) => {
    if (finished.current) return;
    finished.current = true;
    if (save && value.trim() !== title) {
      renameTrack(id, value.trim());
    }
    onDone();
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.target.select()}
      className="w-36 h-6 px-1 py-0 bg-background text-foreground text-sm border border-muted rounded focus:ring-0 focus:border-foreground"
      placeholder="untitled"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

// tabs of the open tracks above the editor; the one whose code is playing shows a play icon.
// a double click on a tab renames the track
export function TrackTabs() {
  const [renaming, setRenaming] = useState();
  const open = useStore($openTracks);
  const current = useStore($currentTrack);
  const playing = useStore($playing);
  const titles = new Map(useStore($tracks).map((track) => [track.id, track.title]));
  const { fontFamily } = useSettings();
  return (
    <div
      className="flex shrink-0 h-9 min-h-9 border-b border-muted bg-lineHighlight overflow-x-auto select-none text-sm text-foreground"
      style={{ fontFamily }}
    >
      {open.map((id) => {
        const isPlaying = playing.started && playing.trackId === id;
        return (
          <div
            key={id}
            title={isPlaying ? 'playing' : undefined}
            onClick={() => openTrack(id)}
            onDoubleClick={() => setRenaming(id)}
            // middle click closes, as in a browser
            onAuxClick={(e) => e.button === 1 && closeTab(id)}
            className={cx(
              'group flex items-center shrink-0 max-w-56 h-full pl-3 pr-1 space-x-2 border-r border-muted cursor-pointer',
              id === current?.id ? 'bg-background' : 'opacity-60 hover:opacity-100',
            )}
          >
            {isPlaying && <PlayIcon className="w-3 h-3 shrink-0 animate-pulse" />}
            {renaming === id ? (
              <TitleField id={id} title={titles.get(id) ?? ''} onDone={() => setRenaming(undefined)} />
            ) : (
              <span className="truncate">{titles.get(id) || 'untitled'}</span>
            )}
            <button
              title="close tab (Cmd+W)"
              className={cx(
                'p-0.5 rounded hover:bg-lineHighlight',
                id === current?.id ? 'opacity-60' : 'opacity-0 group-hover:opacity-60',
              )}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id);
              }}
            >
              <XMarkIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
      <button title="new track (Cmd+N)" className="px-3 h-full hover:opacity-50" onClick={() => newTrack()}>
        <PlusIcon className="w-4 h-4" />
      </button>
    </div>
  );
}
