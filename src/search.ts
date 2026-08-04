import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService } from './embeddings';
import { INDEX_EMBEDDING_REVISION, JournalIndexDb, openJournalIndex } from './index-db';
import { parseFrontmatter, parseSections } from './journal';
import { RecentEntry, SearchResult } from './types';

export const MAX_SEARCH_LIMIT = 50;
const DEFAULT_LIMIT = 10;

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_SEARCH_LIMIT);
}

export class SearchService {
  private readonly dataPath: string;
  private readonly index: JournalIndexDb;

  constructor(dataPath: string, private readonly embeddings: EmbeddingService) {
    this.dataPath = path.resolve(dataPath);
    this.index = openJournalIndex(this.dataPath);
  }

  needsInitialBackfill(): boolean {
    return !this.index.isComplete();
  }

  async listEntryFiles(): Promise<string[]> {
    const out: string[] = [];
    const rootPath = await fs.realpath(this.dataPath).catch(() => this.dataPath);

    const isSafeMarkdownFile = async (filePath: string): Promise<boolean> => {
      let stat;
      try {
        stat = await fs.lstat(filePath);
      } catch {
        return false;
      }
      if (!stat.isFile()) return false;
      let realPath: string;
      try {
        realPath = await fs.realpath(filePath);
      } catch {
        return false;
      }
      const relative = path.relative(rootPath, realPath);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    };

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git') continue;
          await walk(target);
        } else if (entry.name.endsWith('.md') && await isSafeMarkdownFile(target)) {
          out.push(target);
        }
      }
    };
    await walk(this.dataPath);
    return out;
  }

  private resolveInsideDataPath(mdPath: string): string | null {
    const absolute = path.resolve(mdPath);
    const relative = path.relative(this.dataPath, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || !absolute.endsWith('.md')) {
      return null;
    }
    return absolute;
  }

  private async isSafeMarkdownPath(mdPath: string): Promise<boolean> {
    const absolute = this.resolveInsideDataPath(mdPath);
    if (!absolute) return false;
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile()) return false;
      const [rootPath, realPath] = await Promise.all([
        fs.realpath(this.dataPath),
        fs.realpath(absolute),
      ]);
      const relative = path.relative(rootPath, realPath);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }

  async search(
    query: string,
    opts: { limit?: number; sections?: string[]; minScore?: number } = {},
  ): Promise<SearchResult[]> {
    const qVec = await this.embeddings.generateEmbedding(query, 'query');
    return this.index.search(qVec, {
      limit: clampLimit(opts.limit),
      sections: opts.sections,
      minScore: opts.minScore,
    });
  }

  async listRecent(opts: { limit?: number; days?: number } = {}): Promise<RecentEntry[]> {
    const limit = clampLimit(opts.limit);
    const days = opts.days ?? 30;
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.index.listRecent(cutoffMs, limit);
  }

  async indexPath(mdPath: string): Promise<boolean> {
    const absolute = this.resolveInsideDataPath(mdPath);
    if (!absolute || !(await this.isSafeMarkdownPath(absolute))) return false;

    const stat = await fs.stat(absolute);
    const currentMtime = this.index.getSourceMtime(absolute);
    const currentEmbeddingVersion = this.index.getEmbeddingVersion(absolute);
    if (currentMtime === stat.mtimeMs && currentEmbeddingVersion === INDEX_EMBEDDING_REVISION) return false;

    try {
      const md = await fs.readFile(absolute, 'utf8');
      const frontmatter = parseFrontmatter(md);
      const text = this.embeddings.extractSearchableText(md);
      const embedding = await this.embeddings.generateEmbedding(text, 'passage');
      this.index.upsert({
        path: absolute,
        title: frontmatter.title,
        date: frontmatter.date,
        timestamp: frontmatter.timestamp,
        sections: parseSections(md),
        excerpt: text.slice(0, 200),
        sourceMtime: stat.mtimeMs,
        embeddingVersion: INDEX_EMBEDDING_REVISION,
        embedding,
      });
      return true;
    } catch (error) {
      console.error('[private-journal] index failed for', absolute, error);
      return false;
    }
  }

  async removePath(mdPath: string): Promise<void> {
    const absolute = this.resolveInsideDataPath(mdPath);
    if (absolute) this.index.removeByPath(absolute);
  }

  async backfill(): Promise<number> {
    const files = await this.listEntryFiles();
    const currentPaths = new Set(files);
    for (const indexedPath of this.index.getIndexedPaths()) {
      if (!currentPaths.has(indexedPath)) this.index.removeByPath(indexedPath);
    }

    let indexed = 0;
    let complete = true;
    for (const mdPath of files) {
      if (await this.indexPath(mdPath)) indexed++;
      let stat;
      try {
        stat = await fs.stat(mdPath);
      } catch {
        complete = false;
        continue;
      }
      if (!this.index.isEntryCurrent(mdPath, stat.mtimeMs, INDEX_EMBEDDING_REVISION)) complete = false;
    }
    if (complete) this.index.markComplete();
    return indexed;
  }

  async backfillPaths(mdPaths: string[]): Promise<number> {
    let indexed = 0;
    for (const mdPath of mdPaths) {
      const absolute = this.resolveInsideDataPath(mdPath);
      if (!absolute) continue;
      if (await fs.access(absolute).then(() => true).catch(() => false)) {
        if (await this.indexPath(absolute)) indexed++;
      } else {
        await this.removePath(absolute);
      }
    }
    return indexed;
  }

  close(): void {
    this.index.close();
  }

}
