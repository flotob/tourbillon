import { PlayIcon, StopIcon } from '@heroicons/react/16/solid';
import { useStore } from '@nanostores/react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import cx from '@src/cx.mjs';
import { ActionButton } from '../components/button/action-button.jsx';
import { Textbox } from '../components/panel/SettingsTab.jsx';
import { confirmDialog } from '../util.mjs';
import {
  $audition,
  $jobs,
  $records,
  $status,
  $tempo,
  PARTS,
  audition,
  auditionBar,
  barDuration,
  cancelJob,
  clearJobs,
  deleteRecord,
  deleteVersion,
  insertBars,
  makeVersion,
  pickFiles,
  stopAudition,
  versionFor,
} from './crateStore.mjs';

// bars are at least this wide; short records stretch to the panel
const MIN_BAR_WIDTH = 4;
const MAX_BAR_WIDTH = 16;
const ROW_HEIGHT = 14;
const RULER_HEIGHT = 14;

const minutes = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
// loud bars are solid, separation bleed is faint
const opacity = (db) => Math.max(0, Math.min(1, (db + 50) / 40)) ** 1.5;
const barText = (from, to) => (to - from > 1 ? `bars ${from}–${to - 1} (${to - from})` : `bar ${from}`);

const STEPS = {
  starting: 'starting',
  installing: 'installing the python packages, first time only',
  separating: 'separating stems',
  beats: 'finding the beat',
  writing: 'cutting bars',
  stretching: 'stretching, same pitch',
  analyzing: 'finding the key',
};
// share of the whole job that each step starts and ends at; imports separate, versions stretch, then both write
const STEP_START = { separating: 0, beats: 0.8, stretching: 0, writing: 0.85, analyzing: 0 };
const STEP_END = { separating: 0.8, beats: 0.85, stretching: 0.85, writing: 1, analyzing: 1 };
// ipc errors arrive as "Error invoking remote method 'crate:…': Error: <message>"
const errorText = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const sameTempo = (a, b) => Math.abs(a - b) < 0.005;

function jobProgress(job) {
  if (!(job.step in STEP_START)) {
    return 0;
  }
  return STEP_START[job.step] + (job.fraction ?? 0) * (STEP_END[job.step] - STEP_START[job.step]);
}

function jobText(job) {
  switch (job.state) {
    case 'queued':
      return 'waiting';
    case 'running':
      return STEPS[job.step] ?? job.step;
    case 'done':
      if (job.kind === 'add') {
        return job.existing ? `already in the crate as ${job.name}` : `added as ${job.name}`;
      }
      return job.existing ? 'there already' : 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      return `failed: ${job.error}`;
  }
}

function Jobs() {
  const jobs = useStore($jobs);
  if (!jobs.length) {
    return null;
  }
  const finished = jobs.some((job) => job.state !== 'queued' && job.state !== 'running');
  return (
    <div className="px-2 py-1 space-y-1 border-b border-muted">
      {jobs.map((job) => (
        <div key={job.id} className="flex items-center space-x-2 text-xs">
          <span className="truncate w-40 shrink-0" title={job.file}>
            {job.title}
          </span>
          <span className={cx('grow truncate', job.state === 'error' && 'text-red-400')} title={job.error}>
            {jobText(job)}
          </span>
          {job.state === 'running' && (
            <span className="w-24 h-1.5 bg-background rounded shrink-0 overflow-hidden">
              <span className="block h-full bg-foreground" style={{ width: `${jobProgress(job) * 100}%` }} />
            </span>
          )}
          {(job.state === 'queued' || job.state === 'running') && (
            <ActionButton label="cancel" onClick={() => cancelJob(job.id)} />
          )}
        </div>
      ))}
      {finished && (
        <div className="flex justify-end">
          <ActionButton label="clear" onClick={clearJobs} />
        </div>
      )}
    </div>
  );
}

