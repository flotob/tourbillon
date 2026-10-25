import { PlayIcon, PlusIcon, StopIcon, TrashIcon, XMarkIcon } from '@heroicons/react/16/solid';
import { useStore } from '@nanostores/react';
import { logger } from '@strudel/core';
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
  auditionPosition,
  barDuration,
  barsCode,
  cancelJob,
  clearJobs,
  deleteRecord,
  deleteVersion,
  findDrums,
  insertBars,
  insertDrums,
  insertNotes,
  makeVersion,
  pickFiles,
  playDrum,
  stopAudition,
  versionFor,
} from './crateStore.mjs';
import { DRUMS, DRUM_NAMES } from './drumCode.mjs';

const minutes = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

const STEPS = {
  starting: 'starting',
  installing: 'installing the python packages, first time only',
  separating: 'separating stems',
  beats: 'finding the beat',
  writing: 'cutting bars',
  stretching: 'stretching, same pitch',
  analyzing: 'finding the key',
  installing_adtof: 'downloading ADTOF, first time only (about 1.5 GB)',
  transcribing: 'finding the drum hits',
  cutting: 'cutting the kit',
};
// share of the whole job that each step starts and ends at; imports separate, versions stretch, then both write;
// drums install ADTOF once, then find the hits
const STEP_START = {
  separating: 0,
  beats: 0.8,
  stretching: 0,
  writing: 0.85,
  analyzing: 0,
  installing_adtof: 0,
  transcribing: 0.1,
  cutting: 0.9,
};
const STEP_END = {
  separating: 0.8,
  beats: 0.85,
  stretching: 0.85,
  writing: 1,
  analyzing: 1,
  installing_adtof: 1,
  transcribing: 0.9,
  cutting: 1,
};
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

// lanes of the stem map, in px; the map is as wide as the panel, whatever the record's length
const LANE = 20;
const LANE_GAP = 3;
// loudness to the share of a lane's height: silence and separation bleed stay flat, loud bars fill the lane
const level = (db) => Math.max(0, Math.min(1, (db + 50) / 40)) ** 1.5;
const STEM_HINTS = {
  mix: 'the original track',
  drums: 'drums and percussion',
  bass: 'the bass line',
  other: 'synths, pads, keys and everything else',
  vocals: 'voices',
};

// each stem's loudness per bar as a stepped outline mirrored around the lane's centre, like a waveform
const Lanes = memo(function Lanes({ record, rows }) {
  return rows.map((stem, row) => {
    const levels = record.levels?.[stem] ?? [];
    const mid = row * LANE + LANE / 2;
    const half = (LANE - LANE_GAP) / 2;
    let top = '';
    let bottom = '';
    levels.forEach((db, bar) => {
      const h = level(db) * half;
      top += `L${bar} ${mid - h}L${bar + 1} ${mid - h}`;
      bottom = `L${bar + 1} ${mid + h}L${bar} ${mid + h}` + bottom;
    });
    return (
      <g key={stem}>
        <line
          x1={0}
          x2={record.bars}
          y1={mid}
          y2={mid}
          stroke="currentColor"
          strokeOpacity={0.15}
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={`M0 ${mid}${top}L${levels.length} ${mid}${bottom}Z`}
          fill={stem === 'mix' ? 'currentColor' : `var(--stem-${stem})`}
          fillOpacity={stem === 'mix' ? 0.25 : 0.9}
        />
      </g>
    );
  });
});

// phrase lines every 16 bars, stronger every 64
function Grid({ bars, height }) {
  const lines = [];
  for (let bar = 16; bar < bars; bar += 16) {
    lines.push(
      <line
        key={bar}
        x1={bar}
        x2={bar}
        y1={0}
        y2={height}
        stroke="currentColor"
        strokeOpacity={bar % 64 === 0 ? 0.25 : 0.1}
        vectorEffect="non-scaling-stroke"
      />,
    );
  }
  return lines;
}

// the bar being listened to, moved every frame without re-rendering the lanes
function Playhead({ record, height }) {
  const ref = useRef();
  const current = useStore($audition);
  const playing = current?.name === record.name ? current : undefined;
  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame;
    const move = () => {
      const x = Math.min(record.bars, auditionPosition(playing));
      ref.current?.setAttribute('x1', x);
      ref.current?.setAttribute('x2', x);
      frame = requestAnimationFrame(move);
    };
    move();
    return () => cancelAnimationFrame(frame);
  }, [playing, record.bars]);
  if (!playing) {
    return null;
  }
  return <line ref={ref} y1={0} y2={height} stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />;
}

