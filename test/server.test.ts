import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EmbeddingService } from '../src/embeddings';
import { DataVersionError } from '../src/migrations';
import { SearchService } from '../src/search';
import { PrivateJournalServer } from '../src/server';
import { JOURNAL_SECTIONS } from '../src/types';

const mockMigrationsRun = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/migrations', () => ({
  CURRENT_DATA_VERSION: 1,
  DataVersionError: class DataVersionError extends Error {},
  MigrationManager: jest.fn().mockImplementation(() => ({ run: mockMigrationsRun })),
}));

const remoteEnvKeys = [
  'PRIVATE_JOURNAL_GIT_REMOTE',
  'CLAUDE_PLUGIN_OPTION_GIT_REMOTE',
] as const;
const inheritedRemoteEnv = Object.fromEntries(
  remoteEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof remoteEnvKeys)[number], string | undefined>;

type RegisteredTool = {
  name: string;
  config: {
    description?: string;
    inputSchema?: Record<string, any>;
  };
  callback: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

async function collectRegisteredTools(srv: PrivateJournalServer): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = [];
  jest.spyOn((srv as any).git, 'ensureRepo').mockResolvedValue(undefined);
  jest.spyOn((srv as any).search, 'backfill').mockResolvedValue(0);
  jest.spyOn(McpServer.prototype, 'connect').mockResolvedValue(undefined as never);
  jest.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (
    this: McpServer,
    name: string,
    config: RegisteredTool['config'],
    callback: RegisteredTool['callback'],
  ) {
    tools.push({ name, config, callback });
    return {} as ReturnType<McpServer['registerTool']>;
  });

  await srv.run();
  return tools;
}

