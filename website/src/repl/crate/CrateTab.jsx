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
  loadDrums,
  loadOutline,
  makeVersion,
  pickFiles,
  playDrum,
  stopAudition,
  versionFor,
} from './crateStore.mjs';
import { DRUMS, DRUM_NAMES } from './drumCode.mjs';
import {
  clampView,
  gridLines,
  isZoomed,
  lanePath,
  panView,
  prepareOutline,
  resolution,
  rulerStep,
  zoomView,
} from './mapView.mjs';
import { noteName } from './noteCode.mjs';

const minutes = (seconds) => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

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

// lanes of the stem map, in px; the map is as wide as the panel and shows the whole record until zoomed in
const LANE = 20;
const LANE_GAP = 3;
// px per bar from which drum hits and bass notes are drawn over their lanes (a 16th is then 3 px wide)
const DETAIL = 48;
// loudness to the share of a lane's height: silence and separation bleed stay flat, loud bars fill the lane
const level = (db) => Math.max(0, Math.min(1, (db + 50) / 40)) ** 1.5;
const STEM_HINTS = {
  mix: 'the original track',
  drums: 'drums and percussion',
  bass: 'the bass line',
  other: 'synths, pads, keys and everything else',
  vocals: 'voices',
};

// px across the map for a bar, in the view
const toX = (view, width) => (bar) => ((bar - view.start) / view.bars) * width;

// each stem's loudness as a stepped outline mirrored around the lane's centre, like a waveform: per bar when the
// whole record is shown, in finer steps (from outline.json) the further the map is zoomed in
const Lanes = memo(function Lanes({ record, rows, outline, view, width, dimmed }) {
  const x = toX(view, width);
  const per = outline ? resolution(width / view.bars, outline.steps) : 1;
  const half = (LANE - LANE_GAP) / 2;
  return rows.map((stem, row) => {
    const detail = outline?.levels[stem];
    const points = detail ? detail.get(per) : (record.levels?.[stem] ?? []);
    const mid = row * LANE + LANE / 2;
    return (
      <g key={stem}>
        <line x1={0} x2={width} y1={mid} y2={mid} stroke="currentColor" strokeOpacity={0.15} />
        <path
          d={lanePath(points, detail ? per : 1, view.start, view.start + view.bars, x, mid, half, level)}
          fill={stem === 'mix' ? 'currentColor' : `var(--stem-${stem})`}
          fillOpacity={stem === 'mix' ? 0.25 : dimmed.includes(stem) ? 0.35 : 0.9}
        />
      </g>
    );
  });
});

// lines every 16 bars, stronger every 64; every bar and beat when zoomed in
function Grid({ view, width, height }) {
  const x = toX(view, width);
  return gridLines(view.start, view.start + view.bars, width / view.bars).map(({ bar, opacity }) => {
    const px = Math.round(x(bar)) + 0.5;
    return <line key={bar} x1={px} x2={px} y1={0} y2={height} stroke="currentColor" strokeOpacity={opacity} />;
  });
}

// the drum hits crate found, a row per drum from the cymbals at the top to the kick at the bottom, darker when louder
const DrumHits = memo(function DrumHits({ hits, row, view, width }) {
  const x = toX(view, width);
  const sixteenth = width / view.bars / 16;
  const drums = [...DRUMS].reverse().filter((drum) => hits[drum]?.length);
  const h = (LANE - LANE_GAP) / drums.length;
  const top = row * LANE + LANE_GAP / 2;
  const end = view.start + view.bars;
  return drums.flatMap((drum, i) =>
    hits[drum]
      .filter(([bar, step]) => bar + (step + 1) / 16 > view.start && bar + step / 16 < end)
      .map(([bar, step, velocity]) => (
        <rect
          key={`${drum} ${bar} ${step}`}
          x={x(bar + step / 16)}
          width={Math.max(1, sixteenth - 1)}
          y={top + i * h + 0.5}
          height={Math.max(1, h - 1)}
          fill="currentColor"
          fillOpacity={0.3 + 0.7 * velocity}
        />
      )),
  );
});

