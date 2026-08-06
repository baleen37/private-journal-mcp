import * as fs from 'fs/promises';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { EmbeddingService } from '../../embeddings';
import {
  CURRENT_INDEX_SCHEMA_REVISION,
  EMBEDDING_DIMENSION,
  INDEX_EMBEDDING_REVISION,
  INDEX_FILE_NAME,
  IndexedEntry,
  openJournalIndex,
} from '../../index-db';
import { parseFrontmatter, parseSections } from '../../journal';
import { DataVersionError, RevisionMigration, runRevisionMigrations } from '../../migrations';
import { EmbeddingData } from '../../types';

const MIGRATION_LOCK_NAME = '.private-journal-index-migration.lock';

export interface MigrationOptions {
  dataPath: string;
  embeddings?: EmbeddingService;
}

export interface MigrationResult {
  dbPath: string;
  fromRevision: number;
  toRevision: number;
  indexed: number;
  recomputed: number;
  removedSidecars: number;
}

interface IndexMigrationContext {
  dataPath: string;
  targetPath: string;
  embeddings: EmbeddingService;
  result: Omit<MigrationResult, 'fromRevision' | 'toRevision'>;
}

function sidecarPath(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.embedding');
}

async function listFiles(dataPath: string, extension: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        result.push(target);
      }
    }
  };
  await walk(dataPath);
  return result;
}

function validLegacyEmbedding(
  value: unknown,
  mdPath: string,
  text: string,
  sections: string[],
  timestamp: number,
): value is EmbeddingData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<EmbeddingData>;
  return data.path === mdPath
    && data.text === text
    && data.timestamp === timestamp
    && Array.isArray(data.sections)
    && data.sections.length === sections.length
    && data.sections.every((section) => typeof section === 'string')
    && sections.every((section) => data.sections!.includes(section))
    && Array.isArray(data.embedding)
    && data.embedding.length === EMBEDDING_DIMENSION
    && data.embedding.every((item) => typeof item === 'number' && Number.isFinite(item));
}

async function readLegacyEmbedding(
  mdPath: string,
  text: string,
  sections: string[],
  timestamp: number,
): Promise<EmbeddingData | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(sidecarPath(mdPath), 'utf8'));
    return validLegacyEmbedding(parsed, mdPath, text, sections, timestamp) ? parsed : null;
  } catch {
    return null;
  }
}