describe('PrivateJournalServer handlers', () => {
  beforeAll(() => {
    for (const key of remoteEnvKeys) delete process.env[key];
  });

  afterAll(() => {
    for (const key of remoteEnvKeys) {
      const value = inheritedRemoteEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(() => {
    mockMigrationsRun.mockClear();
    jest.restoreAllMocks();
  });

  it('keeps handlers local-only when no remote is supplied', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });

    expect((srv as any).git.enabled).toBe(false);
  });

  it('passes the normalized remote to GitSync', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir, remote: '  resolved.git  ' });

    expect((srv as any).git.remote).toBe('resolved.git');
  });

  it('handleWrite rejects empty content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });

    await expect(srv.handleWrite({ content: '   ' })).rejects.toThrow(
      'At least one journal section must have content.',
    );
  });

  it('write then read returns content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    jest.spyOn(EmbeddingService.getInstance(), 'generateEmbedding').mockResolvedValue([0.1, 0.2]);
    const srv = new PrivateJournalServer({ dataPath: dir });

    const { path: entryPath } = await srv.handleWrite({
      content: '회고 내용',
      section: 'reflections',
    });
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
      section: 'observations',
    });

    expect(searchSpy).toHaveBeenCalledWith('회고', {
      limit: 5,
      sections: ['observations'],
    });
    expect(result).toBe(expected);
  });

  it('keeps handleSearch returning SearchResult arrays for internal callers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const expected = [
      {
        path: path.join(dir, '2026-06-30', 'entry.md'),
        score: 0.863,
        excerpt: 'private-journal-mcp LLM-friendly improvement direction',
        sections: ['project_notes', 'technical_insights'],
        timestamp: Date.parse('2026-06-30T08:19:27Z'),
      },
    ];
    jest.spyOn(SearchService.prototype, 'search').mockResolvedValue(expected);
    const srv = new PrivateJournalServer({ dataPath: dir });

    const result = await srv.handleSearch({ query: 'MCP tool schema' });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(expected);
  });

  it('registers compact section-based tool schemas', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });

    const tools = await collectRegisteredTools(srv);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const writeSchema = byName.write_journal.config.inputSchema;
    const searchSchema = byName.search_journal.config.inputSchema;
    const writeSection = writeSchema?.section;
    const searchSection = searchSchema?.section;

    expect(writeSchema?.content).toBeDefined();
    expect(writeSchema?.section).toBeDefined();
    expect(writeSchema?.reflections).toBeUndefined();
    expect(writeSchema?.technical_insights).toBeUndefined();
    expect(searchSchema?.section).toBeDefined();
    expect(searchSchema?.sections).toBeUndefined();
    expect(byName.write_journal.config.description).toContain('section defaults to observations');
    expect(byName.search_journal.config.description).toContain('snippet');
    expect(byName.read_journal.config.description).toContain('full');
    expect(byName.list_journal.config.description).toContain('recent');
    expect(writeSection.unwrap().options).toEqual(JOURNAL_SECTIONS);
    expect(searchSection.unwrap().options).toEqual(JOURNAL_SECTIONS);
    expect(searchSection.safeParse('not_a_section').success).toBe(false);
  });

  it('rejects non-positive and oversized limits at the schema boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });

    const tools = await collectRegisteredTools(srv);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const searchLimit = byName.search_journal.config.inputSchema?.limit;
    const listLimit = byName.list_journal.config.inputSchema?.limit;

    for (const schema of [searchLimit, listLimit]) {
      expect(schema.safeParse(-5).success).toBe(false);
      expect(schema.safeParse(0).success).toBe(false);
      expect(schema.safeParse(1.5).success).toBe(false);
      expect(schema.safeParse(99999).success).toBe(false);
      expect(schema.safeParse(10).success).toBe(true);
    }
  });

  it('documents every journal section in the write_journal description', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });

    const tools = await collectRegisteredTools(srv);
    const description = tools.find((t) => t.name === 'write_journal')!.config.description!;

    for (const section of JOURNAL_SECTIONS) {
      expect(description).toContain(section);
    }
  });

  it('keeps write_journal MCP results as the existing JSON path shape', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });
    jest.spyOn(srv, 'handleWrite').mockResolvedValue({ path: '/tmp/journal.md' });

    const tools = await collectRegisteredTools(srv);
    const writeTool = tools.find((tool) => tool.name === 'write_journal')!;
    const result = await writeTool.callback({ content: 'note', section: 'reflections' });

    expect(JSON.parse(result.content[0].text)).toEqual({ path: '/tmp/journal.md' });
  });

  it('returns search_journal MCP results as readable markdown snippets', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });
    jest.spyOn(srv, 'handleSearch').mockResolvedValue([
      {
        path: path.join(dir, '2026-06-30', '08-19-27-207736.md'),
        score: 0.8634,
        excerpt: 'private-journal-mcp LLM-friendly improvement direction',
        sections: ['project_notes', 'technical_insights'],
        timestamp: Date.parse('2026-06-30T08:19:27Z'),
      },
    ]);

    const tools = await collectRegisteredTools(srv);
    const searchTool = tools.find((tool) => tool.name === 'search_journal')!;
    const result = await searchTool.callback({
      query: 'private-journal MCP tool schema',
      section: 'technical_insights',
    });
    const text = result.content[0].text;

    expect(text).toContain('### Journal Search Results');
    expect(text).toContain('Query: private-journal MCP tool schema');
    expect(text).toContain('Section: technical_insights');
    expect(text).toContain('Results: 1');
    expect(text).toContain('Source:');
    expect(text).toContain('Sections: project_notes, technical_insights');
    expect(text).toContain('Score: 0.863');
    expect(text).toContain('private-journal-mcp LLM-friendly improvement direction');
    expect(text).toContain('--------------------------------');
    expect(() => JSON.parse(text)).toThrow();
  });

  it('returns an LLM-friendly no-results search_journal MCP response', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });
    jest.spyOn(srv, 'handleSearch').mockResolvedValue([]);

    const tools = await collectRegisteredTools(srv);
    const searchTool = tools.find((tool) => tool.name === 'search_journal')!;
    const result = await searchTool.callback({
      query: 'missing topic',
      section: 'technical_insights',
    });
    const text = result.content[0].text;

    expect(text).toContain('### Journal Search Results');
    expect(text).toContain('Query: missing topic');
    expect(text).toContain('Section: technical_insights');
    expect(text).toContain('Results: 0');
    expect(text).toContain('Try a broader query');
  });

  it('handleList returns the written entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    jest.spyOn(EmbeddingService.getInstance(), 'generateEmbedding').mockResolvedValue([0.1, 0.2]);
    const srv = new PrivateJournalServer({ dataPath: dir });

    await srv.handleWrite({ content: '관찰', section: 'observations' });
    const list = await srv.handleList({ days: 3650 });

    expect(list).toHaveLength(1);
    expect(list[0].sections).toContain('observations');
  });

  it('does not connect the MCP transport when data migration rejects', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });
    const connect = jest.spyOn(McpServer.prototype, 'connect').mockResolvedValue(undefined as never);

    mockMigrationsRun.mockRejectedValueOnce(new DataVersionError('update required'));

    await expect(srv.run()).rejects.toThrow('update required');
    expect(connect).not.toHaveBeenCalled();
  });

  it('run performs ensureRepo, pull, migration, and backfill before connect', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir, remote: 'resolved.git' });
    const order: string[] = [];

    jest.spyOn((srv as any).git, 'ensureRepo').mockImplementation(async () => {
      order.push('ensureRepo');
    });
    jest.spyOn((srv as any).git, 'pull').mockImplementation(async () => {
      order.push('pull');
      return [];
    });
    mockMigrationsRun.mockImplementation(async () => {
      order.push('migration');
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

    expect(order).toEqual(['ensureRepo', 'pull', 'migration', 'backfill', 'connect']);
  });

  describe('handleWrite git sync', () => {
    beforeEach(() => {
      jest.spyOn(EmbeddingService.getInstance(), 'generateEmbedding').mockResolvedValue([0.1, 0.2]);
    });

    it('waits for commitAndPush before returning', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-await-'));
      const srv = new PrivateJournalServer({ dataPath: dir, remote: 'file:///nonexistent.git' });

      jest.spyOn((srv as any).git, 'ensureRepo').mockResolvedValue(undefined);
      jest.spyOn((srv as any).git, 'pull').mockResolvedValue([]);

      let finished = false;
      jest.spyOn((srv as unknown as { git: { commitAndPush: () => Promise<string[]> } }).git, 'commitAndPush')
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          finished = true;
          return [];
        });

      await srv.handleWrite({ content: 'sync test' });
      // await였다면 리턴 시점에 이미 끝났어야 한다
      expect(finished).toBe(true);
    });

    it('embeds entries pulled in by the sync', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-pulled-'));
      const srv = new PrivateJournalServer({ dataPath: dir, remote: 'file:///nonexistent.git' });
      const pulled = [path.join(dir, '2026-07-30', 'remote.md')];

      jest.spyOn((srv as any).git, 'ensureRepo').mockResolvedValue(undefined);
      jest.spyOn((srv as any).git, 'pull').mockResolvedValue([]);
      jest.spyOn((srv as unknown as { git: { commitAndPush: () => Promise<string[]> } }).git, 'commitAndPush')
        .mockResolvedValue(pulled);
      const backfillPaths = jest
        .spyOn(SearchService.prototype, 'backfillPaths')
        .mockResolvedValue(1);

      await srv.handleWrite({ content: 'local note' });

      expect(backfillPaths).toHaveBeenCalledWith(pulled);
    });

    it('does not touch embeddings when the sync pulled nothing', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-nopull-'));
      const srv = new PrivateJournalServer({ dataPath: dir, remote: 'file:///nonexistent.git' });

      jest.spyOn((srv as any).git, 'ensureRepo').mockResolvedValue(undefined);
      jest.spyOn((srv as any).git, 'pull').mockResolvedValue([]);
      jest.spyOn((srv as unknown as { git: { commitAndPush: () => Promise<string[]> } }).git, 'commitAndPush')
        .mockResolvedValue([]);
      const backfillPaths = jest.spyOn(SearchService.prototype, 'backfillPaths');

      await srv.handleWrite({ content: 'local note' });

      expect(backfillPaths).not.toHaveBeenCalled();
    });

    it('still succeeds when a synced-entry embedding fails', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-embfail-'));
      const srv = new PrivateJournalServer({ dataPath: dir, remote: 'file:///nonexistent.git' });

      jest.spyOn((srv as any).git, 'ensureRepo').mockResolvedValue(undefined);
      jest.spyOn((srv as any).git, 'pull').mockResolvedValue([]);
      jest.spyOn((srv as unknown as { git: { commitAndPush: () => Promise<string[]> } }).git, 'commitAndPush')
        .mockResolvedValue([path.join(dir, 'x.md')]);
      jest.spyOn(SearchService.prototype, 'backfillPaths')
        .mockRejectedValue(new Error('embedding exploded'));

      const result = await srv.handleWrite({ content: 'still works' });
      expect(result.path).toContain('.md');
    });

    it('still succeeds when commitAndPush rejects', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-fail-'));
      const srv = new PrivateJournalServer({ dataPath: dir, remote: 'file:///nonexistent.git' });

      jest.spyOn((srv as any).git, 'ensureRepo').mockResolvedValue(undefined);
      jest.spyOn((srv as any).git, 'pull').mockResolvedValue([]);
      jest.spyOn((srv as unknown as { git: { commitAndPush: () => Promise<void> } }).git, 'commitAndPush')
        .mockRejectedValue(new Error('remote exploded'));

      const result = await srv.handleWrite({ content: 'still works' });
      expect(result.path).toContain('.md');
    });

    it('surfaces an app-update message when sync is blocked by a newer data version', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-version-blocked-'));
      const srv = new PrivateJournalServer({ dataPath: dir, remote: 'file:///nonexistent.git' });

      jest.spyOn((srv as any).git, 'ensureRepo').mockResolvedValue(undefined);
      jest.spyOn((srv as any).git, 'pull').mockResolvedValue([]);
      jest.spyOn((srv as unknown as { git: { commitAndPush: () => Promise<void> } }).git, 'commitAndPush')
        .mockRejectedValue(new DataVersionError('Journal data version 2 is newer than this app supports (1). Update the app.'));

      await expect(srv.handleWrite({ content: 'blocked note' }))
        .rejects.toThrow('Update the app.');
    });
  });
});
