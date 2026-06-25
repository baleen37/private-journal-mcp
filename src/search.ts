import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService } from './embeddings';
import { parseFrontmatter, parseSections } from './journal';
import { SearchResult, RecentEntry, EmbeddingData } from './types';

export class SearchService {
  constructor(private dataPath: string, private embeddings: EmbeddingService) {}

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

    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '.git') continue;
          await walk(p);
        } else if (e.name.endsWith('.md') && await isSafeMarkdownFile(p)) {
          out.push(p);
        }
      }
    };
    await walk(this.dataPath);
    return out;
  }

  async search(query: string, opts: { limit?: number; sections?: string[] } = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 10;
    const qVec = await this.embeddings.generateEmbedding(query, 'query');
    const files = await this.listEntryFiles();
    const scored: SearchResult[] = [];
    for (const mdPath of files) {
      const data = await this.embeddings.loadEmbedding(mdPath);
      if (!data) continue;
      if (opts.sections && opts.sections.length > 0) {
        const overlap = data.sections.some((s) => opts.sections!.includes(s));
        if (!overlap) continue;
      }
      const score = this.embeddings.cosineSimilarity(qVec, data.embedding);
      scored.push({
        path: mdPath,
        score,
        excerpt: data.text.slice(0, 200),
        sections: data.sections,
        timestamp: data.timestamp,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async listRecent(opts: { limit?: number; days?: number } = {}): Promise<RecentEntry[]> {
    const limit = opts.limit ?? 10;
    const days = opts.days ?? 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const files = await this.listEntryFiles();
    const entries: RecentEntry[] = [];
    for (const mdPath of files) {
      const md = await fs.readFile(mdPath, 'utf8');
      const fm = parseFrontmatter(md);
      if (fm.timestamp < cutoff) continue;
      entries.push({
        path: mdPath,
        title: fm.title,
        date: fm.date,
        timestamp: fm.timestamp,
        sections: parseSections(md),
      });
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit);
  }

  async backfill(): Promise<number> {
    const files = await this.listEntryFiles();
    let created = 0;
    for (const mdPath of files) {
      const existing = await this.embeddings.loadEmbedding(mdPath);
      if (existing) continue;
      try {
        const md = await fs.readFile(mdPath, 'utf8');
        const fm = parseFrontmatter(md);
        const text = this.embeddings.extractSearchableText(md);
        const vector = await this.embeddings.generateEmbedding(text, 'passage');
        const data: EmbeddingData = {
          embedding: vector,
          text,
          sections: parseSections(md),
          timestamp: fm.timestamp,
          path: mdPath,
        };
        await this.embeddings.saveEmbedding(mdPath, data);
        created++;
      } catch (err) {
        console.error('[private-journal] backfill failed for', mdPath, err);
      }
    }
    return created;
  }
}
