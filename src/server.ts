import * as fs from 'fs/promises';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
    void this.git.commitAndPush(`journal: ${new Date().toISOString()}`).catch((error: unknown) => {
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
    const resolvedPath = path.resolve(args.path);
    const realDataPath = await fs.realpath(this.dataPath);

    if (path.extname(resolvedPath) !== '.md') {
      throw new Error('Path must be a journal markdown file inside the data directory.');
    }

    const realTargetPath = await fs.realpath(resolvedPath);
    const stat = await fs.stat(realTargetPath);
    const relativePath = path.relative(realDataPath, realTargetPath);

    if (
      path.extname(realTargetPath) !== '.md' ||
      !stat.isFile() ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('Path must be a journal markdown file inside the data directory.');
    }

    const content = await fs.readFile(realTargetPath, 'utf8');
    return { content };
  }

  async handleList(args: ListArgs): Promise<RecentEntry[]> {
    return this.search.listRecent(args);
  }

  async run(): Promise<void> {
    await this.git.ensureRepo().catch((error: unknown) => {
      console.error('[private-journal] ensureRepo failed (best-effort):', error);
    });

    await this.search.backfill().catch((error: unknown) => {
      console.error('[private-journal] backfill failed (best-effort):', error);
    });

    const server = new McpServer({ name: 'private-journal-mcp', version: '0.1.0' });

    const toText = (result: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    });

    server.registerTool(
      'write_journal',
      {
        description: 'Write a journal entry using one or more optional sections.',
        inputSchema: Object.fromEntries(
          SECTION_KEYS.map((key) => [key, z.string().optional()]),
        ),
      },
      async (args) => toText(await this.handleWrite(args as JournalSections)),
    );

    server.registerTool(
      'search_journal',
      {
        description: 'Search journal entries semantically.',
        inputSchema: {
          query: z.string(),
          limit: z.number().optional(),
          sections: z.array(z.string()).optional(),
        },
      },
      async (args) => toText(await this.handleSearch(args as SearchArgs)),
    );

    server.registerTool(
      'read_journal',
      {
        description: 'Read a journal entry by file path.',
        inputSchema: { path: z.string() },
      },
      async (args) => toText(await this.handleRead(args as ReadArgs)),
    );

    server.registerTool(
      'list_journal',
      {
        description: 'List recent journal entries.',
        inputSchema: {
          limit: z.number().optional(),
          days: z.number().optional(),
        },
      },
      async (args) => toText(await this.handleList(args as ListArgs)),
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
