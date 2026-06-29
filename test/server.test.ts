import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EmbeddingService } from '../src/embeddings';
import { SearchService } from '../src/search';
import { PrivateJournalServer } from '../src/server';
import { SECTION_KEYS } from '../src/types';

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

  it('registers LLM-friendly tool descriptions and section enum schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });

    const tools = await collectRegisteredTools(srv);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const searchSections = byName.search_journal.config.inputSchema?.sections;

    expect(byName.write_journal.config.description).toContain('project_notes');
    expect(byName.write_journal.config.description).toContain('technical_insights');
    expect(byName.write_journal.config.description).toContain('world_knowledge');
    expect(byName.search_journal.config.description).toContain('snippet');
    expect(byName.read_journal.config.description).toContain('full');
    expect(byName.list_journal.config.description).toContain('recent');
    expect(searchSections.unwrap().element.options).toEqual(SECTION_KEYS);
    expect(searchSections.safeParse(['not_a_section']).success).toBe(false);
  });

  it('keeps write_journal MCP results as the existing JSON path shape', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
    const srv = new PrivateJournalServer({ dataPath: dir });
    jest.spyOn(srv, 'handleWrite').mockResolvedValue({ path: '/tmp/journal.md' });

    const tools = await collectRegisteredTools(srv);
    const writeTool = tools.find((tool) => tool.name === 'write_journal')!;
    const result = await writeTool.callback({ reflections: 'note' });

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
      sections: ['technical_insights', 'project_notes'],
    });
    const text = result.content[0].text;

    expect(text).toContain('### Journal Search Results');
    expect(text).toContain('Query: private-journal MCP tool schema');
    expect(text).toContain('Sections: technical_insights, project_notes');
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
      sections: ['technical_insights'],
    });
    const text = result.content[0].text;

    expect(text).toContain('### Journal Search Results');
    expect(text).toContain('Query: missing topic');
    expect(text).toContain('Sections: technical_insights');
    expect(text).toContain('Results: 0');
    expect(text).toContain('Try a broader query');
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