// one row per stem, one column per bar; opacity is loudness
const BarCells = memo(function BarCells({ record, rows, barWidth }) {
  return rows.map((stem, row) =>
    record.levels?.[stem]?.map((db, bar) => (
      <rect
        key={`${stem}${bar}`}
        x={bar * barWidth}
        y={row * ROW_HEIGHT + 1}
        width={barWidth - 1}
        height={ROW_HEIGHT - 2}
        fill="currentColor"
        opacity={opacity(db)}
      />
    )),
  );
});

function Ruler({ bars, y, barWidth }) {
  const ticks = [];
  for (let bar = 0; bar <= bars; bar += 8) {
    const major = bar % 32 === 0;
    ticks.push(
      <g key={bar} opacity={0.5}>
        <line x1={bar * barWidth} x2={bar * barWidth} y1={y} y2={y + (major ? 5 : 3)} stroke="currentColor" />
        {major && (
          <text x={bar * barWidth + 2} y={y + RULER_HEIGHT - 2} fontSize={9} fill="currentColor">
            {bar}
          </text>
        )}
      </g>,
    );
  }
  return ticks;
}

// the playing bar, moved without re-rendering the cells
function Cursor({ record, rows, barWidth }) {
  const ref = useRef();
  const current = useStore($audition);
  const playing = current?.name === record.name ? current : undefined;
  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame;
    const move = () => {
      const bar = auditionBar(playing);
      ref.current?.setAttribute('x', bar * barWidth - 1);
      frame = requestAnimationFrame(move);
    };
    move();
    return () => cancelAnimationFrame(frame);
  }, [playing, barWidth]);
  if (!playing) {
    return null;
  }
  const row = rows.indexOf(playing.stem);
  return (
    <rect
      ref={ref}
      y={row * ROW_HEIGHT}
      width={barWidth + 1}
      height={ROW_HEIGHT}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
    />
  );
}

function StopButton() {
  return (
    <ActionButton
      label="stop listening (Esc)"
      labelIsHidden
      className="flex items-center space-x-1"
      onClick={stopAudition}
    >
      <StopIcon className="w-4 h-4" />
      <span>stop</span>
    </ActionButton>
  );
}

