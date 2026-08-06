import { SearchService, MAX_SEARCH_LIMIT } from '../src/search';
import { JournalManager } from '../src/journal';
import { EmbeddingService } from '../src/embeddings';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

function vector(first: number, second = 0): number[] {
  return [first, second, ...Array<number>(382).fill(0)];
}

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srch-'));
  const emb = EmbeddingService.getInstance();
  const jm = new JournalManager(dir, emb);
  // deterministic vectors: "cat" entry -> [1,0]; "dog" entry -> [0,1]
  jest.spyOn(emb, 'generateEmbedding').mockImplementation(async (text: string) => {
    if (text.includes('고양이')) return vector(1);
    return vector(0, 1);
  });
  await jm.write({ reflections: '고양이에 대한 기록' }, '고양이 기록', new Date('2026-06-20T10:00:00Z'));
  await jm.write({ observations: '강아지 관찰' }, '강아지 관찰', new Date('2026-06-24T10:00:00Z'));
  const index = new SearchService(dir, emb);
  await index.backfill();
  index.close();
  return { dir, emb };
}

describe('SearchService.search', () => {
  it('ranks the semantically closest entry first', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(1)); // query ~ cat
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toContain('2026-06-20');
    expect(results[0].score).toBeGreaterThan(results[results.length - 1].score - 0.0001);
  });

  it('filters by sections', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(0, 1));
    const svc = new SearchService(dir, emb);
    const results = await svc.search('강아지', { sections: ['observations'] });
    expect(results.every(r => r.sections.includes('observations'))).toBe(true);
  });
});

describe('SearchService.search limit clamping', () => {
  it('does not leak the whole corpus for negative limits', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(1));
    const svc = new SearchService(dir, emb);
    // slice(0, -1)은 "마지막 하나만 뺀 전부"였다. 이제 기본 limit으로 떨어진다.
    const results = await svc.search('고양이', { limit: -1 });
    expect(results.length).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
    expect(results.length).toBeGreaterThan(0);
  });

  it('falls back to the default limit when limit is zero', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(1));
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('caps oversized limits to MAX_SEARCH_LIMIT', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(1));
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 99999 });
    expect(results.length).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
  });
});

describe('SearchService.search minScore', () => {
  it('drops results below the score floor', async () => {
    const { dir, emb } = await seed();
    // query orthogonal to the "dog" entry -> cosine 0 for it, 1 for "cat"
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(1));
    const svc = new SearchService(dir, emb);
    const results = await svc.search('고양이', { limit: 10, minScore: 0.5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.score >= 0.5)).toBe(true);
  });

  it('returns an empty list when nothing clears the floor', async () => {
    const { dir, emb } = await seed();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(1));
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
        `검색 기록 ${day}`,
        new Date(`2026-06-0${day}T10:00:00Z`),
      );
    }
    const svc = new SearchService(dir, emb);
    await svc.backfill();

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
        `경로 기록 ${day}`,
        new Date(`2026-06-0${day}T10:00:00Z`),
      );
    }
    const svc = new SearchService(dir, emb);
    await svc.backfill();
    const all = await svc.listRecent({ limit: 50, days: 3650 });
    expect(all).toHaveLength(10);

    const topTwo = await svc.listRecent({ limit: 2, days: 3650 });
    expect(topTwo.map((e) => e.path)).toEqual(all.slice(0, 2).map((e) => e.path));
  });

  it('skips entries outside the days window without reading them', async () => {
    const { dir, emb } = await seed();
    const jm = new JournalManager(dir, emb);
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await jm.write({ observations: 'ancient' }, '오래된 기록', old);
    await jm.write({ observations: 'fresh' }, '최근 기록', new Date());

    const svc = new SearchService(dir, emb);
    await svc.backfill();
    const recent = await svc.listRecent({ limit: 10, days: 7 });

    expect(recent.every((e) => e.timestamp >= Date.now() - 8 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(recent.some((e) => e.title.length > 0)).toBe(true);
  });
});

describe('SearchService.backfill', () => {
  it('creates missing SQLite index rows', async () => {
    const { dir, emb } = await seed();
    const svc = new SearchService(dir, emb);
    const files = await svc.listEntryFiles();
    await svc.removePath(files[0]);
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(0.5, 0.5));
    const n = await svc.backfill();
    expect(n).toBe(1);
  });

  it('embeds only the given paths without scanning the corpus', async () => {
    const { dir, emb } = await seed();
    const jm = new JournalManager(dir, emb);
    const target = await jm.write({ observations: 'pulled entry' }, '가져온 기록', new Date('2026-07-30T10:00:00Z'));

    const svc = new SearchService(dir, emb);
    const listSpy = jest.spyOn(svc, 'listEntryFiles');
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(0.5, 0.5));

    const created = await svc.backfillPaths([target]);

    expect(created).toBe(1);
    // 대상 경로를 이미 알고 있으므로 전체 목록을 훑지 않아야 한다
    expect(listSpy).not.toHaveBeenCalled();
    expect((await svc.search('pulled entry', { limit: 10 })).some((result) => result.path === target)).toBe(true);
  });

  it('ignores paths outside dataPath and paths that already have embeddings', async () => {
    const { dir, emb } = await seed();
    const jm = new JournalManager(dir, emb);
    const kept = await jm.write({ observations: 'already embedded' }, '이미 임베딩된 기록', new Date('2026-07-30T11:00:00Z'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srch-outside-bf-'));
    const outside = path.join(outsideDir, 'evil.md');
    await fs.writeFile(outside, '## Reflections\n\nsecret\n', 'utf8');

    const svc = new SearchService(dir, emb);
    await svc.indexPath(kept);
    const created = await svc.backfillPaths([kept, outside]);

    expect(created).toBe(0);
    expect((await svc.search('secret', { limit: 10 })).some((result) => result.path === outside)).toBe(false);
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

    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue(vector(0.25, 0.75));
    const svc = new SearchService(dir, emb);

    const files = await svc.listEntryFiles();
    expect(files).not.toContain(symlinkPath);
    expect(files.some((file) => file.endsWith('.md'))).toBe(true);

    const created = await svc.backfill();
    expect(created).toBe(0);

    const results = await svc.search('secret outside content', { limit: 20 });
    expect(results.some((result) => result.path === symlinkPath)).toBe(false);
  });
});
