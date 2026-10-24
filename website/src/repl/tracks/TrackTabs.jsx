import { PlayIcon, PlusIcon, XMarkIcon } from '@heroicons/react/16/solid';
import { useStore } from '@nanostores/react';
import cx from '@src/cx.mjs';
import { useSettings } from '../../settings.mjs';
import { $currentTrack, $openTracks, $playing, $tracks, closeTab, newTrack, openTrack } from './tracksStore.mjs';

// tabs of the open tracks above the editor; the one whose code is playing shows a play icon
export function TrackTabs() {
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
            // middle click closes, as in a browser
            onAuxClick={(e) => e.button === 1 && closeTab(id)}
            className={cx(
              'group flex items-center shrink-0 max-w-56 h-full pl-3 pr-1 space-x-2 border-r border-muted cursor-pointer',
              id === current?.id ? 'bg-background' : 'opacity-60 hover:opacity-100',
            )}
          >
            {isPlaying && <PlayIcon className="w-3 h-3 shrink-0 animate-pulse" />}
            <span className="truncate">{titles.get(id) || 'untitled'}</span>
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
