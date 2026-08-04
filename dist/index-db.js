"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JournalIndexDb = exports.INDEX_EMBEDDING_REVISION = exports.CURRENT_INDEX_SCHEMA_REVISION = exports.EMBEDDING_DIMENSION = exports.INDEX_FILE_NAME = void 0;
exports.openJournalIndex = openJournalIndex;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const node_sqlite_1 = require("node:sqlite");
const sqliteVec = __importStar(require("sqlite-vec"));
const types_1 = require("./types");
exports.INDEX_FILE_NAME = '.private-journal-index.sqlite';
exports.EMBEDDING_DIMENSION = 384;
exports.CURRENT_INDEX_SCHEMA_REVISION = 1;
exports.INDEX_EMBEDDING_REVISION = 'Xenova/multilingual-e5-small:384:v1';
function sectionMask(sections) {
    return sections.reduce((mask, section) => {
        const index = types_1.JOURNAL_SECTIONS.indexOf(section);
        return index >= 0 ? mask | (1 << index) : mask;
    }, 0);
}
function encodeVector(vector) {
    if (vector.length !== exports.EMBEDDING_DIMENSION || vector.some((value) => !Number.isFinite(value))) {
        throw new Error(`embedding must contain ${exports.EMBEDDING_DIMENSION} finite numbers`);
    }
    return Buffer.from(new Float32Array(vector).buffer);
}
function decodeSections(raw) {
    try {
        const value = JSON.parse(raw);
        return Array.isArray(value) && value.every((item) => typeof item === 'string')
            ? value
            : [];
    }
    catch {
        return [];
    }
}
function toSearchResult(row) {
    return {
        path: row.path,
        score: row.score,
        excerpt: row.excerpt,
        sections: decodeSections(row.sections),
        timestamp: row.timestamp,
    };
}
function toRecentEntry(row) {
    return {
        path: row.path,
        title: row.title,
        date: row.date,
        timestamp: row.timestamp,
        sections: decodeSections(row.sections),
    };
}
class JournalIndexDb {
    dbPath;
    db;
    constructor(dataPath, dbPath = path.join(dataPath, exports.INDEX_FILE_NAME)) {
        fs.mkdirSync(dataPath, { recursive: true });
        this.dbPath = dbPath;
        this.db = new node_sqlite_1.DatabaseSync(dbPath, { allowExtension: true });
        sqliteVec.load(this.db);
        this.configure();
    }
    configure() {
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
        embedding float[${exports.EMBEDDING_DIMENSION}] distance_metric=cosine
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
      VALUES ('schema_revision', '${exports.CURRENT_INDEX_SCHEMA_REVISION}')
      ON CONFLICT(key) DO NOTHING;

      INSERT INTO index_meta(key, value)
      VALUES ('index_complete', '0')
      ON CONFLICT(key) DO NOTHING;

      CREATE INDEX IF NOT EXISTS entries_timestamp_idx ON entries(timestamp DESC);
      CREATE INDEX IF NOT EXISTS index_state_mtime_idx ON index_state(source_mtime);
    `);
    }
    upsert(entry) {
        const vector = encodeVector(entry.embedding);
        const sections = JSON.stringify(entry.sections);
        const mask = sectionMask(entry.sections);
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = this.db.prepare('SELECT id FROM entries WHERE path = ?').get(entry.path);
            let id;
            if (current) {
                id = BigInt(current.id);
                this.db.prepare(`
          UPDATE entries
          SET title = ?, date = ?, timestamp = ?, sections = ?, section_mask = ?, excerpt = ?,
              source_mtime = ?, embedding_version = ?
          WHERE id = ?
        `).run(entry.title, entry.date, entry.timestamp, sections, mask, entry.excerpt, entry.sourceMtime, entry.embeddingVersion, id);
                this.db.prepare('DELETE FROM vec_entries WHERE rowid = ?').run(id);
            }
            else {
                const result = this.db.prepare(`
          INSERT INTO entries
            (path, title, date, timestamp, sections, section_mask, excerpt, source_mtime, embedding_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(entry.path, entry.title, entry.date, entry.timestamp, sections, mask, entry.excerpt, entry.sourceMtime, entry.embeddingVersion);
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
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    removeByPath(entryPath) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = this.db.prepare('SELECT id FROM entries WHERE path = ?').get(entryPath);
            if (current)
                this.db.prepare('DELETE FROM vec_entries WHERE rowid = ?').run(BigInt(current.id));
            this.db.prepare('DELETE FROM entries WHERE path = ?').run(entryPath);
            this.db.prepare('DELETE FROM index_state WHERE path = ?').run(entryPath);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    getSourceMtime(entryPath) {
        const row = this.db.prepare('SELECT source_mtime, embedding_version FROM index_state WHERE path = ?').get(entryPath);
        return row?.source_mtime ?? null;
    }
    getEmbeddingVersion(entryPath) {
        const row = this.db.prepare('SELECT embedding_version FROM index_state WHERE path = ?').get(entryPath);
        return row?.embedding_version ?? null;
    }
    getSchemaRevision() {
        const row = this.db.prepare("SELECT value FROM index_meta WHERE key = 'schema_revision'").get();
        return row ? Number(row.value) : 0;
    }
    isComplete() {
        const row = this.db.prepare("SELECT value FROM index_meta WHERE key = 'index_complete'").get();
        return row?.value === '1';
    }
    markComplete() {
        this.db.prepare(`
      INSERT INTO index_meta(key, value) VALUES ('index_complete', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    }
    isEntryCurrent(entryPath, sourceMtime, embeddingVersion) {
        const row = this.db.prepare('SELECT source_mtime, embedding_version FROM index_state WHERE path = ?').get(entryPath);
        return row?.source_mtime === sourceMtime && row.embedding_version === embeddingVersion;
    }
    getEntryCount() {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM entries').get();
        return row.count;
    }
    getIndexedPaths() {
        const rows = this.db.prepare('SELECT path FROM entries').all();
        return rows.map((row) => row.path);
    }
    search(vector, options) {
        const queryVector = encodeVector(vector);
        const limit = Math.max(1, Math.floor(options.limit));
        const hasFilter = Boolean(options.sections?.length) || options.minScore !== undefined;
        const candidateCount = hasFilter ? this.getEntryCount() : limit;
        if (candidateCount === 0)
            return [];
        const clauses = ['v.embedding MATCH ?', 'v.k = ?'];
        const params = [queryVector, BigInt(candidateCount)];
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
    `).all(...params, limit);
        return rows.map(toSearchResult);
    }
    listRecent(cutoffMs, limit) {
        const rows = this.db.prepare(`
      SELECT path, title, date, timestamp, sections
      FROM entries
      WHERE timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(cutoffMs, limit);
        return rows.map(toRecentEntry);
    }
    close() {
        this.db.close();
    }
}
exports.JournalIndexDb = JournalIndexDb;
function openJournalIndex(dataPath, dbPath) {
    return new JournalIndexDb(dataPath, dbPath);
}
