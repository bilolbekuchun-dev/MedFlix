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

  CREATE TABLE IF NOT EXISTS genres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS movie_genres (
    movie_id INTEGER NOT NULL,
    genre_id INTEGER NOT NULL,
    PRIMARY KEY (movie_id, genre_id),
    FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
    FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
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

export function searchMovies(query: string): Movie[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const pattern = `%${normalizedQuery}%`;
  const rows = database
    .prepare(
      `SELECT id, code, title, channel_chat_id, channel_message_id, created_at
       FROM movies
       WHERE code LIKE ? OR title LIKE ?
       ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END, title COLLATE NOCASE
       LIMIT 25`,
    )
    .all(pattern, pattern, normalizedQuery) as Record<string, unknown>[];

  return rows.map(mapMovie);
}

export function listGenres(): Array<{ name: string; movieCount: number }> {
  const rows = database
    .prepare(
      `SELECT genres.name, COUNT(movie_genres.movie_id) AS movie_count
       FROM genres
       LEFT JOIN movie_genres ON movie_genres.genre_id = genres.id
       GROUP BY genres.id
       ORDER BY genres.name COLLATE NOCASE`,
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    name: String(row.name),
    movieCount: Number(row.movie_count),
  }));
}

export function listMoviesByGenre(genreName: string): Movie[] {
  const rows = database
    .prepare(
      `SELECT movies.id, movies.code, movies.title,
              movies.channel_chat_id, movies.channel_message_id, movies.created_at
       FROM movies
       INNER JOIN movie_genres ON movie_genres.movie_id = movies.id
       INNER JOIN genres ON genres.id = movie_genres.genre_id
       WHERE genres.name = ?
       ORDER BY movies.title COLLATE NOCASE
       LIMIT 50`,
    )
    .all(genreName) as Record<string, unknown>[];

  return rows.map(mapMovie);
}

export function setMovieGenres(code: string, genreNames: string[]): boolean {
  const movie = findMovie(code);
  if (!movie) {
    return false;
  }

  database
    .prepare("DELETE FROM movie_genres WHERE movie_id = ?")
    .run(movie.id);

  const uniqueNames = [
    ...new Set(
      genreNames
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => name.slice(0, 80)),
    ),
  ];

  for (const genreName of uniqueNames) {
    database
      .prepare(
        `INSERT INTO genres (name) VALUES (?)
         ON CONFLICT(name) DO NOTHING`,
      )
      .run(genreName);

    const genre = database
      .prepare("SELECT id FROM genres WHERE name = ?")
      .get(genreName) as Record<string, unknown> | undefined;
    if (!genre) {
      continue;
    }

    database
      .prepare(
        `INSERT OR IGNORE INTO movie_genres (movie_id, genre_id)
         VALUES (?, ?)`,
      )
      .run(movie.id, Number(genre.id));
  }

  return true;
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