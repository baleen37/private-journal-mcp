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
import {
  JournalSection,
  JournalSections,
  RecentEntry,
  SearchResult,
  JOURNAL_SECTIONS,
} from './types';

interface SearchArgs {
  query: string;
  limit?: number;
  section?: JournalSection;
}

interface WriteJournalArgs {
  content: string;
  section?: JournalSection;
}

interface ReadArgs {
  path: string;
}

interface ListArgs {
  limit?: number;
  days?: number;
}

const DEFAULT_SECTION: JournalSection = 'observations';

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ');
}

function formatSection(section?: string): string {
  return section ?? 'all';
}

function formatSections(sections?: string[]): string {
  return sections && sections.length > 0 ? sections.join(', ') : 'none';
}

function formatSearchResults(args: SearchArgs, results: SearchResult[]): string {
  const lines = [
    '### Journal Search Results',
    '',
    `Query: ${args.query}`,
    `Section: ${formatSection(args.section)}`,
    `Results: ${results.length}`,
  ];

  if (results.length === 0) {
    lines.push(
      '',
      'No matching journal entries found.',
      'Try a broader query, remove section filters, or search for related terms.',
    );
    return lines.join('\n');
  }

  for (const [index, result] of results.entries()) {
    lines.push(
      '',
      `### ${index + 1}. ${formatTimestamp(result.timestamp)}`,
      `Source: ${result.path}`,
      `Sections: ${formatSections(result.sections)}`,
      `Score: ${result.score.toFixed(3)}`,
      '',
      result.excerpt,
      '',
      '--------------------------------',
    );
  }

  return lines.join('\n');
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

  async handleWrite(args: WriteJournalArgs): Promise<{ path: string }> {
    const section = args.section ?? DEFAULT_SECTION;
    const sections: JournalSections = { [section]: args.content };

    if (!this.journal.hasContent(sections)) {
      throw new Error('At least one journal section must have content.');
    }

    const entryPath = await this.journal.write(sections);
    void this.git.commitAndPush(`journal: ${new Date().toISOString()}`).catch((error: unknown) => {
      console.error('[private-journal] commitAndPush failed (best-effort):', error);
    });

    return { path: entryPath };
  }

  async handleSearch(args: SearchArgs): Promise<SearchResult[]> {
    return this.search.search(args.query, {
      limit: args.limit,
      sections: args.section ? [args.section] : undefined,
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
    const toPlainText = (text: string) => ({
      content: [{ type: 'text' as const, text }],
    });

    server.registerTool(
      'write_journal',
      {
        description: [
          'Write a durable private journal entry. section defaults to observations.',
          'Use project_notes for repo state, technical_insights for reusable fixes, and user_context for stable preferences.',
          'Returns a JSON object with the written file path.',
        ].join('\n\n'),
        inputSchema: {
          content: z.string(),
          section: z.enum(JOURNAL_SECTIONS).optional(),
        },
      },
      async (args) => toText(await this.handleWrite(args as WriteJournalArgs)),
    );

    server.registerTool(
      'search_journal',
      {
        description: [
          'Search private journal entries semantically and return LLM-readable markdown snippets with source paths, sections, scores, and excerpts.',
          'Use section to narrow recall when the intent is known; omit section for broad discovery.',
        ].join('\n\n'),
        inputSchema: {
          query: z.string(),
          limit: z.number().optional(),
          section: z.enum(JOURNAL_SECTIONS).optional(),
        },
      },
      async (args) => {
        const searchArgs = args as SearchArgs;
        return toPlainText(formatSearchResults(searchArgs, await this.handleSearch(searchArgs)));
      },
    );

    server.registerTool(
      'read_journal',
      {
        description: 'Read the full content of a single journal entry by file path returned from search_journal or list_journal.',
        inputSchema: { path: z.string() },
      },
      async (args) => toText(await this.handleRead(args as ReadArgs)),
    );

    server.registerTool(
      'list_journal',
      {
        description: 'List recent journal entries with paths, dates, and sections for chronological review before reading full entries.',
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