function StopButton() {
  return (
    <ActionButton label="Stop listening (Esc)" labelIsHidden className="flex items-center gap-1" onClick={stopAudition}>
      <StopIcon className="w-4 h-4" />
      <span>stop</span>
    </ActionButton>
  );
}

function StemMap({ record }) {
  const rows = useMemo(() => ['mix', ...PARTS].filter((stem) => record.stems.includes(stem)), [record]);
  const [drag, setDrag] = useState();
  const [selection, setSelection] = useState();
  const [hover, setHover] = useState();
  const current = useStore($audition);
  const playing = current?.name === record.name ? current : undefined;
  const height = rows.length * LANE;
  const box = useRef();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const cellAt = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const bar = Math.max(
      0,
      Math.min(record.bars - 1, Math.floor(((event.clientX - rect.left) / rect.width) * record.bars)),
    );
    const row = Math.max(0, Math.min(rows.length - 1, Math.floor((event.clientY - rect.top) / LANE)));
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
  // a click listens from that bar on, a drag selects bars
  const onPointerUp = (event) => {
    if (!drag) {
      return;
    }
    const { bar } = cellAt(event);
    if (drag.start === bar) {
      setSelection(undefined);
      audition(record, drag.stem, bar);
    } else {
      setSelection({ stem: drag.stem, ...range(drag.start, bar) });
    }
    setDrag(undefined);
  };

  const shown = drag && drag.start !== drag.end ? { stem: drag.stem, ...range(drag.start, drag.end) } : selection;
  // ruler numbers every 32 bars, or 64 when the map is narrow
  const step = (width / record.bars) * 32 < 40 ? 64 : 32;
  const ticks = [];
  for (let bar = 0; bar < record.bars; bar += step) {
    ticks.push(bar);
  }

  let info;
  if (hover) {
    info = (
      <span title={STEM_HINTS[hover.stem]}>
        {hover.stem}, bar {hover.bar} at {minutes((record.first_downbeat ?? 0) + hover.bar * barDuration(record))}
      </span>
    );
  } else if (playing) {
    info = `Listening to ${playing.stem} ${playing.loop ? `bars ${playing.from}–${playing.to - 1} on repeat` : `from bar ${playing.from}`}. Esc stops.`;
  } else if (shown) {
    info = <code>{barsCode(record, shown.stem, shown.from, shown.to).slice(3)}</code>;
  } else {
    info = 'Click a bar to listen from there. Drag across bars to select them.';
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <div className="shrink-0 text-xs text-right opacity-60">
          {rows.map((stem) => (
            <div key={stem} title={STEM_HINTS[stem]} style={{ height: LANE, lineHeight: `${LANE}px` }}>
              {stem}
            </div>
          ))}
        </div>
        <div className="grow min-w-0" ref={box}>
          <svg
            viewBox={`0 0 ${record.bars} ${height}`}
            preserveAspectRatio="none"
            width="100%"
            height={height}
            className="block text-foreground cursor-pointer select-none touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(undefined)}
          >
            <Grid bars={record.bars} height={height} />
            <Lanes record={record} rows={rows} />
            {hover && <rect x={hover.bar} width={1} y={0} height={height} fill="currentColor" fillOpacity={0.3} />}
            {shown && (
              <rect
                x={shown.from}
                width={shown.to - shown.from}
                y={rows.indexOf(shown.stem) * LANE}
                height={LANE}
                fill="currentColor"
                fillOpacity={0.2}
                stroke="currentColor"
                strokeOpacity={0.9}
                vectorEffect="non-scaling-stroke"
              />
            )}
            <Playhead record={record} height={height} />
          </svg>
          <div className="relative h-4 text-xs opacity-50">
            {ticks.map((bar) => (
              <span key={bar} className="absolute" style={{ left: `${(bar / record.bars) * 100}%` }}>
                {bar}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 min-h-6 text-xs">
        <span className="truncate opacity-70">{info}</span>
        <span className="flex items-center gap-3 shrink-0">
          {playing ? (
            <StopButton />
          ) : (
            selection && (
              <ActionButton
                label="Listen to the selected bars on repeat"
                labelIsHidden
                className="flex items-center gap-1"
                onClick={() => audition(record, selection.stem, selection.from, selection.to, true)}
              >
                <PlayIcon className="w-4 h-4" />
                <span>loop</span>
              </ActionButton>
            )
          )}
          {selection?.stem === 'bass' && record.notes?.bass && (
            <ActionButton
              label="Add the bass line of the selected bars to the editor as notes, played on a synth"
              labelIsHidden
              className="flex items-center gap-1"
              onClick={() => insertNotes(record, selection.from, selection.to)}
            >
              <PlusIcon className="w-4 h-4" />
              <span>as notes</span>
            </ActionButton>
          )}
          {selection?.stem === 'drums' && record.drums && (
            <ActionButton
              label="Add the drums of the selected bars to the editor as patterns, on the record's own kit"
              labelIsHidden
              className="flex items-center gap-1"
              onClick={() =>
                insertDrums(record, selection.from, selection.to).catch((err) =>
                  logger(`[crate] ${err.message}`, 'error'),
                )
              }
            >
              <PlusIcon className="w-4 h-4" />
              <span>as patterns</span>
            </ActionButton>
          )}
          {selection && (
            <ActionButton
              label="Add code that plays the selected bars to the editor"
              labelIsHidden
              className="flex items-center gap-1"
              onClick={() => insertBars(record, selection.stem, selection.from, selection.to)}
            >
              <PlusIcon className="w-4 h-4" />
              <span>insert</span>
            </ActionButton>
          )}
        </span>
      </div>
    </div>
  );
}

// versions at other tempos; the crate plays the one closest to the code's tempo
function Tempos({ record }) {
  const tempo = useStore($tempo);
  const jobs = useStore($jobs);
  const [asking, setAsking] = useState(false);
  const [bpm, setBpm] = useState('');
  const [error, setError] = useState();
  const making = jobs.filter(
    (job) => job.kind === 'tempo' && job.name === record.name && (job.state === 'queued' || job.state === 'running'),
  );
  const inUse = tempo ? (versionFor(record, tempo / 240) ?? record.bpm) : undefined;
  const has = (value) => sameTempo(value, record.bpm) || record.versions.some((v) => sameTempo(v, value));
  // the code's tempo, when the record needs a version for it
  const suggested =
    tempo && Math.abs(tempo - record.bpm) > 0.5 && !has(tempo) && !making.some((job) => sameTempo(job.bpm, tempo))
      ? tempo
      : undefined;
  const make = async (value) => {
    setError(undefined);
    try {
      await makeVersion(record.name, Number(value));
      setAsking(false);
      setBpm('');
    } catch (err) {
      setError(errorText(err));
    }
  };
  const chip = (value, active) =>
    cx('flex items-center gap-1 px-1.5 rounded', active ? 'bg-lineHighlight font-bold' : 'opacity-70');

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        className="opacity-50"
        title="The record plays at these tempos without its pitch changing. When the code runs near one of them, the crate plays that version."
      >
        Tempos
      </span>
      <span className={chip(record.bpm, sameTempo(inUse ?? 0, record.bpm))} title="The record's own tempo">
        {+record.bpm.toFixed(2)} original
      </span>
      {record.versions.map((version) => (
        <span key={version} className={chip(version, version === inUse)}>
          {version}
          <button
            className="opacity-50 hover:opacity-100"
            title={`Delete the ${version} bpm version`}
            onClick={() => deleteVersion(record.name, version).catch((err) => setError(errorText(err)))}
          >
            <XMarkIcon className="w-3 h-3" />
          </button>
        </span>
      ))}
      {making.map((job) => (
        <span key={job.id} className="px-1.5 opacity-50 animate-pulse">
          {job.bpm} on its way
        </span>
      ))}
      {suggested && !asking && (
        <ActionButton
          label={`Make a ${suggested} bpm version, the tempo of the code`}
          labelIsHidden
          className="flex items-center gap-0.5"
          onClick={() => make(suggested)}
        >
          <PlusIcon className="w-3 h-3" />
          <span>{suggested}</span>
        </ActionButton>
      )}
      {asking ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            make(bpm);
          }}
        >
          <input
            autoFocus
            type="number"
            step="any"
            min={Math.ceil(record.bpm / 1.5)}
            max={Math.floor(record.bpm * 1.5)}
            placeholder="bpm"
            className="w-14 px-1 py-0 text-xs bg-background border border-muted rounded [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            value={bpm}
            onChange={(event) => setBpm(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setAsking(false)}
          />
          <ActionButton type="submit" label="make" disabled={!Number(bpm)} />
          <ActionButton type="button" label="cancel" onClick={() => setAsking(false)} />
        </form>
      ) : (
        <ActionButton
          label="Make a version at another tempo"
          labelIsHidden
          className="flex items-center gap-0.5 opacity-70"
          onClick={() => {
            setBpm(suggested ? String(suggested) : '');
            setAsking(true);
          }}
        >
          <PlusIcon className="w-3 h-3" />
          <span>other</span>
        </ActionButton>
      )}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}

// the record's drum kit, cut from it, and its drum patterns, found with ADTOF in the drums stem
function Drums({ record }) {
  const jobs = useStore($jobs);
  const [error, setError] = useState();
  const finding = jobs.some(
    (job) => job.kind === 'drums' && job.name === record.name && (job.state === 'queued' || job.state === 'running'),
  );
  const kit = DRUMS.filter((drum) => drum in (record.drums?.hits ?? {}));

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        className="opacity-50"
        title={`Which drum plays on which 16th of every bar, and a kit of the record's own drums: s("bd*4").bank("${record.name}")`}
      >
        Drums
      </span>
      {record.drums ? (
        <>
          {kit.map((drum) => (
            <ActionButton
              key={drum}
              label={`Listen to the ${DRUM_NAMES[drum]} of the kit, ${record.name}_${drum}; it plays ${record.drums.hits[drum]} times in the record`}
              labelIsHidden
              className="flex items-center gap-0.5 opacity-80"
              onClick={() => playDrum(record, drum)}
            >
              <PlayIcon className="w-3 h-3" />
              <span>{drum}</span>
            </ActionButton>
          ))}
          <span className="opacity-50">Select bars of the drums to insert them as patterns.</span>
        </>
      ) : finding ? (
        <span className="opacity-50 animate-pulse">finding the drum hits…</span>
      ) : (
        <ActionButton
          label="Find which drum plays on which 16th, and cut a kit from the record. Uses ADTOF, which is free for non-commercial use; the first time, it downloads about 1.5 GB."
          labelIsHidden
          className="flex items-center gap-0.5"
          onClick={() => {
            setError(undefined);
            findDrums(record.name).catch((err) => setError(errorText(err)));
          }}
        >
          <PlusIcon className="w-3 h-3" />
          <span>find patterns and kit</span>
        </ActionButton>
      )}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}

function Record({ record, open, onToggle }) {
  return (
    <div className={cx('rounded', open ? 'bg-background px-3 py-2 space-y-3' : 'px-3 py-1.5 hover:bg-background')}>
      <div className="flex items-start justify-between gap-4">
        <button className="text-left min-w-0" onClick={onToggle} aria-expanded={open}>
          <div className="truncate font-bold">{record.title}</div>
          <div className="truncate text-xs opacity-60">
            {record.artist && <span className="mr-2">{record.artist}</span>}
            <code
              className="px-1 rounded bg-lineHighlight"
              title={`Its sounds are ${record.name}_drums, ${record.name}_bass and so on`}
            >
              {record.name}
            </code>
          </div>
        </button>
        <div className="flex items-center gap-3 shrink-0 text-xs pt-0.5">
          <span className="opacity-80">{+record.bpm.toFixed(2)} bpm</span>
          {record.key && (
            <span className="opacity-80" title={`Camelot ${record.camelot}; key strength ${record.key_strength}`}>
              {record.key} <span className="opacity-60">{record.camelot}</span>
            </span>
          )}
          <span className="opacity-60">{minutes(record.duration)}</span>
          {open && (
            <ActionButton
              label={`Delete ${record.name} from the crate`}
              labelIsHidden
              className="opacity-50 hover:opacity-100"
              onClick={async () => {
                if (await confirmDialog(`Delete ${record.title} and its stems from the crate?`)) {
                  deleteRecord(record.name);
                }
              }}
            >
              <TrashIcon className="w-3.5 h-3.5" />
            </ActionButton>
          )}
        </div>
      </div>
      {open && (
        <>
          <StemMap record={record} />
          <Tempos record={record} />
          <Drums record={record} />
        </>
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
              Listening to {hidden.name}_{hidden.stem}
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
