import { app, BrowserWindow, net, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// set by scripts/dev.mjs, otherwise the built website is served from website/dist
const devServerUrl = process.env.TOURBILLON_DEV_URL;
const distDir = path.resolve(__dirname, '../website/dist');
const appOrigin = 'app://tourbillon';

app.setName('Tourbillon');

// sound should start when evaluating via keyboard, without a prior click
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function serveDist() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    let filePath = path.join(distDir, decodeURIComponent(pathname));
    if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

// web midi for controllers and hardware synths, media for audio input
const allowedPermissions = new Set(['midi', 'midiSysex', 'media', 'clipboard-sanitized-write', 'fullscreen']);

function setPermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(allowedPermissions.has(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowedPermissions.has(permission));
}

function isAppUrl(url) {
  const origin = new URL(url).origin;
  return devServerUrl ? origin === new URL(devServerUrl).origin : origin === appOrigin;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Tourbillon',
    backgroundColor: '#222222',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // keep the window title instead of the page title
  win.on('page-title-updated', (event) => event.preventDefault());
  // links to other sites open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.loadURL(devServerUrl ?? `${appOrigin}/`);
}

app.whenReady().then(() => {
  if (!devServerUrl) {
    serveDist();
  }
  setPermissions();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
