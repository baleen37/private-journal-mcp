import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { openJournalIndex } from '../src/index-db';

function vector(first: number, second = 0): number[] {
  return [first, second, ...Array<number>(382).fill(0)];
}

describe('JournalIndexDb', () => {
  it('stores vectors and returns nearest entries with section filtering', async () => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-index-'));
    const index = openJournalIndex(dataPath);

    index.upsert({
      path: path.join(dataPath, '2026-08-04', 'cat.md'),
      title: 'cat',
      date: '2026-08-04T10:00:00.000Z',
      timestamp: 10,
      sections: ['reflections'],
      excerpt: '고양이 기록',
      sourceMtime: 100,
      embeddingVersion: 'test',
      embedding: vector(1),
    });
    index.upsert({
      path: path.join(dataPath, '2026-08-04', 'dog.md'),
      title: 'dog',
      date: '2026-08-04T11:00:00.000Z',
      timestamp: 11,
      sections: ['observations'],
      excerpt: '강아지 기록',
      sourceMtime: 101,
      embeddingVersion: 'test',
      embedding: vector(0, 1),
    });

    expect(index.search(vector(1), { limit: 10 })).toEqual([
      expect.objectContaining({
        path: path.join(dataPath, '2026-08-04', 'cat.md'),
        score: expect.closeTo(1, 5),
        sections: ['reflections'],
      }),
      expect.objectContaining({
        path: path.join(dataPath, '2026-08-04', 'dog.md'),
        score: expect.closeTo(0, 5),
      }),
    ]);
    expect(index.search(vector(1), { limit: 10, sections: ['observations'] })).toEqual([
      expect.objectContaining({
        path: path.join(dataPath, '2026-08-04', 'dog.md'),
        sections: ['observations'],
      }),
    ]);
    expect(index.getSourceMtime(path.join(dataPath, '2026-08-04', 'cat.md'))).toBe(100);

    index.close();
  });

  it('allows separate session handles to share the same WAL index', async () => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-index-shared-'));
    const first = openJournalIndex(dataPath);
    const second = openJournalIndex(dataPath);
    const firstPath = path.join(dataPath, 'first.md');
    const secondPath = path.join(dataPath, 'second.md');

    first.upsert({
      path: firstPath,
      title: 'first',
      date: '2026-08-04',
      timestamp: 1,
      sections: ['reflections'],
      excerpt: 'first',
      sourceMtime: 1,
      embeddingVersion: 'test',
      embedding: vector(1),
    });
    second.upsert({
      path: secondPath,
      title: 'second',
      date: '2026-08-04',
      timestamp: 2,
      sections: ['observations'],
      excerpt: 'second',
      sourceMtime: 2,
      embeddingVersion: 'test',
      embedding: vector(0, 1),
    });

    expect(first.getEntryCount()).toBe(2);
    expect(second.getEntryCount()).toBe(2);
    second.close();
    first.close();
  });
});
