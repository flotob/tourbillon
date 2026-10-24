// app data in one sqlite file: tracks, the versions that were evaluated, agent chats
import { DatabaseSync } from 'node:sqlite';

// append only: each entry migrates the schema one version up (pragma user_version)
const migrations = [
  `
  create table tracks (
    id text primary key,
    title text not null default '',
    code text not null default '',
    created_at integer not null,
    updated_at integer not null
  );
  create table track_versions (
    id integer primary key,
    track_id text not null references tracks(id) on delete cascade,
    code text not null,
    created_at integer not null
  );
  create index track_versions_by_track on track_versions(track_id, id);
  create table chats (
    id text primary key,
    track_id text references tracks(id) on delete cascade,
    title text not null default '',
    created_at integer not null,
    updated_at integer not null
  );
  create index chats_by_track on chats(track_id, updated_at);
  -- pi session header and entries, in append order
  create table chat_entries (
    chat_id text not null references chats(id) on delete cascade,
    entry_id text not null,
    seq integer not null,
    entry text not null,
    primary key (chat_id, entry_id)
  );
  create table app_state (
    key text primary key,
    value text
  );
  `,
];

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
  const { user_version: version } = db.prepare('pragma user_version').get();
  for (let next = version; next < migrations.length; next++) {
    transaction(db, () => {
      db.exec(migrations[next]);
      db.exec(`pragma user_version = ${next + 1}`);
    });
  }
  return db;
}

export function transaction(db, fn) {
  db.exec('begin');
  try {
    const result = fn();
    db.exec('commit');
    return result;
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

export function getState(db, key) {
  return db.prepare('select value from app_state where key = ?').get(key)?.value;
}

export function setState(db, key, value) {
  db.prepare(
    'insert into app_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
  ).run(key, value);
}
