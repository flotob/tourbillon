// the crate: other producers' tracks ("records"), separated into stems and sliced into bars by the crate
// project (a python sister repo, github.com/flotob/tourbillon-crate). In strudel, bar n of a stem is sample n
// of the sound <record>_<stem>; the files are served to the renderer via crate://records/<record>/...
// A record can have versions at other tempos (<record>/tempo/<bpm>/), stretched without changing pitch, and drum
// patterns with a kit cut from it (<record>/drums/): its hits per 16th, and <record>_<drum> one-shots.
import { dialog, ipcMain, net, protocol } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const crateScheme = {
  scheme: 'crate',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

export const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'aif', 'aiff', 'm4a', 'aac', 'ogg', 'opus'];
const RECORD_NAME = /^[a-z][a-z0-9]*$/;
// the record.json layout this app expects; older records are updated with `crate analyze`
const FORMAT = 2;
// how far a version's tempo may be from the record's, as crate allows
const MAX_RATIO = 1.5;
// what the renderer and the agent get; beats and the source path stay on disk
const SUMMARY_FIELDS = [
  'format',
  'name',
  'title',
  'artist',
  'bpm',
  'key',
  'camelot',
  'key_strength',
  'bars',
  'duration',
  'stems',
  'levels',
  'playing',
  'created_at',
];

// tempos of a record's finished versions; versions being made are in .<bpm>.partial
function readVersions(folder) {
  try {
    return fs
      .readdirSync(path.join(folder, 'tempo'))
      .filter((name) => !name.startsWith('.'))
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// the drums found in a record: when, and how many hits of each (bd, sd, hh, perc, cr); the hits themselves stay
// in drums.json, which the renderer fetches when it writes code
function readDrums(folder) {
  try {
    const drums = JSON.parse(fs.readFileSync(path.join(folder, 'drums', 'drums.json'), 'utf8'));
    return {
      created_at: drums.created_at,
      hits: Object.fromEntries(Object.entries(drums.drums).map(([drum, { hits }]) => [drum, hits])),
    };
  } catch {
    return undefined;
  }
}

// partial folders are left behind by jobs that were running when the app quit
function removePartials(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') && name.endsWith('.partial')) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

// the crate repo next to this one, as cloned by hand
function findProject(repoDir) {
  const candidates = [
    process.env.TOURBILLON_CRATE_PROJECT,
    path.resolve(repoDir, '../crate'),
    path.resolve(repoDir, '../tourbillon-crate'),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'src/crate/record.py')));
}

// apps started from the dock don't get the shell's PATH
const searchPath = [
  ...(process.env.PATH ?? '').split(path.delimiter),
  path.join(os.homedir(), '.local/bin'),
  path.join(os.homedir(), '.cargo/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
].filter(Boolean);

function findUv() {
  return searchPath.map((dir) => path.join(dir, 'uv')).find((file) => fs.existsSync(file));
}

export function readRecords(crateDir) {
  let names;
  try {
    // imports in progress write to .<name>.partial
    names = fs.readdirSync(crateDir).filter((name) => !name.startsWith('.'));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(crateDir, name, 'record.json'), 'utf8'));
        const summary = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, meta[field]]));
        const first_downbeat = meta.grid?.first_downbeat ?? 0;
        const folder = path.join(crateDir, name);
        return [{ ...summary, first_downbeat, versions: readVersions(folder), drums: readDrums(folder) }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.created_at - a.created_at);
}