function BarMap({ record }) {
  const rows = useMemo(() => ['mix', ...PARTS].filter((stem) => record.stems.includes(stem)), [record]);
  const [drag, setDrag] = useState();
  const [selection, setSelection] = useState();
  const [hover, setHover] = useState();
  const current = useStore($audition);
  const playing = current?.name === record.name;
  const height = rows.length * ROW_HEIGHT;
  const scroller = useRef();
  const [space, setSpace] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSpace(entry.contentRect.width));
    observer.observe(scroller.current);
    return () => observer.disconnect();
  }, []);
  const barWidth = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, Math.floor(space / record.bars)));

  const cellAt = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const bar = Math.max(0, Math.min(record.bars - 1, Math.floor((event.clientX - box.left) / barWidth)));
    const row = Math.max(0, Math.min(rows.length - 1, Math.floor((event.clientY - box.top) / ROW_HEIGHT)));
    return { bar, stem: rows[row] };
  };
  const range = (a, b) => ({ from: Math.min(a, b), to: Math.max(a, b) + 1 });

  const onPointerDown = (event) => {
    const { bar, stem } = cellAt(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ stem, start: bar, end: bar });
  };
  const onPointerMove = (event) => {
    const cell = cellAt(event);
    setHover(cell);
    if (drag) {
      setDrag({ ...drag, end: cell.bar });
    }
  };
  // a click plays from that bar on, a drag selects bars
  const onPointerUp = (event) => {
    if (!drag) {
      return;
    }
    const { bar } = cellAt(event);
    setSelection({ stem: drag.stem, ...range(drag.start, bar) });
    if (drag.start === bar) {
      audition(record, drag.stem, bar);
    }
    setDrag(undefined);
  };

  const shown = drag ? { stem: drag.stem, ...range(drag.start, drag.end) } : selection;
  let info = 'click a bar to listen from there, drag to select bars';
  if (hover) {
    const db = record.levels?.[hover.stem]?.[hover.bar];
    info = `${hover.stem} · bar ${hover.bar}${db !== undefined ? ` · ${db} dB` : ''}`;
  } else if (playing) {
    const what = current.loop ? `looping ${barText(current.from, current.to)}` : `from bar ${current.from}`;
    info = `playing ${current.stem} ${what} · Esc stops`;
  } else if (shown) {
    info = `${shown.stem} · ${barText(shown.from, shown.to)}`;
  }

  return (
    <div className="space-y-1">
      <div className="flex">
        <div className="shrink-0 w-14 text-xs opacity-60">
          {rows.map((stem) => (
            <div key={stem} style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}>
              {stem}
            </div>
          ))}
        </div>
        <div className="overflow-x-auto grow" ref={scroller}>
          <svg
            width={record.bars * barWidth}
            height={height + RULER_HEIGHT}
            className="text-foreground cursor-pointer select-none touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(undefined)}
          >
            <BarCells record={record} rows={rows} barWidth={barWidth} />
            {shown && (
              <rect
                x={shown.from * barWidth - 1}
                y={rows.indexOf(shown.stem) * ROW_HEIGHT}
                width={(shown.to - shown.from) * barWidth + 1}
                height={ROW_HEIGHT}
                fill="currentColor"
                fillOpacity={0.2}
                stroke="currentColor"
                strokeOpacity={0.8}
              />
            )}
            <Cursor record={record} rows={rows} barWidth={barWidth} />
            <Ruler bars={record.bars} y={height} barWidth={barWidth} />
          </svg>
        </div>
      </div>
      <div className="flex items-center justify-between space-x-2 text-xs">
        <span className="truncate opacity-70">{info}</span>
        <span className="flex items-center space-x-3 shrink-0">
          {playing ? (
            <StopButton />
          ) : (
            selection && (
              <ActionButton
                label="loop the selected bars"
                labelIsHidden
                className="flex items-center space-x-1"
                onClick={() => audition(record, selection.stem, selection.from, selection.to, true)}
              >
                <PlayIcon className="w-4 h-4" />
                <span>loop</span>
              </ActionButton>
            )
          )}
          {selection && (
            <ActionButton
              label="insert"
              title="Add code that plays the selected bars to the editor"
              onClick={() => insertBars(record, selection.stem, selection.from, selection.to)}
            />
          )}
        </span>
      </div>
    </div>
  );
}

