import serverModule from './dist/server.js';
import searchModule from './dist/search.js';
import typesModule from './dist/types.js';
import { z } from 'zod';

const { PrivateJournalServer, formatSearchResults } = serverModule;
const { MAX_SEARCH_LIMIT } = searchModule;
const { JOURNAL_SECTIONS } = typesModule;
const boundedLimit = z.number().int().positive().max(MAX_SEARCH_LIMIT).optional();
const section = z.enum(JOURNAL_SECTIONS).optional();

const toJson = (value) => JSON.stringify(value, null, 2);

export function createTools(journal) {
  return {
    write_journal: {
      description: [
        'Write a durable private journal entry with a meaningful title. section defaults to observations.',
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
      args: {
        title: z.string().trim().min(1),
        content: z.string(),
        section,
      },
      async execute(args) {
        return toJson(await journal.handleWrite(args));
      },
    },
    search_journal: {
      description: [
        'Search private journal entries semantically and return LLM-readable markdown snippets with source paths, sections, scores, and excerpts.',
        'Use section to narrow recall when the intent is known; omit section for broad discovery.',
        'Scores are cosine similarities from a multilingual-e5 model and cluster in a narrow band (~0.80-0.89), so a high score alone does not mean an entry is relevant. Always judge relevance from the excerpt text, and treat small score gaps as noise. minScore is available but has no reliable universal cutoff.',
      ].join('\n\n'),
      args: {
        query: z.string(),
        limit: boundedLimit,
        section,
        minScore: z.number().min(0).max(1).optional(),
      },
      async execute(args) {
        const results = await journal.handleSearch(args);
        return formatSearchResults(args, results);
      },
    },
    read_journal: {
      description: 'Read the full content of a single journal entry by file path returned from search_journal or list_journal.',
      args: { path: z.string() },
      async execute(args) {
        return toJson(await journal.handleRead(args));
      },
    },
    list_journal: {
      description: 'List recent journal entries with paths, dates, and sections for chronological review before reading full entries.',
      args: {
        limit: boundedLimit,
        days: z.number().int().positive().max(3650).optional(),
      },
      async execute(args) {
        return toJson(await journal.handleList(args));
      },
    },
  };
}

export async function PrivateJournalPlugin() {
  const journal = new PrivateJournalServer();
  await journal.initialize();
  return { tool: createTools(journal) };
}

export default {
  id: 'private-journal-mcp',
  server: PrivateJournalPlugin,
};
