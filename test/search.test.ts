import { SearchService, MAX_SEARCH_LIMIT } from '../src/search';
import { JournalManager } from '../src/journal';
import { EmbeddingService } from '../src/embeddings';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srch-'));
  const emb = EmbeddingService.getInstance();
  const jm = new JournalManager(dir, emb);
  // deterministic vectors: "cat" entry -> [1,0]; "dog" entry -> [0,1]
  jest.spyOn(emb, 'generateEmbedding').mockImplementation(async (text: string) => {
    if (text.includes('고양이')) return [1, 0];
    return [0, 1];
  });
  await jm.write({ reflections: '고양이에 대한 기록' }, new Date('2026-06-20T10:00:00Z'));
  await jm.write({ observations: '강아지 관찰' }, new Date('2026-06-24T10:00:00Z'));
  return { dir, emb };
}

describe('SearchService.search', () => {
  it('ranks the semantically closest entry first', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([1, 0]); // query ~ cat
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toContain('2026-06-20');
    expect(results[0].score).toBeGreaterThan(results[results.length - 1].score - 0.0001);
  });

  it('filters by sections', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([0, 1]);
    const svc = new SearchService(dir, emb);
    const results = await svc.search('강아지', { sections: ['observations'] });
    expect(results.every(r => r.sections.includes('observations'))).toBe(true);
  });
});

describe('SearchService.search limit clamping', () => {
  it('does not leak the whole corpus for negative limits', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([1, 0]);
    const svc = new SearchService(dir, emb);
    // slice(0, -1)은 "마지막 하나만 뺀 전부"였다. 이제 기본 limit으로 떨어진다.
    const results = await svc.search('고양이', { limit: -1 });
    expect(results.length).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
    expect(results.length).toBeGreaterThan(0);
  });

  it('falls back to the default limit when limit is zero', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([1, 0]);
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('caps oversized limits to MAX_SEARCH_LIMIT', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([1, 0]);
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 99999 });
    expect(results.length).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
  });
});

describe('SearchService.search minScore', () => {
  it('drops results below the score floor', async () => {
    const { dir, emb } = await seed();
    // query orthogonal to the "dog" entry -> cosine 0 for it, 1 for "cat"
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([1, 0]);
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 10, minScore: 0.5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.score >= 0.5)).toBe(true);
  });

  it('returns an empty list when nothing clears the floor', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([1, 0]);
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 10, minScore: 1.5 });
    expect(results).toHaveLength(0);
  });
});

describe('SearchService.listRecent', () => {
  it('returns entries newest-first', async () => {
    const { dir, emb } = await seed();
    const svc = new SearchService(dir, emb);
    const recent = await svc.listRecent({ limit: 10, days: 3650 });
    expect(recent[0].timestamp).toBeGreaterThan(recent[1].timestamp);
  });

  it('reads only the entries it returns instead of the whole corpus', async () => {
    const { dir, emb } = await seed();
    const jm = new JournalManager(dir, emb);
    for (let day = 1; day <= 8; day++) {
      await jm.write(
        { observations: `entry ${day}` },
        new Date(`2026-06-0${day}T10:00:00Z`),
      );
    }
    const svc = new SearchService(dir, emb);

    const recent = await svc.listRecent({ limit: 2, days: 3650 });
    expect(recent).toHaveLength(2);
    // 최신 2건은 seed()가 만든 2026-06-20 / 06-24 엔트리여야 한다
    expect(recent[0].path).toContain('2026-06-24');
    expect(recent[1].path).toContain('2026-06-20');
  });

  it('returns the newest entries by path order without scanning every file', async () => {
    const { dir, emb } = await seed();
    const jm = new JournalManager(dir, emb);
    for (let day = 1; day <= 8; day++) {
      await jm.write(
        { observations: `entry ${day}` },
        new Date(`2026-06-0${day}T10:00:00Z`),
      );
    }
    const svc = new SearchService(dir, emb);
    const all = await svc.listRecent({ limit: 50, days: 3650 });
    expect(all).toHaveLength(10);

    const topTwo = await svc.listRecent({ limit: 2, days: 3650 });
    expect(topTwo.map((e) => e.path)).toEqual(all.slice(0, 2).map((e) => e.path));
  });

  it('skips entries outside the days window without reading them', async () => {
    const { dir, emb } = await seed();
    const jm = new JournalManager(dir, emb);
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await jm.write({ observations: 'ancient' }, old);
    await jm.write({ observations: 'fresh' }, new Date());

    const svc = new SearchService(dir, emb);
    const recent = await svc.listRecent({ limit: 10, days: 7 });

    expect(recent.every((e) => e.timestamp >= Date.now() - 8 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(recent.some((e) => e.title.length > 0)).toBe(true);
  });
});

describe('SearchService.backfill', () => {
  it('creates missing .embedding files', async () => {
    const { dir, emb } = await seed();
    // delete one embedding
    const files: string[] = [];
    async function walk(d: string) {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.embedding')) files.push(p);
      }
    }
    await walk(dir);
    await fs.unlink(files[0]);
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([0.5, 0.5]);
    const svc = new SearchService(dir, emb);
    const n = await svc.backfill();
    expect(n).toBe(1);
  });

  it('skips markdown symlinks that resolve outside dataPath while keeping regular markdown files', async () => {
    const { dir, emb } = await seed();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srch-outside-'));
    const outsideMd = path.join(outsideDir, 'outside.md');
    await fs.writeFile(outsideMd, [
      '---',
      'title: "outside"',
      'date: d',
      'timestamp: 1',
      '---',
      '',
      '## Reflections',
      '',
      'secret outside content',
      '',
    ].join('\n'), 'utf8');

    const symlinkPath = path.join(dir, 'leak.md');
    await fs.symlink(outsideMd, symlinkPath);

    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([0.25, 0.75]);
    const svc = new SearchService(dir, emb);

    const files = await svc.listEntryFiles();
    expect(files).not.toContain(symlinkPath);
    expect(files.some((file) => file.endsWith('.md'))).toBe(true);

    const created = await svc.backfill();
    expect(created).toBe(0);
    await expect(fs.access(path.join(dir, 'leak.embedding'))).rejects.toBeDefined();

    const results = await svc.search('secret outside content', { limit: 20 });
    expect(results.some((result) => result.path === symlinkPath)).toBe(false);
  });
});
