// tracks are the code pages; every evaluation of a track is kept as a version
import { ipcMain } from 'electron';
import { getState, setState, transaction } from './db.mjs';

const MAX_VERSIONS_LISTED = 500;

export function setupTracks({ db, getWindow }) {
  const fromWindow = (event) => event.sender === getWindow()?.webContents;
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromWindow(event)) {
        throw new Error('not allowed');
      }
      return fn(...args);
    });

  const list = db.prepare('select id, title, created_at, updated_at from tracks order by updated_at desc');
  const get = db.prepare('select * from tracks where id = ?');
  const insert = db.prepare(
    'insert into tracks (id, title, code, created_at, updated_at) values (:id, :title, :code, :now, :now)',
  );
  const updateCode = db.prepare('update tracks set code = ?, updated_at = ? where id = ? and code != ?');
  const rename = db.prepare('update tracks set title = ?, updated_at = ? where id = ?');
  const remove = db.prepare('delete from tracks where id = ?');
  const latestVersion = db.prepare('select code from track_versions where track_id = ? order by id desc limit 1');
  const insertVersion = db.prepare('insert into track_versions (track_id, code, created_at) values (?, ?, ?)');
  const versions = db.prepare(
    `select id, code, created_at from track_versions where track_id = ? order by id desc limit ${MAX_VERSIONS_LISTED}`,
  );

  handle('tracks:list', () => list.all());
  handle('tracks:get', (id) => get.get(id));
  handle('tracks:create', ({ id, title = '', code = '' }) => {
    insert.run({ id, title, code, now: Date.now() });
    return get.get(id);
  });
  // returns true when the code changed
  handle('tracks:save', (id, code) => updateCode.run(code, Date.now(), id, code).changes > 0);
  handle('tracks:rename', (id, title) => {
    rename.run(title, Date.now(), id);
  });
  handle('tracks:delete', (id) => {
    remove.run(id);
  });
  // called on evaluate: the track keeps the code, and a version is added unless it equals the last one
  handle('tracks:evaluated', (id, code) =>
    transaction(db, () => {
      const now = Date.now();
      updateCode.run(code, now, id, code);
      if (latestVersion.get(id)?.code === code) {
        return false;
      }
      insertVersion.run(id, code, now);
      return true;
    }),
  );
  handle('tracks:versions', (id) => versions.all(id));
  handle('tracks:get-last', () => getState(db, 'lastTrackId'));
  handle('tracks:set-last', (id) => setState(db, 'lastTrackId', id));
}
