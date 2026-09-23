import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Movie = {
  id: number;
  code: string;
  title: string;
  channelChatId: string;
  channelMessageId: number;
  createdAt: string;
};

const dataDir = path.resolve(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

const database = new DatabaseSync(path.join(dataDir, "kino-bot.sqlite"));

database.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    channel_chat_id TEXT NOT NULL,
    channel_message_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function mapMovie(row: Record<string, unknown>): Movie {
  return {
    id: Number(row.id),
    code: String(row.code),
    title: String(row.title),
    channelChatId: String(row.channel_chat_id),
    channelMessageId: Number(row.channel_message_id),
    createdAt: String(row.created_at),
  };
}

export function findMovie(code: string): Movie | null {
  const row = database
    .prepare(
      `SELECT id, code, title, channel_chat_id, channel_message_id, created_at
       FROM movies WHERE code = ?`,
    )
    .get(code) as Record<string, unknown> | undefined;

  return row ? mapMovie(row) : null;
}

export function listMovies(): Movie[] {
  const rows = database
    .prepare(
      `SELECT id, code, title, channel_chat_id, channel_message_id, created_at
       FROM movies ORDER BY id DESC`,
    )
    .all() as Record<string, unknown>[];

  return rows.map(mapMovie);
}

export function upsertMovie(input: {
  code: string;
  title: string;
  channelChatId: string;
  channelMessageId: number;
}): Movie {
  database
    .prepare(
      `INSERT INTO movies (code, title, channel_chat_id, channel_message_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         title = excluded.title,
         channel_chat_id = excluded.channel_chat_id,
         channel_message_id = excluded.channel_message_id`,
    )
    .run(
      input.code,
      input.title,
      input.channelChatId,
      input.channelMessageId,
    );

  return findMovie(input.code) as Movie;
}

export function deleteMovie(code: string): boolean {
  const result = database.prepare("DELETE FROM movies WHERE code = ?").run(code);
  return result.changes > 0;
}

export function getSetting(key: string): string | null {
  const row = database
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as Record<string, unknown> | undefined;

  return row ? String(row.value) : null;
}

export function setSetting(key: string, value: string): void {
  database
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}