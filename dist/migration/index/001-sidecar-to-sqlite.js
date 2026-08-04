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
exports.migrateLegacyIndex = migrateLegacyIndex;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const node_sqlite_1 = require("node:sqlite");
const embeddings_1 = require("../../embeddings");
const index_db_1 = require("../../index-db");
const journal_1 = require("../../journal");
const migrations_1 = require("../../migrations");
const MIGRATION_LOCK_NAME = '.private-journal-index-migration.lock';
function sidecarPath(mdPath) {
    return mdPath.replace(/\.md$/, '.embedding');
}
async function listFiles(dataPath, extension) {
    const result = [];
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === '.git')
                continue;
            const target = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(target);
            }
            else if (entry.isFile() && entry.name.endsWith(extension)) {
                result.push(target);
            }
        }
    };
    await walk(dataPath);
    return result;
}
function validLegacyEmbedding(value, mdPath, text, sections, timestamp) {
    if (!value || typeof value !== 'object')
        return false;
    const data = value;
    return data.path === mdPath
        && data.text === text
        && data.timestamp === timestamp
        && Array.isArray(data.sections)
        && data.sections.length === sections.length
        && data.sections.every((section) => typeof section === 'string')
        && sections.every((section) => data.sections.includes(section))
        && Array.isArray(data.embedding)
        && data.embedding.length === index_db_1.EMBEDDING_DIMENSION
        && data.embedding.every((item) => typeof item === 'number' && Number.isFinite(item));
}
async function readLegacyEmbedding(mdPath, text, sections, timestamp) {
    try {
        const parsed = JSON.parse(await fs.readFile(sidecarPath(mdPath), 'utf8'));
        return validLegacyEmbedding(parsed, mdPath, text, sections, timestamp) ? parsed : null;
    }
    catch {
        return null;
    }
}
async function acquireLock(dataPath) {
    const lockPath = path.join(dataPath, MIGRATION_LOCK_NAME);
    await fs.mkdir(lockPath, { recursive: false }).catch((error) => {
        if (error.code === 'EEXIST') {
            throw new Error(`index migration already in progress: ${lockPath}`);
        }
        throw error;
    });
    await fs.writeFile(path.join(lockPath, 'owner'), `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
    return lockPath;
}
async function updateGitExclude(dataPath) {
    const gitPath = path.join(dataPath, '.git');
    try {
        const stat = await fs.stat(gitPath);
        if (!stat.isDirectory())
            return;
    }
    catch {
        return;
    }
    const excludePath = path.join(gitPath, 'info', 'exclude');
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    let current = '';
    try {
        current = await fs.readFile(excludePath, 'utf8');
    }
    catch { /* create below */ }
    const rules = [
        index_db_1.INDEX_FILE_NAME,
        `${index_db_1.INDEX_FILE_NAME}-wal`,
        `${index_db_1.INDEX_FILE_NAME}-shm`,
    ];
    const missing = rules.filter((rule) => !current.split(/\r?\n/).includes(rule));
    if (missing.length > 0)
        await fs.appendFile(excludePath, `\n${missing.join('\n')}\n`, 'utf8');
}
async function replaceDatabase(temporaryPath, targetPath) {
    await fs.rm(`${targetPath}-wal`, { force: true });
    await fs.rm(`${targetPath}-shm`, { force: true });
    await fs.rename(temporaryPath, targetPath);
    await fs.rm(`${temporaryPath}-wal`, { force: true });
    await fs.rm(`${temporaryPath}-shm`, { force: true });
}
async function buildEntry(mdPath, embeddings) {
    const [md, stat] = await Promise.all([
        fs.readFile(mdPath, 'utf8'),
        fs.stat(mdPath),
    ]);
    const frontmatter = (0, journal_1.parseFrontmatter)(md);
    const sections = (0, journal_1.parseSections)(md);
    const text = embeddings.extractSearchableText(md);
    const legacy = await readLegacyEmbedding(mdPath, text, sections, frontmatter.timestamp);
    const embedding = legacy?.embedding ?? await embeddings.generateEmbedding(text, 'passage');
    return {
        entry: {
            path: mdPath,
            title: frontmatter.title,
            date: frontmatter.date,
            timestamp: frontmatter.timestamp,
            sections,
            excerpt: text.slice(0, 200),
            sourceMtime: stat.mtimeMs,
            embeddingVersion: index_db_1.INDEX_EMBEDDING_REVISION,
            embedding,
        },
        recomputed: legacy === null,
    };
}
async function migrateRevisionZeroToOne(context) {
    const { dataPath, targetPath, embeddings } = context;
    const temporaryPath = path.join(dataPath, `${index_db_1.INDEX_FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let index;
    try {
        const markdownPaths = await listFiles(dataPath, '.md');
        index = (0, index_db_1.openJournalIndex)(dataPath, temporaryPath);
        let recomputed = 0;
        for (const mdPath of markdownPaths) {
            const built = await buildEntry(mdPath, embeddings);
            index.upsert(built.entry);
            if (built.recomputed)
                recomputed++;
        }
        const indexedPaths = new Set(index.getIndexedPaths());
        if (indexedPaths.size !== markdownPaths.length || markdownPaths.some((mdPath) => !indexedPaths.has(mdPath))) {
            throw new Error('index migration verification failed: not every markdown file was indexed');
        }
        if (index.getEntryCount() !== markdownPaths.length) {
            throw new Error('index migration verification failed: entry count mismatch');
        }
        index.markComplete();
        index.close();
        index = undefined;
        await replaceDatabase(temporaryPath, targetPath);
        const sidecars = await listFiles(dataPath, '.embedding');
        for (const sidecar of sidecars)
            await fs.rm(sidecar, { force: true });
        await updateGitExclude(dataPath);
        context.result = {
            dbPath: targetPath,
            indexed: markdownPaths.length,
            recomputed,
            removedSidecars: sidecars.length,
        };
    }
    catch (error) {
        index?.close();
        await fs.rm(temporaryPath, { force: true }).catch(() => { });
        await fs.rm(`${temporaryPath}-wal`, { force: true }).catch(() => { });
        await fs.rm(`${temporaryPath}-shm`, { force: true }).catch(() => { });
        throw error;
    }
}
const INDEX_MIGRATIONS = [
    { from: 0, to: 1, apply: migrateRevisionZeroToOne },
];
async function readIndexMetadata(targetPath) {
    try {
        const db = new node_sqlite_1.DatabaseSync(targetPath, { readOnly: true });
        try {
            const row = db.prepare("SELECT value FROM index_meta WHERE key = 'schema_revision'").get();
            const completeRow = db.prepare("SELECT value FROM index_meta WHERE key = 'index_complete'").get();
            const countRow = db.prepare('SELECT COUNT(*) AS count FROM entries').get();
            const revision = row ? Number(row.value) : 0;
            return {
                schemaRevision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
                entryCount: countRow?.count ?? 0,
                complete: completeRow?.value === '1',
            };
        }
        finally {
            db.close();
        }
    }
    catch {
        return { schemaRevision: 0, entryCount: 0, complete: false };
    }
}
async function migrateLegacyIndex(options) {
    const dataPath = path.resolve(options.dataPath);
    await fs.mkdir(dataPath, { recursive: true });
    const lockPath = await acquireLock(dataPath);
    const targetPath = path.join(dataPath, index_db_1.INDEX_FILE_NAME);
    const embeddings = options.embeddings ?? embeddings_1.EmbeddingService.getInstance();
    try {
        const metadata = await readIndexMetadata(targetPath);
        const sidecars = await listFiles(dataPath, '.embedding');
        const hasEmptyOrIncompleteCurrentIndex = metadata.schemaRevision === index_db_1.CURRENT_INDEX_SCHEMA_REVISION
            && sidecars.length > 0
            && (!metadata.complete || metadata.entryCount === 0);
        const fromRevision = hasEmptyOrIncompleteCurrentIndex ? 0 : metadata.schemaRevision;
        if (fromRevision > index_db_1.CURRENT_INDEX_SCHEMA_REVISION) {
            throw new migrations_1.DataVersionError(`index schema revision ${fromRevision} is newer than this app supports (${index_db_1.CURRENT_INDEX_SCHEMA_REVISION})`);
        }
        if (fromRevision === index_db_1.CURRENT_INDEX_SCHEMA_REVISION) {
            if (sidecars.length > 0) {
                for (const sidecar of sidecars)
                    await fs.rm(sidecar, { force: true });
                await updateGitExclude(dataPath);
            }
            return {
                dbPath: targetPath,
                fromRevision,
                toRevision: fromRevision,
                indexed: 0,
                recomputed: 0,
                removedSidecars: sidecars.length,
            };
        }
        const context = {
            dataPath,
            targetPath,
            embeddings,
            result: { dbPath: targetPath, indexed: 0, recomputed: 0, removedSidecars: 0 },
        };
        const toRevision = await (0, migrations_1.runRevisionMigrations)(fromRevision, index_db_1.CURRENT_INDEX_SCHEMA_REVISION, INDEX_MIGRATIONS, context);
        return { ...context.result, fromRevision, toRevision };
    }
    finally {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => { });
    }
}
