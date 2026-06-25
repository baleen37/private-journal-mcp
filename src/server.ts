import * as fs from 'fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EmbeddingService } from './embeddings';
import { GitSync } from './git-sync';
import { JournalManager } from './journal';
import { resolveDataPath } from './paths';
import { SearchService } from './search';
import { JournalSections, RecentEntry, SearchResult, SECTION_KEYS } from './types';

interface SearchArgs {
  query: string;
  limit?: number;
  sections?: string[];
}

interface ReadArgs {
  path: string;
}

interface ListArgs {
  limit?: number;
  days?: number;
}

export class PrivateJournalServer {
  private readonly dataPath: string;
  private readonly journal: JournalManager;
  private readonly search: SearchService;
  private readonly git: GitSync;

  constructor(opts: { dataPath?: string; remote?: string } = {}) {
    this.dataPath = opts.dataPath ?? resolveDataPath();
    const embeddings = EmbeddingService.getInstance();
    this.journal = new JournalManager(this.dataPath, embeddings);
    this.search = new SearchService(this.dataPath, embeddings);
    this.git = new GitSync(this.dataPath, opts.remote ?? process.env.PRIVATE_JOURNAL_GIT_REMOTE);
  }

  async handleWrite(args: JournalSections): Promise<{ path: string }> {
    if (!this.journal.hasContent(args)) {
      throw new Error('At least one journal section must have content.');
    }

    const entryPath = await this.journal.write(args);
    await this.git.commitAndPush(`journal: ${new Date().toISOString()}`).catch((error: unknown) => {
      console.error('[private-journal] commitAndPush failed (best-effort):', error);
    });

    return { path: entryPath };
  }

  async handleSearch(args: SearchArgs): Promise<SearchResult[]> {
    return this.search.search(args.query, {
      limit: args.limit,
      sections: args.sections,
    });
  }

  async handleRead(args: ReadArgs): Promise<{ content: string }> {
    const content = await fs.readFile(args.path, 'utf8');
    return { content };
  }

  async handleList(args: ListArgs): Promise<RecentEntry[]> {
    return this.search.listRecent(args);
  }

  async run(): Promise<void> {
    await this.search.backfill().catch((error: unknown) => {
      console.error('[private-journal] backfill failed (best-effort):', error);
    });

    const server = new Server(
      { name: 'private-journal-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'write_journal',
          description: 'Write a journal entry using one or more optional sections.',
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(SECTION_KEYS.map((key) => [key, { type: 'string' }])),
          },
        },
        {
          name: 'search_journal',
          description: 'Search journal entries semantically.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' },
              sections: { type: 'array', items: { type: 'string' } },
            },
            required: ['query'],
          },
        },
        {
          name: 'read_journal',
          description: 'Read a journal entry by file path.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
        {
          name: 'list_journal',
          description: 'List recent journal entries.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number' },
              days: { type: 'number' },
            },
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      let result: unknown;

      switch (name) {
        case 'write_journal':
          result = await this.handleWrite(args as JournalSections);
          break;
        case 'search_journal':
          result = await this.handleSearch(args as unknown as SearchArgs);
          break;
        case 'read_journal':
          result = await this.handleRead(args as unknown as ReadArgs);
          break;
        case 'list_journal':
          result = await this.handleList(args as unknown as ListArgs);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    });

    await this.git.ensureRepo().catch((error: unknown) => {
      console.error('[private-journal] ensureRepo failed (best-effort):', error);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
