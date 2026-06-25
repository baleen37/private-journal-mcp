import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingService } from '../src/embeddings';
import { SearchService } from '../src/search';
import { PrivateJournalServer } from '../src/server';

describe('PrivateJournalServer handlers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('handleWrite rejects empty input', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });

    await expect(srv.handleWrite({})).rejects.toThrow(
      'At least one journal section must have content.',
    );
  });

  it('write then read returns content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    jest.spyOn(EmbeddingService.getInstance(), 'generateEmbedding').mockResolvedValue([0.1, 0.2]);
    const srv = new PrivateJournalServer({ dataPath: dir });

    const { path: entryPath } = await srv.handleWrite({ reflections: '회고 내용' });
    const { content } = await srv.handleRead({ path: entryPath });

    expect(content).toContain('회고 내용');
  });

  it('handleSearch forwards query and options to SearchService.search', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const expected = [
      {
        path: path.join(dir, '2026-06-25', 'entry.md'),
        score: 0.9,
        excerpt: '결과',
        sections: ['observations'],
        timestamp: 1750809600000,
      },
    ];
    const searchSpy = jest.spyOn(SearchService.prototype, 'search').mockResolvedValue(expected);
    const srv = new PrivateJournalServer({ dataPath: dir });

    const result = await srv.handleSearch({
      query: '회고',
      limit: 5,
      sections: ['observations'],
    });

    expect(searchSpy).toHaveBeenCalledWith('회고', {
      limit: 5,
      sections: ['observations'],
    });
    expect(result).toBe(expected);
  });

  it('handleList returns the written entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    jest.spyOn(EmbeddingService.getInstance(), 'generateEmbedding').mockResolvedValue([0.1, 0.2]);
    const srv = new PrivateJournalServer({ dataPath: dir });

    await srv.handleWrite({ observations: '관찰' });
    const list = await srv.handleList({ days: 3650 });

    expect(list).toHaveLength(1);
    expect(list[0].sections).toContain('observations');
  });
});
