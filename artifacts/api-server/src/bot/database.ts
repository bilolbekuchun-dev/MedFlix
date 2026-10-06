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

export type MoviePost = {
  id: number;
  movieId: number;
  postNumber: number;
  title: string;
  channelChatId: string;
  channelMessageId: number;
  createdAt: string;
};

export type Series = {
  id: number;
  code: string;
  title: string;
  episodeCount: number;
  seasonCount: number;
  createdAt: string;
};

export type SeriesEpisode = {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
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
  PRAGMA foreign_keys = ON;

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

  CREATE TABLE IF NOT EXISTS movie_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movie_id INTEGER NOT NULL,
    post_number INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_chat_id TEXT NOT NULL,
    channel_message_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (movie_id, post_number),
    FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS series_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    season_number INTEGER NOT NULL DEFAULT 1,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_chat_id TEXT NOT NULL,
    channel_message_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (series_id, season_number, episode_number),
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS series_last_delivery (
    chat_id INTEGER NOT NULL,
    series_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, series_id),
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
  );
`);

database.exec(`
  INSERT INTO movie_posts
    (movie_id, post_number, title, channel_chat_id, channel_message_id, created_at)
  SELECT movies.id, 1, movies.title, movies.channel_chat_id,
         movies.channel_message_id, movies.created_at
  FROM movies
  WHERE NOT EXISTS (
    SELECT 1
    FROM movie_posts
    WHERE movie_posts.movie_id = movies.id AND movie_posts.post_number = 1
  );
