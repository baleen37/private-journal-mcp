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
exports.SearchService = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const journal_1 = require("./journal");
class SearchService {
    dataPath;
    embeddings;
    constructor(dataPath, embeddings) {
        this.dataPath = dataPath;
        this.embeddings = embeddings;
    }
    async listEntryFiles() {
        const out = [];
        const rootPath = await fs.realpath(this.dataPath).catch(() => this.dataPath);
        const isSafeMarkdownFile = async (filePath) => {
            let stat;
            try {
                stat = await fs.lstat(filePath);
            }
            catch {
                return false;
            }
            if (!stat.isFile())
                return false;
            let realPath;
            try {
                realPath = await fs.realpath(filePath);
            }
            catch {
                return false;
            }
            const relative = path.relative(rootPath, realPath);
            return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        };
        const walk = async (dir) => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === '.git')
                        continue;
                    await walk(p);
                }
                else if (e.name.endsWith('.md') && await isSafeMarkdownFile(p)) {
                    out.push(p);
                }
            }
        };
        await walk(this.dataPath);
        return out;
    }
    async search(query, opts = {}) {
        const limit = opts.limit ?? 10;
        const qVec = await this.embeddings.generateEmbedding(query, 'query');
        const files = await this.listEntryFiles();
        const scored = [];
        for (const mdPath of files) {
            const data = await this.embeddings.loadEmbedding(mdPath);
            if (!data)
                continue;
            if (opts.sections && opts.sections.length > 0) {
                const overlap = data.sections.some((s) => opts.sections.includes(s));
                if (!overlap)
                    continue;
            }
            const score = this.embeddings.cosineSimilarity(qVec, data.embedding);
            scored.push({
                path: mdPath,
                score,
                excerpt: data.text.slice(0, 200),
                sections: data.sections,
                timestamp: data.timestamp,
            });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit);
    }
    async listRecent(opts = {}) {
        const limit = opts.limit ?? 10;
        const days = opts.days ?? 30;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const files = await this.listEntryFiles();
        const entries = [];
        for (const mdPath of files) {
            const md = await fs.readFile(mdPath, 'utf8');
            const fm = (0, journal_1.parseFrontmatter)(md);
            if (fm.timestamp < cutoff)
                continue;
            entries.push({
                path: mdPath,
                title: fm.title,
                date: fm.date,
                timestamp: fm.timestamp,
                sections: (0, journal_1.parseSections)(md),
            });
        }
        entries.sort((a, b) => b.timestamp - a.timestamp);
        return entries.slice(0, limit);
    }
    async backfill() {
        const files = await this.listEntryFiles();
        let created = 0;
        for (const mdPath of files) {
            const existing = await this.embeddings.loadEmbedding(mdPath);
            if (existing)
                continue;
            try {
                const md = await fs.readFile(mdPath, 'utf8');
                const fm = (0, journal_1.parseFrontmatter)(md);
                const text = this.embeddings.extractSearchableText(md);
                const vector = await this.embeddings.generateEmbedding(text, 'passage');
                const data = {
                    embedding: vector,
                    text,
                    sections: (0, journal_1.parseSections)(md),
                    timestamp: fm.timestamp,
                    path: mdPath,
                };
                await this.embeddings.saveEmbedding(mdPath, data);
                created++;
            }
            catch (err) {
                console.error('[private-journal] backfill failed for', mdPath, err);
            }
        }
        return created;
    }
}
exports.SearchService = SearchService;
