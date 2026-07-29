import * as fs from 'fs/promises';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EmbeddingService } from './embeddings';
import { GitSync } from './git-sync';
import { JournalManager } from './journal';
import { resolveDataPath, resolveGitRemote } from './paths';
import { SearchService, MAX_SEARCH_LIMIT } from './search';
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
  minScore?: number;
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
const SYNC_DEADLINE_MS = 15000;

// 잘못된 limit이 응답을 폭발시키지 않도록 스키마에서 막는다. 음수는 slice로
// 코퍼스 전체가 새고, 과대값은 컨텍스트를 넘긴다.
const boundedLimit = z.number().int().positive().max(MAX_SEARCH_LIMIT).optional();

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
    this.git = new GitSync(this.dataPath, resolveGitRemote(opts.remote));
  }

  async handleWrite(args: WriteJournalArgs): Promise<{ path: string }> {
    const section = args.section ?? DEFAULT_SECTION;
    const sections: JournalSections = { [section]: args.content };

    if (!this.journal.hasContent(sections)) {
      throw new Error('At least one journal section must have content.');
    }

    const entryPath = await this.journal.write(sections);

    // 동기화로 들어온 원격 엔트리는 임베딩이 없어 검색에서 조용히 빠진다
    // (.embedding은 git 추적 대상이 아니다). 동기화가 건드린 경로만 즉시
    // 임베딩해서 다음 재시작까지 기다리지 않게 한다. 방금 쓴 로컬 엔트리도
    // 함께 보고되지만 이미 임베딩이 있어 건너뛴다.
    const sync = this.git
      .commitAndPush(`journal: ${new Date().toISOString()}`)
      .then((synced) => this.embedSynced(synced))
      .catch((error: unknown) => {
        console.error('[private-journal] commitAndPush failed (best-effort):', error);
      });

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error('[private-journal] sync exceeded 15s; continuing in background');
        resolve();
      }, SYNC_DEADLINE_MS);
    });
    await Promise.race([sync, deadline]);
    clearTimeout(timer);

    return { path: entryPath };
  }

  private async embedSynced(synced: string[]): Promise<void> {
    if (synced.length === 0) return;
    try {
      const created = await this.search.backfillPaths(synced);
      if (created > 0) {
        console.error(`[private-journal] embedded ${created} synced entry(ies)`);
      }
    } catch (error: unknown) {
      console.error('[private-journal] embedding synced entries failed (best-effort):', error);
    }
  }

  async handleSearch(args: SearchArgs): Promise<SearchResult[]> {
    return this.search.search(args.query, {
      limit: args.limit,
      sections: args.section ? [args.section] : undefined,
      minScore: args.minScore,
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
          [
            'Pick the section by what the note is about:',
            '- project_notes: current repo/task state, decisions, and where work stands.',
            '- technical_insights: reusable fixes, root causes, and gotchas worth recalling later.',
            '- user_context: stable preferences and working style of the person you assist.',
            '- observations: raw findings from this session that are not yet generalized.',
            '- reflections: retrospectives on how the work went and what to change next time.',
            '- world_knowledge: durable facts about systems or the world outside this repo.',
          ].join('\n'),
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
          'Scores are cosine similarities from a multilingual-e5 model and cluster in a narrow band (~0.80-0.89), so a high score alone does not mean an entry is relevant. Always judge relevance from the excerpt text, and treat small score gaps as noise. minScore is available but has no reliable universal cutoff.',
        ].join('\n\n'),
        inputSchema: {
          query: z.string(),
          limit: boundedLimit,
          section: z.enum(JOURNAL_SECTIONS).optional(),
          minScore: z.number().min(0).max(1).optional(),
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
          limit: boundedLimit,
          days: z.number().int().positive().max(3650).optional(),
        },
      },
      async (args) => toText(await this.handleList(args as ListArgs)),
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
