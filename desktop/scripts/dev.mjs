// starts the astro dev server, then opens electron on it
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// a second instance needs another port, e.g. TOURBILLON_DEV_PORT=4400
const port = process.env.TOURBILLON_DEV_PORT ?? '4321';
const url = `http://localhost:${port}/`;

const isServing = () =>
  fetch(url).then(
    () => true,
    () => false,
  );
if (await isServing()) {
  console.error(`Port ${port} is already in use. Stop the other server or set TOURBILLON_DEV_PORT.`);
  process.exit(1);
}

// started directly, not through pnpm, so killing it stops the server
const websiteDir = path.resolve(desktopDir, '../website');
const astro = spawn(path.join(websiteDir, 'node_modules/.bin/astro'), ['dev', '--port', port], {
  cwd: websiteDir,
  stdio: 'inherit',
});

async function waitForServer() {
  for (;;) {
    if (await isServing()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

await waitForServer();

// extra args go to electron, e.g. --remote-debugging-port=9333
const electron = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: { ...process.env, TOURBILLON_DEV_URL: url },
});

electron.on('exit', (code) => {
  astro.kill();
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    electron.kill();
    astro.kill();
  });
}
