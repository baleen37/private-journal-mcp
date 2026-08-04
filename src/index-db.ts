import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { JOURNAL_SECTIONS, JournalSection, RecentEntry, SearchResult } from './types';

export const INDEX_FILE_NAME = '.private-journal-index.sqlite';
export const EMBEDDING_DIMENSION = 384;
export const CURRENT_INDEX_SCHEMA_REVISION = 1;
export const INDEX_EMBEDDING_REVISION = 'Xenova/multilingual-e5-small:384:v1';

export interface IndexedEntry {
  path: string;
  title: string;
  date: string;
  timestamp: number;
  sections: string[];
  excerpt: string;
  sourceMtime: number;
  embeddingVersion: string;
  embedding: number[];
}

export interface IndexSearchOptions {
  limit: number;
  sections?: string[];
  minScore?: number;
}

interface SqliteEntryRow {
  id: number;
  path: string;
  title: string;
  date: string;
  timestamp: number;
  sections: string;
  excerpt: string;
  source_mtime: number;
  embedding_version: string;
}

interface SqliteRecentRow {
  path: string;
  title: string;
  date: string;
  timestamp: number;
  sections: string;
}

interface SqliteStateRow {
  source_mtime: number;
  embedding_version: string;
}

interface SqliteSearchRow extends SqliteEntryRow {
  score: number;
}

function sectionMask(sections: string[]): number {
  return sections.reduce((mask, section) => {
    const index = JOURNAL_SECTIONS.indexOf(section as JournalSection);
    return index >= 0 ? mask | (1 << index) : mask;
  }, 0);
}

function encodeVector(vector: number[]): Buffer {
  if (vector.length !== EMBEDDING_DIMENSION || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`embedding must contain ${EMBEDDING_DIMENSION} finite numbers`);
  }
  return Buffer.from(new Float32Array(vector).buffer);
}

function decodeSections(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value
      : [];
  } catch {
    return [];
  }
}

function toSearchResult(row: SqliteSearchRow): SearchResult {
  return {
    path: row.path,
    score: row.score,
    excerpt: row.excerpt,
    sections: decodeSections(row.sections),
    timestamp: row.timestamp,
  };
}

function toRecentEntry(row: SqliteRecentRow): RecentEntry {
  return {
    path: row.path,
    title: row.title,
    date: row.date,
    timestamp: row.timestamp,
    sections: decodeSections(row.sections),
  };
}

