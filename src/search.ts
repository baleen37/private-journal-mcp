import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService } from './embeddings';
import { parseFrontmatter, parseSections } from './journal';
import { SearchResult, RecentEntry, EmbeddingData } from './types';

export const MAX_SEARCH_LIMIT = 50;
const DEFAULT_LIMIT = 10;

// 음수/0/과대 limit이 slice로 새는 것을 막는다. slice(0, -1)은 "마지막 하나만
// 제외한 전부"라서, 검증 없이 넘기면 코퍼스 전체가 응답으로 나간다.
function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_SEARCH_LIMIT);
}

// 엔트리 경로는 `YYYY-MM-DD/HH-MM-SS-micro.md`라 문자열 정렬이 곧 시간순이다.
// 파일을 열지 않고도 날짜 컷오프와 최신순 정렬을 할 수 있다.
function dayFromEntryPath(mdPath: string): string | undefined {
  const day = path.basename(path.dirname(mdPath));
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

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

  async search(
    query: string,
    opts: { limit?: number; sections?: string[]; minScore?: number } = {},
  ): Promise<SearchResult[]> {
    const limit = clampLimit(opts.limit);
    const minScore = opts.minScore;
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
      if (minScore !== undefined && score < minScore) continue;
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
    const limit = clampLimit(opts.limit);
    const days = opts.days ?? 30;
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const files = await this.listEntryFiles();

    // 날짜 디렉토리 기준으로 먼저 걸러낸다. 로컬/UTC 경계 때문에 하루 여유를
    // 두고, 정확한 컷오프는 frontmatter timestamp로 아래에서 확정한다.
    const cutoffDay = new Date(cutoffMs - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const candidates = files.filter((mdPath) => {
      const day = dayFromEntryPath(mdPath);
      return day === undefined || day >= cutoffDay;
    });

    // 경로 정렬이 곧 시간순이므로, 최신부터 필요한 개수만 읽는다.
    candidates.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const entries: RecentEntry[] = [];
    for (const mdPath of candidates) {
      if (entries.length >= limit) break;
      let md: string;
      try {
        md = await fs.readFile(mdPath, 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(md);
      if (fm.timestamp < cutoffMs) continue;
      entries.push({
        path: mdPath,
        title: fm.title,
        date: fm.date,
        timestamp: fm.timestamp,
        sections: parseSections(md),
      });
    }

    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
  }

  async backfill(): Promise<number> {
    const files = await this.listEntryFiles();
    let created = 0;
    for (const mdPath of files) {
      if (await this.embedIfMissing(mdPath)) created++;
    }
    return created;
  }

  // pull이 알려준 경로만 임베딩한다. 전체 목록 스캔(1000건 기준 12MB 읽기,
  // 약 250ms)을 건너뛰므로 동기화 직후 호출이 사실상 무료가 된다.
  // dataPath 밖 경로는 무시한다 — 원격이 조작된 경로를 보내도 벗어나지 못한다.
  async backfillPaths(mdPaths: string[]): Promise<number> {
    if (mdPaths.length === 0) return 0;
    const rootPath = await fs.realpath(this.dataPath).catch(() => this.dataPath);
    let created = 0;
    for (const mdPath of mdPaths) {
      if (!mdPath.endsWith('.md')) continue;
      let realPath: string;
      try {
        realPath = await fs.realpath(mdPath);
      } catch {
        continue;
      }
      const relative = path.relative(rootPath, realPath);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      if (await this.embedIfMissing(mdPath)) created++;
    }
    return created;
  }

  // 임베딩이 없을 때만 생성한다. 생성했으면 true.
  private async embedIfMissing(mdPath: string): Promise<boolean> {
    if (await this.embeddings.loadEmbedding(mdPath)) return false;
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
      return true;
    } catch (err) {
      console.error('[private-journal] backfill failed for', mdPath, err);
      return false;
    }
  }
}
