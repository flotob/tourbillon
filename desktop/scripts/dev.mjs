// starts the astro dev server, then opens electron on it
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = 'http://localhost:4321/';

const astro = spawn('pnpm', ['--filter', '@strudel/website', 'start'], { stdio: 'inherit' });

async function waitForServer() {
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
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
process.on('SIGINT', () => {
  electron.kill();
  astro.kill();
});