export function setupCrate({ getWindow, repoDir, crateDir }) {
  fs.mkdirSync(crateDir, { recursive: true });
  removePartials(crateDir);
  for (const record of readRecords(crateDir)) {
    removePartials(path.join(crateDir, record.name));
    if (fs.existsSync(path.join(crateDir, record.name, 'tempo'))) {
      removePartials(path.join(crateDir, record.name, 'tempo'));
    }
  }
  const project = findProject(repoDir);
  const uv = findUv();
  const problem = !project
    ? 'The crate project was not found. Clone github.com/flotob/tourbillon-crate next to Tourbillon as "crate".'
    : !uv
      ? 'uv was not found. Install it from https://docs.astral.sh/uv/ to import tracks.'
      : undefined;

  const send = (event) => getWindow()?.webContents.send('crate:event', event);
  const fromWindow = (event) => event.sender === getWindow()?.webContents;
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromWindow(event)) {
        throw new Error('not allowed');
      }
      return fn(...args);
    });

  protocol.handle(crateScheme.scheme, async (request) => {
    const filePath = path.join(crateDir, decodeURIComponent(new URL(request.url).pathname));
    if (!filePath.startsWith(crateDir + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    let response;
    try {
      response = await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('not found', { status: 404 });
    }
    // the renderer runs on another origin (app:// or the dev server)
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, { status: response.status, headers });
  });

  // jobs run one at a time, each a `crate <command> --json` process: imports (add), versions at another tempo
  // (tempo), drum patterns (drums) and updates of records made by an older crate (analyze)
  const jobs = [];
  let nextJobId = 0;
  let running;

  // what the renderer sees of a job, without the process
  const publicJob = ({ id, kind, file, title, state, step, fraction, name, bpm, existing, error }) => ({
    id,
    kind,
    file,
    title,
    state,
    step,
    fraction,
    name,
    bpm,
    existing,
    error,
  });
  const sendJobs = () => send({ type: 'jobs', jobs: jobs.map(publicJob) });
  const sendRecords = () => send({ type: 'records', records: readRecords(crateDir) });
  // the process group: uv, python and the rubberband processes it starts
  const kill = (job) => {
    try {
      process.kill(-job.child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  };

  function run(job) {
    job.state = 'running';
    job.step = 'starting';
    const child = spawn(uv, ['run', '--project', project, 'crate', '--crate', crateDir, ...job.args, '--json'], {
      env: { ...process.env, PATH: searchPath.join(path.delimiter) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    running = job;
    job.child = child;
    job.stderr = [];
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      // the first run installs the python environment, which takes a while
      if (/^(Downloading|Installed|Prepared|Building)/.test(line) && job.step === 'starting') {
        job.step = 'installing';
        sendJobs();
      }
      job.stderr = [...job.stderr.slice(-30), line];
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event === 'started') {
        job.name = event.name;
        job.partial = path.join(crateDir, `.${event.name}.partial`);
      } else if (event.event === 'progress') {
        job.step = event.step;
        job.fraction = event.fraction;
      } else if (event.event === 'done') {
        Object.assign(job, { state: 'done', existing: event.existing });
        job.name ??= event.name;
      } else if (event.event === 'error') {
        job.error = event.message;
      }
      sendJobs();
    });
    child.on('error', (err) => {
      job.error = err.message;
    });
    child.on('close', () => {
      running = undefined;
      if (job.cancelled) {
        job.state = 'cancelled';
        if (job.partial) {
          fs.rmSync(job.partial, { recursive: true, force: true });
        }
      } else if (job.state !== 'done') {
        job.state = 'error';
        job.error ??= job.stderr.filter(Boolean).slice(-3).join('\n') || 'it stopped';
      }
      sendJobs();
      if (job.state === 'done' && !job.existing) {
        sendRecords();
      }
      runNext();
    });
    sendJobs();
  }

  function runNext() {
    const job = jobs.find((job) => job.state === 'queued');
    if (job && !running) {
      run(job);
    }
  }

  function enqueue(fields) {
    if (problem) {
      throw new Error(problem);
    }
    const job = { id: ++nextJobId, state: 'queued', ...fields };
    jobs.push(job);
    sendJobs();
    runNext();
    return job;
  }

  function importFiles(files) {
    for (const file of files) {
      const extension = path.extname(file).slice(1).toLowerCase();
      if (AUDIO_EXTENSIONS.includes(extension) && fs.existsSync(file)) {
        enqueue({ kind: 'add', args: ['add', file], file, title: path.basename(file) });
      }
    }
  }

  const findRecord = (name) => {
    const record = RECORD_NAME.test(name) && readRecords(crateDir).find((r) => r.name === name);
    if (!record) {
      throw new Error(`no record named ${name}`);
    }
    return record;
  };
  const sameTempo = (a, b) => Math.abs(a - b) < 0.005;

  // a version of a record at bpm, made unless it exists or is on its way
  function makeVersion(name, bpm) {
    const record = findRecord(name);
    bpm = Math.round(bpm * 100) / 100;
    if (!Number.isFinite(bpm) || bpm * MAX_RATIO < record.bpm || bpm > record.bpm * MAX_RATIO) {
      throw new Error(
        `${name} is ${+record.bpm.toFixed(2)} bpm; versions can be made from ${Math.ceil(record.bpm / MAX_RATIO)} to ${Math.floor(record.bpm * MAX_RATIO)} bpm`,
      );
    }
    if (sameTempo(bpm, record.bpm)) {
      return { state: 'original', bpm };
    }
    if (record.versions.some((version) => sameTempo(version, bpm))) {
      return { state: 'exists', bpm };
    }
    const pending = jobs.find(
      (job) =>
        job.kind === 'tempo' &&
        job.name === name &&
        sameTempo(job.bpm, bpm) &&
        ['queued', 'running'].includes(job.state),
    );
    const job =
      pending ??
      enqueue({
        kind: 'tempo',
        args: ['tempo', name, String(bpm)],
        name,
        bpm,
        title: `${name} at ${bpm} bpm`,
        partial: path.join(crateDir, name, 'tempo', `.${bpm}.partial`),
      });
    return { state: job.state, bpm };
  }

  // a record's drum patterns and kit, found unless they exist or are on their way; the first time, crate
  // installs ADTOF (about 1.5 GB) into its own environment
  function findDrums(name) {
    const record = findRecord(name);
    if (record.drums) {
      return { state: 'exists' };
    }
    const pending = jobs.find(
      (job) => job.kind === 'drums' && job.name === name && ['queued', 'running'].includes(job.state),
    );
    const job =
      pending ??
      enqueue({
        kind: 'drums',
        args: ['drums', name],
        name,
        title: `${name} drums`,
        partial: path.join(crateDir, name, '.drums.partial'),
      });
    return { state: job.state };
  }

  function deleteVersion(name, bpm) {
    const record = findRecord(name);
    const version = record.versions.find((version) => sameTempo(version, bpm));
    if (version === undefined) {
      throw new Error(`${name} has no version at ${bpm} bpm`);
    }
    fs.rmSync(path.join(crateDir, name, 'tempo', String(version)), { recursive: true, force: true });
    sendRecords();
  }

  // records from an older crate get the newer analysis, e.g. their key
  const outdated = readRecords(crateDir).filter((record) => (record.format ?? 1) < FORMAT);
  if (outdated.length && !problem) {
    const names = outdated.map((record) => record.name);
    enqueue({ kind: 'analyze', args: ['analyze', ...names], title: `updating ${names.join(', ')}` });
  }

  handle('crate:status', () => ({ problem, crateDir, extensions: AUDIO_EXTENSIONS }));
  handle('crate:records', () => readRecords(crateDir));
  handle('crate:jobs', () => jobs.map(publicJob));
  handle('crate:import', (files) => importFiles(files));
  handle('crate:pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
      title: 'Import into the crate',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (!canceled) {
      importFiles(filePaths);
    }
  });
  handle('crate:cancel', (id) => {
    const job = jobs.find((job) => job.id === id);
    if (job?.state === 'queued') {
      job.state = 'cancelled';
      sendJobs();
    } else if (job?.state === 'running') {
      job.cancelled = true;
      kill(job);
    }
  });
  // finished, failed and cancelled imports leave the list
  handle('crate:clear-jobs', () => {
    jobs.splice(0, jobs.length, ...jobs.filter((job) => job.state === 'queued' || job.state === 'running'));
    sendJobs();
  });
  handle('crate:delete', (name) => {
    findRecord(name);
    // its versions and drums being made go with it
    for (const job of jobs.filter((job) => job.name === name && job.kind !== 'add')) {
      if (job.state === 'queued') {
        job.state = 'cancelled';
      } else if (job.state === 'running') {
        job.cancelled = true;
        kill(job);
      }
    }
    fs.rmSync(path.join(crateDir, name), { recursive: true, force: true });
    sendJobs();
    sendRecords();
  });
  handle('crate:make-version', (name, bpm) => makeVersion(name, bpm));
  handle('crate:delete-version', (name, bpm) => deleteVersion(name, bpm));
  handle('crate:find-drums', (name) => findDrums(name));

  return {
    records: () => readRecords(crateDir),
    makeVersion,
    findDrums,
    // a job in progress is killed with the app; its partial folder is removed on the next start
    stop: () => running && kill(running),
  };
}