`);

const seriesEpisodeColumns = database
  .prepare("PRAGMA table_info(series_episodes)")
  .all() as Array<Record<string, unknown>>;

if (!seriesEpisodeColumns.some((column) => column.name === "season_number")) {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE series_episodes_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL DEFAULT 1,
      episode_number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      channel_chat_id TEXT NOT NULL,
      channel_message_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (series_id, season_number, episode_number),
      FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
    );
    INSERT INTO series_episodes_migrated
      (id, series_id, season_number, episode_number, title,
       channel_chat_id, channel_message_id, created_at)
    SELECT id, series_id, 1, episode_number, title,
           channel_chat_id, channel_message_id, created_at
    FROM series_episodes;
    DROP TABLE series_episodes;
    ALTER TABLE series_episodes_migrated RENAME TO series_episodes;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

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

function mapSeries(row: Record<string, unknown>): Series {
  return {
    id: Number(row.id),
    code: String(row.code),
    title: String(row.title),
    episodeCount: Number(row.episode_count ?? 0),
    seasonCount: Number(row.season_count ?? 0),
    createdAt: String(row.created_at),
  };
}

function mapSeriesEpisode(row: Record<string, unknown>): SeriesEpisode {
  return {
    id: Number(row.id),
    seriesId: Number(row.series_id),
    seasonNumber: Number(row.season_number),
    episodeNumber: Number(row.episode_number),
    title: String(row.title ?? ""),
    channelChatId: String(row.channel_chat_id),
    channelMessageId: Number(row.channel_message_id),
    createdAt: String(row.created_at),
  };
}

function mapMoviePost(row: Record<string, unknown>): MoviePost {
  return {
    id: Number(row.id),
    movieId: Number(row.movie_id),
    postNumber: Number(row.post_number),
    title: String(row.title ?? ""),
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

export function listMoviePosts(movieCode: string): MoviePost[] {
  const rows = database
    .prepare(
      `SELECT movie_posts.id, movie_posts.movie_id, movie_posts.post_number,
              movie_posts.title, movie_posts.channel_chat_id,
              movie_posts.channel_message_id, movie_posts.created_at
       FROM movie_posts
       INNER JOIN movies ON movies.id = movie_posts.movie_id
       WHERE movies.code = ?
       ORDER BY movie_posts.post_number`,
    )
    .all(movieCode) as Record<string, unknown>[];

  return rows.map(mapMoviePost);
}

export function findSeries(code: string): Series | null {
  const row = database
    .prepare(
      `SELECT series.id, series.code, series.title, series.created_at,
              COUNT(series_episodes.id) AS episode_count,
              COUNT(DISTINCT series_episodes.season_number) AS season_count
       FROM series
       LEFT JOIN series_episodes ON series_episodes.series_id = series.id
       WHERE series.code = ?
       GROUP BY series.id`,
    )
    .get(code) as Record<string, unknown> | undefined;

  return row ? mapSeries(row) : null;
}

export function searchSeries(query: string): Series[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const pattern = `%${normalizedQuery}%`;
  const rows = database
    .prepare(
      `SELECT series.id, series.code, series.title, series.created_at,
              COUNT(series_episodes.id) AS episode_count,
              COUNT(DISTINCT series_episodes.season_number) AS season_count
       FROM series
       LEFT JOIN series_episodes ON series_episodes.series_id = series.id
       WHERE series.code LIKE ? OR series.title LIKE ?
       GROUP BY series.id
       ORDER BY CASE WHEN series.code = ? THEN 0 ELSE 1 END,
                series.title COLLATE NOCASE
       LIMIT 25`,
    )
    .all(pattern, pattern, normalizedQuery) as Record<string, unknown>[];

  return rows.map(mapSeries);
}

export function listSeries(): Series[] {
  const rows = database
    .prepare(
      `SELECT series.id, series.code, series.title, series.created_at,
              COUNT(series_episodes.id) AS episode_count,
              COUNT(DISTINCT series_episodes.season_number) AS season_count
       FROM series
       LEFT JOIN series_episodes ON series_episodes.series_id = series.id
       GROUP BY series.id
       ORDER BY series.id DESC`,
    )
    .all() as Record<string, unknown>[];

  return rows.map(mapSeries);
}

export function upsertSeries(input: { code: string; title: string }): Series {
  database
    .prepare(
      `INSERT INTO series (code, title) VALUES (?, ?)
       ON CONFLICT(code) DO UPDATE SET title = excluded.title`,
    )
    .run(input.code, input.title);

  return findSeries(input.code) as Series;
}

export function listSeriesSeasons(seriesCode: string): number[] {
  const rows = database
    .prepare(
      `SELECT DISTINCT series_episodes.season_number
       FROM series_episodes
       INNER JOIN series ON series.id = series_episodes.series_id
       WHERE series.code = ?
       ORDER BY series_episodes.season_number`,
    )
    .all(seriesCode) as Record<string, unknown>[];

  return rows.map((row) => Number(row.season_number));
}

export function listSeriesEpisodes(
  seriesCode: string,
  seasonNumber?: number,
): SeriesEpisode[] {
  const query = seasonNumber
    ? `SELECT series_episodes.id, series_episodes.series_id,
              series_episodes.season_number, series_episodes.episode_number,
              series_episodes.title, series_episodes.channel_chat_id,
              series_episodes.channel_message_id, series_episodes.created_at
       FROM series_episodes
       INNER JOIN series ON series.id = series_episodes.series_id
       WHERE series.code = ? AND series_episodes.season_number = ?
       ORDER BY series_episodes.episode_number`
    : `SELECT series_episodes.id, series_episodes.series_id,
              series_episodes.season_number, series_episodes.episode_number,
              series_episodes.title, series_episodes.channel_chat_id,
              series_episodes.channel_message_id, series_episodes.created_at
       FROM series_episodes
       INNER JOIN series ON series.id = series_episodes.series_id
       WHERE series.code = ?
       ORDER BY series_episodes.season_number, series_episodes.episode_number`;
  const rows = database.prepare(query).all(
    ...(seasonNumber ? [seriesCode, seasonNumber] : [seriesCode]),
  ) as Record<string, unknown>[];

  return rows.map(mapSeriesEpisode);
}

export function findSeriesEpisode(
  seriesCode: string,
  seasonNumber: number,
  episodeNumber: number,
): SeriesEpisode | null {
  const row = database
    .prepare(
      `SELECT series_episodes.id, series_episodes.series_id,
              series_episodes.season_number, series_episodes.episode_number,
              series_episodes.title,
              series_episodes.channel_chat_id,
              series_episodes.channel_message_id,
              series_episodes.created_at
       FROM series_episodes
       INNER JOIN series ON series.id = series_episodes.series_id
       WHERE series.code = ? AND series_episodes.season_number = ?
         AND series_episodes.episode_number = ?`,
    )
    .get(seriesCode, seasonNumber, episodeNumber) as
    | Record<string, unknown>
    | undefined;

  return row ? mapSeriesEpisode(row) : null;
}

export function upsertSeriesEpisode(input: {
  seriesCode: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  channelChatId: string;
  channelMessageId: number;
}): SeriesEpisode | null {
  const series = findSeries(input.seriesCode);
  if (!series) {
    return null;
  }

  database
    .prepare(
      `INSERT INTO series_episodes
         (series_id, season_number, episode_number, title,
          channel_chat_id, channel_message_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id, season_number, episode_number) DO UPDATE SET
         title = excluded.title,
         channel_chat_id = excluded.channel_chat_id,
         channel_message_id = excluded.channel_message_id`,
    )
    .run(
      series.id,
      input.seasonNumber,
      input.episodeNumber,
      input.title,
      input.channelChatId,
      input.channelMessageId,
    );

  return findSeriesEpisode(
    input.seriesCode,
    input.seasonNumber,
    input.episodeNumber,
  );
}

export function deleteSeries(code: string): boolean {
  const result = database.prepare("DELETE FROM series WHERE code = ?").run(code);
  return result.changes > 0;
}

export function deleteSeriesEpisode(
  seriesCode: string,
  seasonNumber: number,
  episodeNumber: number,
): boolean {
  const result = database
    .prepare(
      `DELETE FROM series_episodes
       WHERE series_id = (SELECT id FROM series WHERE code = ?)
         AND season_number = ?
         AND episode_number = ?`,
    )
    .run(seriesCode, seasonNumber, episodeNumber);
  return result.changes > 0;
}

export function getLastDeliveredEpisodeMessage(
  chatId: number,
  seriesCode: string,
): number | null {
  const row = database
    .prepare(
      `SELECT series_last_delivery.message_id
       FROM series_last_delivery
       INNER JOIN series ON series.id = series_last_delivery.series_id
       WHERE series_last_delivery.chat_id = ? AND series.code = ?`,
    )
    .get(chatId, seriesCode) as Record<string, unknown> | undefined;

  return row ? Number(row.message_id) : null;
}

export function setLastDeliveredEpisodeMessage(
  chatId: number,
  seriesCode: string,
  messageId: number,
): void {
  const series = database
    .prepare("SELECT id FROM series WHERE code = ?")
    .get(seriesCode) as Record<string, unknown> | undefined;
  if (!series) {
    return;
  }

  database
    .prepare(
      `INSERT INTO series_last_delivery (chat_id, series_id, message_id)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id, series_id) DO UPDATE SET
         message_id = excluded.message_id,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(chatId, Number(series.id), messageId);
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

  const movie = findMovie(input.code) as Movie;
  database
    .prepare(
      `INSERT INTO movie_posts
         (movie_id, post_number, title, channel_chat_id, channel_message_id)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(movie_id, post_number) DO UPDATE SET
         title = excluded.title,
         channel_chat_id = excluded.channel_chat_id,
         channel_message_id = excluded.channel_message_id`,
    )
    .run(
      movie.id,
      input.title,
      input.channelChatId,
      input.channelMessageId,
    );

  return movie;
}

export function upsertMoviePost(input: {
  movieCode: string;
  postNumber: number;
  title: string;
  channelChatId: string;
  channelMessageId: number;
}): MoviePost | null {
  const movie = findMovie(input.movieCode);
  if (!movie) {
    return null;
  }

  database
    .prepare(
      `INSERT INTO movie_posts
         (movie_id, post_number, title, channel_chat_id, channel_message_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(movie_id, post_number) DO UPDATE SET
         title = excluded.title,
         channel_chat_id = excluded.channel_chat_id,
         channel_message_id = excluded.channel_message_id`,
    )
    .run(
      movie.id,
      input.postNumber,
      input.title,
      input.channelChatId,
      input.channelMessageId,
    );

  return (
    listMoviePosts(input.movieCode).find(
      (post) => post.postNumber === input.postNumber,
    ) ?? null
  );
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