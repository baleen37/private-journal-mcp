"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrivateJournalServer = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const embeddings_1 = require("./embeddings");
const git_sync_1 = require("./git-sync");
const journal_1 = require("./journal");
const paths_1 = require("./paths");
const search_1 = require("./search");
const types_1 = require("./types");
const DEFAULT_SECTION = 'observations';
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => value.toString().padStart(2, '0');
    return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    ].join(' ');
}
function formatSection(section) {
    return section ?? 'all';
}
function formatSections(sections) {
    return sections && sections.length > 0 ? sections.join(', ') : 'none';
}
function formatSearchResults(args, results) {
    const lines = [
        '### Journal Search Results',
        '',
        `Query: ${args.query}`,
        `Section: ${formatSection(args.section)}`,
        `Results: ${results.length}`,
    ];
    if (results.length === 0) {
        lines.push('', 'No matching journal entries found.', 'Try a broader query, remove section filters, or search for related terms.');
        return lines.join('\n');
    }
    for (const [index, result] of results.entries()) {
        lines.push('', `### ${index + 1}. ${formatTimestamp(result.timestamp)}`, `Source: ${result.path}`, `Sections: ${formatSections(result.sections)}`, `Score: ${result.score.toFixed(3)}`, '', result.excerpt, '', '--------------------------------');
    }
    return lines.join('\n');
}
class PrivateJournalServer {
    dataPath;
    journal;
    search;
    git;
    constructor(opts = {}) {
        this.dataPath = opts.dataPath ?? (0, paths_1.resolveDataPath)();
        const embeddings = embeddings_1.EmbeddingService.getInstance();
        this.journal = new journal_1.JournalManager(this.dataPath, embeddings);
        this.search = new search_1.SearchService(this.dataPath, embeddings);
        this.git = new git_sync_1.GitSync(this.dataPath, opts.remote ?? process.env.PRIVATE_JOURNAL_GIT_REMOTE);
    }
    async handleWrite(args) {
        const section = args.section ?? DEFAULT_SECTION;
        const sections = { [section]: args.content };
        if (!this.journal.hasContent(sections)) {
            throw new Error('At least one journal section must have content.');
        }
        const entryPath = await this.journal.write(sections);
        void this.git.commitAndPush(`journal: ${new Date().toISOString()}`).catch((error) => {
            console.error('[private-journal] commitAndPush failed (best-effort):', error);
        });
        return { path: entryPath };
    }
    async handleSearch(args) {
        return this.search.search(args.query, {
            limit: args.limit,
            sections: args.section ? [args.section] : undefined,
        });
    }
    async handleRead(args) {
        const resolvedPath = path.resolve(args.path);
        const realDataPath = await fs.realpath(this.dataPath);
        if (path.extname(resolvedPath) !== '.md') {
            throw new Error('Path must be a journal markdown file inside the data directory.');
        }
        const realTargetPath = await fs.realpath(resolvedPath);
        const stat = await fs.stat(realTargetPath);
        const relativePath = path.relative(realDataPath, realTargetPath);
        if (path.extname(realTargetPath) !== '.md' ||
            !stat.isFile() ||
            relativePath.startsWith('..') ||
            path.isAbsolute(relativePath)) {
            throw new Error('Path must be a journal markdown file inside the data directory.');
        }
        const content = await fs.readFile(realTargetPath, 'utf8');
        return { content };
    }
    async handleList(args) {
        return this.search.listRecent(args);
    }
    async run() {
        await this.git.ensureRepo().catch((error) => {
            console.error('[private-journal] ensureRepo failed (best-effort):', error);
        });
        await this.search.backfill().catch((error) => {
            console.error('[private-journal] backfill failed (best-effort):', error);
        });
        const server = new mcp_js_1.McpServer({ name: 'private-journal-mcp', version: '0.1.0' });
        const toText = (result) => ({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
        const toPlainText = (text) => ({
            content: [{ type: 'text', text }],
        });
        server.registerTool('write_journal', {
            description: [
                'Write a durable private journal entry. section defaults to observations.',
                'Use project_notes for repo state, technical_insights for reusable fixes, and user_context for stable preferences.',
                'Returns a JSON object with the written file path.',
            ].join('\n\n'),
            inputSchema: {
                content: zod_1.z.string(),
                section: zod_1.z.enum(types_1.JOURNAL_SECTIONS).optional(),
            },
        }, async (args) => toText(await this.handleWrite(args)));
        server.registerTool('search_journal', {
            description: [
                'Search private journal entries semantically and return LLM-readable markdown snippets with source paths, sections, scores, and excerpts.',
                'Use section to narrow recall when the intent is known; omit section for broad discovery.',
            ].join('\n\n'),
            inputSchema: {
                query: zod_1.z.string(),
                limit: zod_1.z.number().optional(),
                section: zod_1.z.enum(types_1.JOURNAL_SECTIONS).optional(),
            },
        }, async (args) => {
            const searchArgs = args;
            return toPlainText(formatSearchResults(searchArgs, await this.handleSearch(searchArgs)));
        });
        server.registerTool('read_journal', {
            description: 'Read the full content of a single journal entry by file path returned from search_journal or list_journal.',
            inputSchema: { path: zod_1.z.string() },
        }, async (args) => toText(await this.handleRead(args)));
        server.registerTool('list_journal', {
            description: 'List recent journal entries with paths, dates, and sections for chronological review before reading full entries.',
            inputSchema: {
                limit: zod_1.z.number().optional(),
                days: zod_1.z.number().optional(),
            },
        }, async (args) => toText(await this.handleList(args)));
        const transport = new stdio_js_1.StdioServerTransport();
        await server.connect(transport);
    }
}
exports.PrivateJournalServer = PrivateJournalServer;
