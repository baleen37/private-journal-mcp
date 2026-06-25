import { SearchService } from '../src/search';
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

describe('SearchService.listRecent', () => {
  it('returns entries newest-first', async () => {
    const { dir, emb } = await seed();
    const svc = new SearchService(dir, emb);
    const recent = await svc.listRecent({ limit: 10, days: 3650 });
    expect(recent[0].timestamp).toBeGreaterThan(recent[1].timestamp);
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
});
