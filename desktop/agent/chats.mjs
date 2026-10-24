// agent chats belong to a track; each chat stores the pi session header and entries
import { randomUUID } from 'node:crypto';
import { transaction } from '../db.mjs';

function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  return (content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

// the same message shapes the agent tab builds from live events
export function entriesToMessages(entries) {
  const messages = [];
  const tools = new Map();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const { message } = entry;
    if (message.role === 'user') {
      messages.push({ role: 'user', text: textOf(message.content) });
    } else if (message.role === 'assistant') {
      const text = textOf(message.content);
      if (text) {
        messages.push({ role: 'assistant', text, thinking: '', done: true });
      }
      for (const part of message.content ?? []) {
        if (part.type === 'toolCall') {
          const tool = { role: 'tool', id: part.id, name: part.name, args: part.arguments, done: true };
          tools.set(part.id, tool);
          messages.push(tool);
        }
      }
      if (message.stopReason === 'error' && message.errorMessage) {
        messages.push({ role: 'error', text: message.errorMessage });
      }
    } else if (message.role === 'toolResult') {
      const tool = tools.get(message.toolCallId);
      if (tool) {
        tool.result = textOf(message.content);
        tool.isError = message.isError;
      }
    }
  }
  return messages;
}

export function createChatStore(db) {
  const list = db.prepare(
    'select id, title, created_at, updated_at from chats where track_id is ? order by updated_at desc',
  );
  const insert = db.prepare('insert into chats (id, track_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)');
  const touch = db.prepare('update chats set updated_at = ? where id = ?');
  const remove = db.prepare('delete from chats where id = ?');
  const entries = db.prepare('select entry from chat_entries where chat_id = ? order by seq');
  const insertEntry = db.prepare(
    'insert or ignore into chat_entries (chat_id, entry_id, seq, entry) values (?, ?, ?, ?)',
  );

  return {
    list: (trackId) => list.all(trackId ?? null),
    latest: (trackId) => list.get(trackId ?? null),
    create(trackId, title) {
      const id = randomUUID();
      const now = Date.now();
      insert.run(id, trackId ?? null, title, now, now);
      return id;
    },
    remove: (id) => remove.run(id),
    load: (id) => entries.all(id).map((row) => JSON.parse(row.entry)),
    // entries are append only, so storing the ones not seen yet keeps the chat in sync
    sync(id, sessionManager) {
      const all = [sessionManager.getHeader(), ...sessionManager.getEntries()].filter(Boolean);
      transaction(db, () => {
        let added = 0;
        all.forEach((entry, seq) => {
          added += insertEntry.run(id, entry.id, seq, JSON.stringify(entry)).changes;
        });
        if (added) {
          touch.run(Date.now(), id);
        }
      });
    },
  };
}