export class JournalIndexDb {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dataPath: string, dbPath = path.join(dataPath, INDEX_FILE_NAME)) {
    fs.mkdirSync(dataPath, { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(this.db);
    this.configure();
  }

  private configure(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        sections TEXT NOT NULL,
        section_mask INTEGER NOT NULL,
        excerpt TEXT NOT NULL,
        source_mtime REAL NOT NULL,
        embedding_version TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
        embedding float[${EMBEDDING_DIMENSION}] distance_metric=cosine
      );

      CREATE TABLE IF NOT EXISTS index_state (
        path TEXT PRIMARY KEY,
        source_mtime REAL NOT NULL,
        embedding_version TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO index_meta(key, value)
      VALUES ('schema_revision', '${CURRENT_INDEX_SCHEMA_REVISION}')
      ON CONFLICT(key) DO NOTHING;

      INSERT INTO index_meta(key, value)
      VALUES ('index_complete', '0')
      ON CONFLICT(key) DO NOTHING;

      CREATE INDEX IF NOT EXISTS entries_timestamp_idx ON entries(timestamp DESC);
      CREATE INDEX IF NOT EXISTS index_state_mtime_idx ON index_state(source_mtime);
    `);
  }

  upsert(entry: IndexedEntry): void {
    const vector = encodeVector(entry.embedding);
    const sections = JSON.stringify(entry.sections);
    const mask = sectionMask(entry.sections);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT id FROM entries WHERE path = ?').get(entry.path) as { id: number } | undefined;
      let id: bigint;
      if (current) {
        id = BigInt(current.id);
        this.db.prepare(`
          UPDATE entries
          SET title = ?, date = ?, timestamp = ?, sections = ?, section_mask = ?, excerpt = ?,
              source_mtime = ?, embedding_version = ?
          WHERE id = ?
        `).run(
          entry.title,
          entry.date,
          entry.timestamp,
          sections,
          mask,
          entry.excerpt,
          entry.sourceMtime,
          entry.embeddingVersion,
          id,
        );
        this.db.prepare('DELETE FROM vec_entries WHERE rowid = ?').run(id);
      } else {
        const result = this.db.prepare(`
          INSERT INTO entries
            (path, title, date, timestamp, sections, section_mask, excerpt, source_mtime, embedding_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entry.path,
          entry.title,
          entry.date,
          entry.timestamp,
          sections,
          mask,
          entry.excerpt,
          entry.sourceMtime,
          entry.embeddingVersion,
        ) as { lastInsertRowid: bigint };
        id = BigInt(result.lastInsertRowid);
      }

      this.db.prepare('INSERT INTO vec_entries(rowid, embedding) VALUES (?, ?)').run(id, vector);
      this.db.prepare(`
        INSERT INTO index_state(path, source_mtime, embedding_version)
        VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          source_mtime = excluded.source_mtime,
          embedding_version = excluded.embedding_version
      `).run(entry.path, entry.sourceMtime, entry.embeddingVersion);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  removeByPath(entryPath: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT id FROM entries WHERE path = ?').get(entryPath) as { id: number } | undefined;
      if (current) this.db.prepare('DELETE FROM vec_entries WHERE rowid = ?').run(BigInt(current.id));
      this.db.prepare('DELETE FROM entries WHERE path = ?').run(entryPath);
      this.db.prepare('DELETE FROM index_state WHERE path = ?').run(entryPath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSourceMtime(entryPath: string): number | null {
    const row = this.db.prepare('SELECT source_mtime, embedding_version FROM index_state WHERE path = ?').get(entryPath) as SqliteStateRow | undefined;
    return row?.source_mtime ?? null;
  }

  getEmbeddingVersion(entryPath: string): string | null {
    const row = this.db.prepare('SELECT embedding_version FROM index_state WHERE path = ?').get(entryPath) as SqliteStateRow | undefined;
    return row?.embedding_version ?? null;
  }

  getSchemaRevision(): number {
    const row = this.db.prepare("SELECT value FROM index_meta WHERE key = 'schema_revision'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  isComplete(): boolean {
    const row = this.db.prepare("SELECT value FROM index_meta WHERE key = 'index_complete'").get() as { value: string } | undefined;
    return row?.value === '1';
  }

  markComplete(): void {
    this.db.prepare(`
      INSERT INTO index_meta(key, value) VALUES ('index_complete', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  }

  isEntryCurrent(entryPath: string, sourceMtime: number, embeddingVersion: string): boolean {
    const row = this.db.prepare('SELECT source_mtime, embedding_version FROM index_state WHERE path = ?').get(entryPath) as SqliteStateRow | undefined;
    return row?.source_mtime === sourceMtime && row.embedding_version === embeddingVersion;
  }

  getEntryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM entries').get() as { count: number };
    return row.count;
  }

  getIndexedPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM entries').all() as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  search(vector: number[], options: IndexSearchOptions): SearchResult[] {
    const queryVector = encodeVector(vector);
    const limit = Math.max(1, Math.floor(options.limit));
    const hasFilter = Boolean(options.sections?.length) || options.minScore !== undefined;
    const candidateCount = hasFilter ? this.getEntryCount() : limit;
    if (candidateCount === 0) return [];

    const clauses = ['v.embedding MATCH ?', 'v.k = ?'];
    const params: Array<Buffer | bigint | number> = [queryVector, BigInt(candidateCount)];
    const mask = sectionMask(options.sections ?? []);
    if (mask > 0) {
      clauses.push('(e.section_mask & ?) != 0');
      params.push(mask);
    }
    if (options.minScore !== undefined) {
      clauses.push('(1.0 - v.distance) >= ?');
      params.push(options.minScore);
    }

    const rows = this.db.prepare(`
      SELECT e.id, e.path, e.title, e.date, e.timestamp, e.sections, e.excerpt,
             e.source_mtime, e.embedding_version, (1.0 - v.distance) AS score
      FROM vec_entries AS v
      JOIN entries AS e ON e.id = v.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY v.distance ASC
      LIMIT ?
    `).all(...params, limit) as unknown as SqliteSearchRow[];
    return rows.map(toSearchResult);
  }

  listRecent(cutoffMs: number, limit: number): RecentEntry[] {
    const rows = this.db.prepare(`
      SELECT path, title, date, timestamp, sections
      FROM entries
      WHERE timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(cutoffMs, limit) as unknown as SqliteRecentRow[];
    return rows.map(toRecentEntry);
  }

  close(): void {
    this.db.close();
  }
}

export function openJournalIndex(dataPath: string, dbPath?: string): JournalIndexDb {
  return new JournalIndexDb(dataPath, dbPath);
}