// the bass line as crate transcribed it, higher notes higher up the lane, which spans the notes in view (at least
// an octave)
const BassNotes = memo(function BassNotes({ notes, row, view, width }) {
  const x = toX(view, width);
  const sixteenth = width / view.bars / 16;
  const end = view.start + view.bars;
  const shown = notes.filter(([bar, step, length]) => bar + (step + length) / 16 > view.start && bar + step / 16 < end);
  if (!shown.length) {
    return null;
  }
  const midis = shown.map((note) => note[3]);
  const [low, high] = [Math.min(...midis), Math.max(...midis)];
  // semitones from the top of the lane to the bottom, the notes in the middle
  const span = Math.max(12, high - low + 1);
  const highest = high + Math.floor((span - (high - low + 1)) / 2);
  const h = (LANE - LANE_GAP) / span;
  const top = row * LANE + LANE_GAP / 2;
  return shown.map(([bar, step, length, midi]) => (
    <rect
      key={`${bar} ${step}`}
      x={x(bar + step / 16)}
      width={Math.max(1, length * sixteenth - 1)}
      y={top + (highest - midi) * h}
      height={Math.max(2, h - 0.5)}
      rx={1}
      fill="currentColor"
      fillOpacity={0.9}
    />
  ));
});

// the bar being listened to, moved every frame without re-rendering the lanes; onOutside(bar) when it leaves the view
function Playhead({ record, height, view, width, onOutside }) {
  const ref = useRef();
  const latest = useRef();
  latest.current = { view, width, onOutside };
  const current = useStore($audition);
  const playing = current?.name === record.name ? current : undefined;
  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame;
    const move = () => {
      const { view, width, onOutside } = latest.current;
      const bar = Math.min(record.bars, auditionPosition(playing));
      if (bar < view.start || bar > view.start + view.bars) {
        onOutside(bar);
      }
      const x = toX(view, width)(bar);
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
  return <line ref={ref} y1={0} y2={height} stroke="currentColor" strokeWidth={2} />;
}

// the whole record, small, with the part the map shows in a box: click or drag to move there
function Overview({ record, view, onMove }) {
  const grab = useRef();
  const height = 12;
  const barAt = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * record.bars;
  };
  return (
    <svg
      viewBox={`0 0 ${record.bars} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className="block mt-1 text-foreground cursor-grab active:cursor-grabbing select-none touch-none"
      aria-label="The whole record; click or drag to move the view"
      onPointerDown={(event) => {
        const bar = barAt(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        // the box moves with the pointer from where it was grabbed, or centres on a click beside it
        grab.current = bar >= view.start && bar <= view.start + view.bars ? bar - view.start : view.bars / 2;
        onMove(bar - grab.current);
      }}
      onPointerMove={(event) => grab.current !== undefined && onMove(barAt(event) - grab.current)}
      onPointerUp={() => (grab.current = undefined)}
    >
      <path
        d={lanePath(record.levels?.mix ?? [], 1, 0, record.bars, (bar) => bar, height / 2, height / 2, level)}
        fill="currentColor"
        fillOpacity={0.3}
      />
      <rect
        x={view.start}
        width={view.bars}
        y={0.5}
        height={height - 1}
        fill="currentColor"
        fillOpacity={0.12}
        stroke="currentColor"
        strokeOpacity={0.7}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
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
  const [view, setView] = useState(() => ({ start: 0, bars: record.bars }));
  const [outline, setOutline] = useState();
  const [drumHits, setDrumHits] = useState();
  const current = useStore($audition);
  const playing = current?.name === record.name ? current : undefined;
  const height = rows.length * LANE;
  const box = useRef();
  const map = useRef();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    loadOutline(record).then(
      (data) => active && setOutline(prepareOutline(data)),
      () => {}, // records made by an older crate have none until they are updated; the map shows bars meanwhile
    );
    return () => {
      active = false;
    };
  }, [record.name, record.created_at, record.format]);
  const drumsFound = record.drums?.created_at;
  useEffect(() => {
    if (!drumsFound) {
      return;
    }
    let active = true;
    loadDrums(record).then(
      (data) => active && setDrumHits(data.hits),
      (err) => logger(`[crate] ${err.message}`, 'error'),
    );
    return () => {
      active = false;
    };
  }, [record.name, drumsFound]);

  // the latest view, size and audition, for handlers that run between renders (wheel, animation frames)
  const live = useRef();
  live.current = { view, width, playing };
  // the view follows the playhead, unless it was moved away from it
  const follow = useRef(true);
  useEffect(() => {
    follow.current = true;
  }, [playing]);
  const moveView = (next) => {
    live.current.view = next;
    setView(next);
    if (live.current.playing) {
      const bar = auditionPosition(live.current.playing);
      follow.current = bar >= next.start && bar <= next.start + next.bars;
    }
  };
  const followPlayhead = (bar) => {
    if (follow.current) {
      const { bars } = live.current.view;
      moveView(clampView({ start: bar - bars / 20, bars }, record.bars));
    }
  };

  const cellAt = (clientX, clientY) => {
    const rect = map.current.getBoundingClientRect();
    const { view } = live.current;
    const position = view.start + ((clientX - rect.left) / rect.width) * view.bars;
    const bar = Math.max(0, Math.min(record.bars - 1, Math.floor(position)));
    const step = Math.max(0, Math.min(15, Math.floor((position - bar) * 16)));
    const row = Math.max(0, Math.min(rows.length - 1, Math.floor((clientY - rect.top) / LANE)));
    return { bar, step, stem: rows[row] };
  };

  // a pinch on the trackpad (or ctrl / cmd with the scroll wheel) zooms around the pointer, a sideways swipe (or
  // shift with the scroll wheel) moves along; scrolling up and down still scrolls the panel
  const onWheel = useRef();
  onWheel.current = (event) => {
    const { view, width } = live.current;
    if (!width) {
      return;
    }
    const rect = map.current.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const anchor = view.start + ((event.clientX - rect.left) / width) * view.bars;
      const factor = Math.exp(Math.max(-50, Math.min(50, event.deltaY)) / 100);
      moveView(zoomView(view, record.bars, factor, anchor));
    } else {
      const sideways = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      if (!isZoomed(view, record.bars) || Math.abs(sideways) <= (event.shiftKey ? 0 : Math.abs(event.deltaY))) {
        return;
      }
      event.preventDefault();
      moveView(panView(view, record.bars, (sideways / width) * view.bars));
    }
    if (event.clientY >= rect.top && event.clientY < rect.bottom) {
      setHover(cellAt(event.clientX, event.clientY));
    }
  };
  useEffect(() => {
    const element = box.current;
    const listener = (event) => onWheel.current(event);
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, []);

  // dragging a selection past either end of the map moves the view along, faster the further past
  const pointer = useRef();
  const edgeScroll = useRef();
  edgeScroll.current = (seconds) => {
    const rect = map.current?.getBoundingClientRect();
    const { view, width } = live.current;
    if (!pointer.current || !rect || !width || !isZoomed(view, record.bars)) {
      return;
    }
    const { x, y } = pointer.current;
    const over = x < rect.left ? x - rect.left : x > rect.right ? x - rect.right : 0;
    if (over) {
      moveView(panView(view, record.bars, (over / width) * view.bars * 6 * seconds));
      const { bar } = cellAt(x, y);
      setDrag((drag) => drag && { ...drag, end: bar });
    }
  };
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) {
      return;
    }
    let frame;
    let last = performance.now();
    const tick = (now) => {
      edgeScroll.current(Math.min(0.1, (now - last) / 1000));
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  const range = (a, b) => ({ from: Math.min(a, b), to: Math.max(a, b) + 1 });
  const onPointerDown = (event) => {
    const { bar, stem } = cellAt(event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { x: event.clientX, y: event.clientY };
    setDrag({ stem, start: bar, end: bar });
  };
  const onPointerMove = (event) => {
    pointer.current = { x: event.clientX, y: event.clientY };
    const cell = cellAt(event.clientX, event.clientY);
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
    const { bar } = cellAt(event.clientX, event.clientY);
    if (drag.start === bar) {
      setSelection(undefined);
      audition(record, drag.stem, bar);
    } else {
      setSelection({ stem: drag.stem, ...range(drag.start, bar) });
    }
    setDrag(undefined);
  };

  const x = toX(view, width);
  const pxPerBar = width / view.bars;
  const detail = pxPerBar >= DETAIL;
  const notes = record.notes?.bass?.length ? record.notes.bass : undefined;
  const dimmed = useMemo(
    () => (detail ? [drumHits && 'drums', notes && 'bass'].filter(Boolean) : []),
    [detail, drumHits, notes],
  );
  const shown = drag && drag.start !== drag.end ? { stem: drag.stem, ...range(drag.start, drag.end) } : selection;
  const ticks = [];
  if (width) {
    const step = rulerStep(pxPerBar);
    for (let bar = Math.ceil(view.start / step) * step; bar < view.start + view.bars; bar += step) {
      ticks.push(bar);
    }
  }

  let info;
  if (hover) {
    const at = hover.bar + (detail ? hover.step / 16 : 0);
    let here = '';
    if (detail && hover.stem === 'drums' && drumHits) {
      const hits = DRUMS.filter((drum) =>
        drumHits[drum]?.some(([bar, step]) => bar === hover.bar && step === hover.step),
      );
      here = hits.length ? `: ${hits.join(' ')}` : '';
    } else if (detail && hover.stem === 'bass' && notes) {
      const note = notes.find(
        ([bar, step, length]) => bar === hover.bar && step <= hover.step && hover.step < step + length,
      );
      here = note ? `: ${noteName(note[3], record.key)}` : '';
    }
    info = (
      <span title={STEM_HINTS[hover.stem]}>
        {hover.stem}, bar {hover.bar} at {minutes((record.first_downbeat ?? 0) + at * barDuration(record))}
        {here}
      </span>
    );
  } else if (playing) {
    info = `Listening to ${playing.stem} ${playing.loop ? `bars ${playing.from}–${playing.to - 1} on repeat` : `from bar ${playing.from}`}. Esc stops.`;
  } else if (shown) {
    info = <code>{barsCode(record, shown.stem, shown.from, shown.to).slice(3)}</code>;
  } else if (isZoomed(view, record.bars)) {
    info = 'Swipe sideways to move along. Pinch out to see the whole record.';
  } else {
    info = 'Click a bar to listen from there. Drag across bars to select them. Pinch to zoom in.';
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
            ref={map}
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            className="block text-foreground cursor-pointer select-none touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(undefined)}
          >
            <Grid view={view} width={width} height={height} />
            <Lanes record={record} rows={rows} outline={outline} view={view} width={width} dimmed={dimmed} />
            {detail && drumHits && rows.includes('drums') && (
              <DrumHits hits={drumHits} row={rows.indexOf('drums')} view={view} width={width} />
            )}
            {detail && notes && rows.includes('bass') && (
              <BassNotes notes={notes} row={rows.indexOf('bass')} view={view} width={width} />
            )}
            {hover && (
              <rect
                x={x(hover.bar)}
                width={pxPerBar}
                y={0}
                height={height}
                fill="currentColor"
                fillOpacity={detail ? 0.12 : 0.3}
              />
            )}
            {hover && detail && (
              <rect
                x={x(hover.bar + hover.step / 16)}
                width={pxPerBar / 16}
                y={rows.indexOf(hover.stem) * LANE}
                height={LANE}
                fill="currentColor"
                fillOpacity={0.25}
              />
            )}
            {shown && (
              <rect
                x={Math.round(x(shown.from)) + 0.5}
                width={Math.max(1, Math.round((shown.to - shown.from) * pxPerBar) - 1)}
                y={rows.indexOf(shown.stem) * LANE + 0.5}
                height={LANE - 1}
                fill="currentColor"
                fillOpacity={0.2}
                stroke="currentColor"
                strokeOpacity={0.9}
              />
            )}
            <Playhead record={record} height={height} view={view} width={width} onOutside={followPlayhead} />
          </svg>
          <div className="relative h-4 text-xs opacity-50 overflow-hidden">
            {ticks.map((bar) => (
              <span key={bar} className="absolute" style={{ left: x(bar) }}>
                {bar}
              </span>
            ))}
          </div>
          {isZoomed(view, record.bars) && (
            <Overview
              record={record}
              view={view}
              onMove={(start) => moveView(clampView({ start, bars: view.bars }, record.bars))}
            />
          )}
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