async function acquireLock(dataPath: string): Promise<string> {
  const lockPath = path.join(dataPath, MIGRATION_LOCK_NAME);
  await fs.mkdir(lockPath, { recursive: false }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`index migration already in progress: ${lockPath}`);
    }
    throw error;
  });
  await fs.writeFile(path.join(lockPath, 'owner'), `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  return lockPath;
}

async function updateGitExclude(dataPath: string): Promise<void> {
  const gitPath = path.join(dataPath, '.git');
  try {
    const stat = await fs.stat(gitPath);
    if (!stat.isDirectory()) return;
  } catch {
    return;
  }

  const excludePath = path.join(gitPath, 'info', 'exclude');
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  let current = '';
  try {
    current = await fs.readFile(excludePath, 'utf8');
  } catch { /* create below */ }
  const rules = [
    INDEX_FILE_NAME,
    `${INDEX_FILE_NAME}-wal`,
    `${INDEX_FILE_NAME}-shm`,
  ];
  const missing = rules.filter((rule) => !current.split(/\r?\n/).includes(rule));
  if (missing.length > 0) await fs.appendFile(excludePath, `\n${missing.join('\n')}\n`, 'utf8');
}

async function replaceDatabase(temporaryPath: string, targetPath: string): Promise<void> {
  await fs.rm(`${targetPath}-wal`, { force: true });
  await fs.rm(`${targetPath}-shm`, { force: true });
  await fs.rename(temporaryPath, targetPath);
  await fs.rm(`${temporaryPath}-wal`, { force: true });
  await fs.rm(`${temporaryPath}-shm`, { force: true });
}

async function buildEntry(
  mdPath: string,
  embeddings: EmbeddingService,
): Promise<{ entry: IndexedEntry; recomputed: boolean }> {
  const [md, stat] = await Promise.all([
    fs.readFile(mdPath, 'utf8'),
    fs.stat(mdPath),
  ]);
  const frontmatter = parseFrontmatter(md);
  const sections = parseSections(md);
  const text = embeddings.extractSearchableText(md);
  const legacy = await readLegacyEmbedding(mdPath, text, sections, frontmatter.timestamp);
  const embedding = legacy?.embedding ?? await embeddings.generateEmbedding(text, 'passage');
  return {
    entry: {
      path: mdPath,
      title: frontmatter.title,
      date: frontmatter.created_at,
      timestamp: frontmatter.timestamp,
      sections,
      excerpt: text.slice(0, 200),
      sourceMtime: stat.mtimeMs,
      embeddingVersion: INDEX_EMBEDDING_REVISION,
      embedding,
    },
    recomputed: legacy === null,
  };
}

async function migrateRevisionZeroToOne(context: IndexMigrationContext): Promise<void> {
  const { dataPath, targetPath, embeddings } = context;
  const temporaryPath = path.join(
    dataPath,
    `${INDEX_FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let index: ReturnType<typeof openJournalIndex> | undefined;

  try {
    const markdownPaths = await listFiles(dataPath, '.md');
    index = openJournalIndex(dataPath, temporaryPath);
    let recomputed = 0;
    for (const mdPath of markdownPaths) {
      const built = await buildEntry(mdPath, embeddings);
      index.upsert(built.entry);
      if (built.recomputed) recomputed++;
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
    for (const sidecar of sidecars) await fs.rm(sidecar, { force: true });
    await updateGitExclude(dataPath);
    context.result = {
      dbPath: targetPath,
      indexed: markdownPaths.length,
      recomputed,
      removedSidecars: sidecars.length,
    };
  } catch (error) {
    index?.close();
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await fs.rm(`${temporaryPath}-wal`, { force: true }).catch(() => {});
    await fs.rm(`${temporaryPath}-shm`, { force: true }).catch(() => {});
    throw error;
  }
}

const INDEX_MIGRATIONS: RevisionMigration<IndexMigrationContext>[] = [
  { from: 0, to: 1, apply: migrateRevisionZeroToOne },
];

interface IndexMetadata {
  schemaRevision: number;
  entryCount: number;
  complete: boolean;
}

async function readIndexMetadata(targetPath: string): Promise<IndexMetadata> {
  try {
    const db = new DatabaseSync(targetPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM index_meta WHERE key = 'schema_revision'").get() as { value: string } | undefined;
      const completeRow = db.prepare("SELECT value FROM index_meta WHERE key = 'index_complete'").get() as { value: string } | undefined;
      const countRow = db.prepare('SELECT COUNT(*) AS count FROM entries').get() as { count: number } | undefined;
      const revision = row ? Number(row.value) : 0;
      return {
        schemaRevision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
        entryCount: countRow?.count ?? 0,
        complete: completeRow?.value === '1',
      };
    } finally {
      db.close();
    }
  } catch {
    return { schemaRevision: 0, entryCount: 0, complete: false };
  }
}

export async function migrateLegacyIndex(options: MigrationOptions): Promise<MigrationResult> {
  const dataPath = path.resolve(options.dataPath);
  await fs.mkdir(dataPath, { recursive: true });
  const lockPath = await acquireLock(dataPath);
  const targetPath = path.join(dataPath, INDEX_FILE_NAME);
  const embeddings = options.embeddings ?? EmbeddingService.getInstance();

  try {
    const metadata = await readIndexMetadata(targetPath);
    const sidecars = await listFiles(dataPath, '.embedding');
    const hasEmptyOrIncompleteCurrentIndex = metadata.schemaRevision === CURRENT_INDEX_SCHEMA_REVISION
      && sidecars.length > 0
      && (!metadata.complete || metadata.entryCount === 0);
    const fromRevision = hasEmptyOrIncompleteCurrentIndex ? 0 : metadata.schemaRevision;
    if (fromRevision > CURRENT_INDEX_SCHEMA_REVISION) {
      throw new DataVersionError(
        `index schema revision ${fromRevision} is newer than this app supports (${CURRENT_INDEX_SCHEMA_REVISION})`,
      );
    }
    if (fromRevision === CURRENT_INDEX_SCHEMA_REVISION) {
      if (sidecars.length > 0) {
        for (const sidecar of sidecars) await fs.rm(sidecar, { force: true });
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

    const context: IndexMigrationContext = {
      dataPath,
      targetPath,
      embeddings,
      result: { dbPath: targetPath, indexed: 0, recomputed: 0, removedSidecars: 0 },
    };
    const toRevision = await runRevisionMigrations(
      fromRevision,
      CURRENT_INDEX_SCHEMA_REVISION,
      INDEX_MIGRATIONS,
      context,
    );
    return { ...context.result, fromRevision, toRevision };
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
