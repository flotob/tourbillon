// the crate: other producers' tracks ("records"), separated into stems and sliced into bars by the crate
// project (a python sister repo, github.com/flotob/tourbillon-crate). In strudel, bar n of a stem is sample n
// of the sound <record>_<stem>; the files are served to the renderer via crate://records/<record>/...
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
// what the renderer and the agent get; beats and the source path stay on disk
const SUMMARY_FIELDS = [
  'name',
  'title',
  'artist',
  'bpm',
  'bars',
  'duration',
  'stems',
  'levels',
  'playing',
  'created_at',
];

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
        return [Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, meta[field]]))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.created_at - a.created_at);
}

export function setupCrate({ getWindow, repoDir, crateDir }) {
  fs.mkdirSync(crateDir, { recursive: true });
  // left behind by imports that were running when the app quit
  for (const name of fs.readdirSync(crateDir)) {
    if (name.startsWith('.') && name.endsWith('.partial')) {
      fs.rmSync(path.join(crateDir, name), { recursive: true, force: true });
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

  // imports run one at a time; each is a `crate add --json` process
  const jobs = [];
  let nextJobId = 0;
  let running;

  // what the renderer sees of a job, without the process
  const publicJob = ({ id, file, title, state, step, fraction, name, existing, error }) => ({
    id,
    file,
    title,
    state,
    step,
    fraction,
    name,
    existing,
    error,
  });
  const sendJobs = () => send({ type: 'jobs', jobs: jobs.map(publicJob) });

  function run(job) {
    job.state = 'running';
    job.step = 'starting';
    const child = spawn(uv, ['run', '--project', project, 'crate', '--crate', crateDir, 'add', job.file, '--json'], {
      env: { ...process.env, PATH: searchPath.join(path.delimiter) },
      stdio: ['ignore', 'pipe', 'pipe'],
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
      } else if (event.event === 'progress') {
        job.step = event.step;
        job.fraction = event.fraction;
      } else if (event.event === 'done') {
        Object.assign(job, { state: 'done', name: event.name, existing: event.existing });
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
        if (job.name) {
          fs.rmSync(path.join(crateDir, `.${job.name}.partial`), { recursive: true, force: true });
        }
      } else if (job.state !== 'done') {
        job.state = 'error';
        job.error ??= job.stderr.filter(Boolean).slice(-3).join('\n') || 'the import stopped';
      }
      sendJobs();
      if (job.state === 'done' && !job.existing) {
        send({ type: 'records', records: readRecords(crateDir) });
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

  function enqueue(files) {
    if (problem) {
      throw new Error(problem);
    }
    for (const file of files) {
      const extension = path.extname(file).slice(1).toLowerCase();
      if (!AUDIO_EXTENSIONS.includes(extension) || !fs.existsSync(file)) {
        continue;
      }
      jobs.push({ id: ++nextJobId, file, title: path.basename(file), state: 'queued' });
    }
    sendJobs();
    runNext();
  }

  handle('crate:status', () => ({ problem, crateDir, extensions: AUDIO_EXTENSIONS }));
  handle('crate:records', () => readRecords(crateDir));
  handle('crate:jobs', () => jobs.map(publicJob));
  handle('crate:import', (files) => enqueue(files));
  handle('crate:pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
      title: 'Import into the crate',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (!canceled) {
      enqueue(filePaths);
    }
  });
  handle('crate:cancel', (id) => {
    const job = jobs.find((job) => job.id === id);
    if (job?.state === 'queued') {
      job.state = 'cancelled';
      sendJobs();
    } else if (job?.state === 'running') {
      job.cancelled = true;
      job.child.kill('SIGTERM');
    }
  });
  // finished, failed and cancelled imports leave the list
  handle('crate:clear-jobs', () => {
    jobs.splice(0, jobs.length, ...jobs.filter((job) => job.state === 'queued' || job.state === 'running'));
    sendJobs();
  });
  handle('crate:delete', (name) => {
    if (!RECORD_NAME.test(name) || !fs.existsSync(path.join(crateDir, name, 'record.json'))) {
      throw new Error(`no record named ${name}`);
    }
    fs.rmSync(path.join(crateDir, name), { recursive: true, force: true });
    send({ type: 'records', records: readRecords(crateDir) });
  });

  return {
    records: () => readRecords(crateDir),
    // an import in progress is killed with the app; its partial folder is removed on the next start
    stop: () => running?.child.kill('SIGTERM'),
  };
}
