import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
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

  it('handleRead rejects paths outside the journal data directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    const outsidePath = path.join(outsideDir, 'entry.md');
    await fs.writeFile(outsidePath, '외부 파일', 'utf8');
    const srv = new PrivateJournalServer({ dataPath: dir });

    await expect(srv.handleRead({ path: outsidePath })).rejects.toThrow(
      'Path must be a journal markdown file inside the data directory.',
    );
  });

  it('handleRead rejects non-markdown files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const filePath = path.join(dir, 'entry.txt');
    await fs.writeFile(filePath, 'not markdown', 'utf8');
    const srv = new PrivateJournalServer({ dataPath: dir });

    await expect(srv.handleRead({ path: filePath })).rejects.toThrow(
      'Path must be a journal markdown file inside the data directory.',
    );
  });

  it('handleRead rejects markdown symlinks escaping the data directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    const outsidePath = path.join(outsideDir, 'entry.md');
    const linkedPath = path.join(dir, 'linked.md');
    await fs.writeFile(outsidePath, 'symlink target', 'utf8');
    await fs.symlink(outsidePath, linkedPath);
    const srv = new PrivateJournalServer({ dataPath: dir });

    await expect(srv.handleRead({ path: linkedPath })).rejects.toThrow(
      'Path must be a journal markdown file inside the data directory.',
    );
  });

  it('handleRead rejects markdown symlinks to non-markdown files inside the data directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const targetPath = path.join(dir, 'secret.txt');
    const linkedPath = path.join(dir, 'linked.md');
    await fs.writeFile(targetPath, 'secret', 'utf8');
    await fs.symlink(targetPath, linkedPath);
    const srv = new PrivateJournalServer({ dataPath: dir });

    await expect(srv.handleRead({ path: linkedPath })).rejects.toThrow(
      'Path must be a journal markdown file inside the data directory.',
    );
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

  it('run performs ensureRepo before backfill before connect', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });
    const order: string[] = [];

    jest.spyOn((srv as any).git, 'ensureRepo').mockImplementation(async () => {
      order.push('ensureRepo');
    });
    jest.spyOn((srv as any).search, 'backfill').mockImplementation(async () => {
      order.push('backfill');
      return 0;
    });
    jest.spyOn(McpServer.prototype, 'connect').mockImplementation(async () => {
      order.push('connect');
      return undefined as never;
    });

    await srv.run();

    expect(order).toEqual(['ensureRepo', 'backfill', 'connect']);
  });
});