// versions at other tempos: the crate plays the one closest to the tempo of the code
function Versions({ record }) {
  const tempo = useStore($tempo);
  const jobs = useStore($jobs);
  const [bpm, setBpm] = useState();
  const [error, setError] = useState();
  const making = jobs.filter(
    (job) => job.kind === 'tempo' && job.name === record.name && (job.state === 'queued' || job.state === 'running'),
  );
  const inUse = tempo && versionFor(record, tempo / 240);
  // the code's tempo, when the record needs a version for it
  const suggested =
    tempo && Math.abs(tempo - record.bpm) > 0.5 && !record.versions.some((v) => sameTempo(v, tempo)) ? tempo : '';
  const value = bpm ?? String(suggested);
  const make = async (event) => {
    event.preventDefault();
    setError(undefined);
    try {
      await makeVersion(record.name, Number(value));
      setBpm(undefined);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="flex items-center justify-between space-x-2 text-xs">
      <span
        className="flex flex-wrap items-center gap-x-3"
        title="Versions at other tempos keep the pitch. When the code plays near one of these tempos, the crate plays that version."
      >
        <span className="opacity-50">same pitch at</span>
        {!record.versions.length && !making.length && <span className="opacity-50">no other tempo yet</span>}
        {record.versions.map((version) => (
          <span key={version} className={cx('flex items-center', version === inUse ? 'font-bold' : 'opacity-70')}>
            {version} bpm
            <button
              className="ml-1 opacity-50 hover:opacity-100"
              title={`Delete the ${version} bpm version`}
              onClick={() => deleteVersion(record.name, version).catch((err) => setError(errorText(err)))}
            >
              ×
            </button>
          </span>
        ))}
        {making.map((job) => (
          <span key={job.id} className="opacity-50">
            {job.bpm} bpm…
          </span>
        ))}
        {error && <span className="text-red-400">{error}</span>}
      </span>
      <form className="flex items-center space-x-1 shrink-0" onSubmit={make}>
        <input
          type="number"
          step="any"
          min={Math.ceil(record.bpm / 1.5)}
          max={Math.floor(record.bpm * 1.5)}
          placeholder="bpm"
          className="w-16 px-1 py-0 text-xs bg-background border border-muted rounded"
          value={value}
          onChange={(event) => setBpm(event.target.value)}
        />
        <ActionButton type="submit" label="make version" disabled={!Number(value)} />
      </form>
    </div>
  );
}

function Record({ record, open, onToggle }) {
  const by = record.artist ? ` · ${record.artist}` : '';
  return (
    <div className={cx('px-2 py-1 rounded', open && 'bg-background')}>
      <div className="flex items-center justify-between space-x-4">
        <button className="text-left truncate hover:opacity-50" onClick={onToggle}>
          <span className="font-bold">{record.name}</span>
          <span className="opacity-60">
            {' '}
            {record.title}
            {by}
          </span>
        </button>
        <span className="text-xs opacity-50 shrink-0">
          {+record.bpm.toFixed(2)} bpm
          {record.key && (
            <span title={`key strength ${record.key_strength}: how clearly the music follows this key`}>
              {' '}
              · {record.key} ({record.camelot})
            </span>
          )}{' '}
          · {record.bars} bars · {minutes(record.duration)}
        </span>
      </div>
      {open && (
        <div className="pt-2 space-y-2">
          <BarMap record={record} />
          <Versions record={record} />
          <div className="flex items-center justify-between text-xs">
            <span className="opacity-50">
              s("{record.name}_{record.stems.find((stem) => stem !== 'mix') ?? 'mix'}").n(bar) · one bar is{' '}
              {barDuration(record).toFixed(3)}s
            </span>
            <ActionButton
              label="delete"
              onClick={async () => {
                if (await confirmDialog(`Delete ${record.name} and its stems from the crate?`)) {
                  deleteRecord(record.name);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function CrateTab() {
  const status = useStore($status);
  const records = useStore($records);
  const [openName, setOpenName] = useState();
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? records.filter((r) => [r.name, r.title, r.artist].some((text) => text?.toLowerCase().includes(q)))
      : records;
  }, [records, search]);
  // the newest record is open until one is picked
  const open = openName === undefined ? records[0] : records.find((r) => r.name === openName);
  // a preview of a closed record can still be stopped here
  const current = useStore($audition);
  const hidden = current && current.name !== open?.name ? current : undefined;

  return (
    <div className="w-full h-full text-foreground flex flex-col overflow-hidden">
      <div className="px-2 shrink-0 h-8 flex items-center justify-between space-x-2 border-b border-muted">
        <ActionButton label="import…" onClick={pickFiles} disabled={!!status?.problem} />
        {hidden ? (
          <span className="flex items-center space-x-3 text-xs">
            <span className="opacity-70 truncate">
              playing {hidden.name}_{hidden.stem}
            </span>
            <StopButton />
          </span>
        ) : (
          <span className="text-xs opacity-50">or drop audio files anywhere in the window</span>
        )}
      </div>
      {status?.problem && <div className="p-2 text-xs text-red-400">{status.problem}</div>}
      <Jobs />
      {records.length > 4 && (
        <Textbox className="w-full border-0 shrink-0" placeholder="Search..." value={search} onChange={setSearch} />
      )}
      <div className="overflow-auto p-2 space-y-1">
        {!records.length && (
          <div className="opacity-50 text-sm space-y-2">
            <p>
              The crate holds tracks you import: each one is separated into drums, bass, other and vocals and cut into
              bars.
            </p>
            <p>
              Bar n of a stem plays with <code>s("record_stem").n(n)</code>, and the agent knows where each stem plays.
            </p>
          </div>
        )}
        {visible.map((record) => (
          <Record
            key={record.name}
            record={record}
            open={open?.name === record.name}
            onToggle={() => setOpenName(open?.name === record.name ? null : record.name)}
          />
        ))}
      </div>
    </div>
  );
}
