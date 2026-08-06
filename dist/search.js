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
exports.SearchService = exports.MAX_SEARCH_LIMIT = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const index_db_1 = require("./index-db");
const journal_1 = require("./journal");
exports.MAX_SEARCH_LIMIT = 50;
const DEFAULT_LIMIT = 10;
function clampLimit(limit) {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
        return DEFAULT_LIMIT;
    return Math.min(Math.floor(limit), exports.MAX_SEARCH_LIMIT);
}
class SearchService {
    embeddings;
    dataPath;
    index;
    constructor(dataPath, embeddings) {
        this.embeddings = embeddings;
        this.dataPath = path.resolve(dataPath);
        this.index = (0, index_db_1.openJournalIndex)(this.dataPath);
    }
    needsInitialBackfill() {
        return !this.index.isComplete();
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
            for (const entry of entries) {
                const target = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '.git')
                        continue;
                    await walk(target);
                }
                else if (entry.name.endsWith('.md') && await isSafeMarkdownFile(target)) {
                    out.push(target);
                }
            }
        };
        await walk(this.dataPath);
        return out;
    }
    resolveInsideDataPath(mdPath) {
        const absolute = path.resolve(mdPath);
        const relative = path.relative(this.dataPath, absolute);
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || !absolute.endsWith('.md')) {
            return null;
        }
        return absolute;
    }
    async isSafeMarkdownPath(mdPath) {
        const absolute = this.resolveInsideDataPath(mdPath);
        if (!absolute)
            return false;
        try {
            const stat = await fs.lstat(absolute);
            if (!stat.isFile())
                return false;
            const [rootPath, realPath] = await Promise.all([
                fs.realpath(this.dataPath),
                fs.realpath(absolute),
            ]);
            const relative = path.relative(rootPath, realPath);
            return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        }
        catch {
            return false;
        }
    }
    async search(query, opts = {}) {
        const qVec = await this.embeddings.generateEmbedding(query, 'query');
        return this.index.search(qVec, {
            limit: clampLimit(opts.limit),
            sections: opts.sections,
            minScore: opts.minScore,
        });
    }
    async listRecent(opts = {}) {
        const limit = clampLimit(opts.limit);
        const days = opts.days ?? 30;
        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        return this.index.listRecent(cutoffMs, limit);
    }
    async indexPath(mdPath) {
        const absolute = this.resolveInsideDataPath(mdPath);
        if (!absolute || !(await this.isSafeMarkdownPath(absolute)))
            return false;
        const stat = await fs.stat(absolute);
        const currentMtime = this.index.getSourceMtime(absolute);
        const currentEmbeddingVersion = this.index.getEmbeddingVersion(absolute);
        if (currentMtime === stat.mtimeMs && currentEmbeddingVersion === index_db_1.INDEX_EMBEDDING_REVISION)
            return false;
        try {
            const md = await fs.readFile(absolute, 'utf8');
            const frontmatter = (0, journal_1.parseFrontmatter)(md);
            const text = this.embeddings.extractSearchableText(md);
            const embedding = await this.embeddings.generateEmbedding(text, 'passage');
            this.index.upsert({
                path: absolute,
                title: frontmatter.title,
                date: frontmatter.created_at,
                timestamp: frontmatter.timestamp,
                sections: (0, journal_1.parseSections)(md),
                excerpt: text.slice(0, 200),
                sourceMtime: stat.mtimeMs,
                embeddingVersion: index_db_1.INDEX_EMBEDDING_REVISION,
                embedding,
            });
            return true;
        }
        catch (error) {
            console.error('[private-journal] index failed for', absolute, error);
            return false;
        }
    }
    async removePath(mdPath) {
        const absolute = this.resolveInsideDataPath(mdPath);
        if (absolute)
            this.index.removeByPath(absolute);
    }
    async backfill() {
        const files = await this.listEntryFiles();
        const currentPaths = new Set(files);
        for (const indexedPath of this.index.getIndexedPaths()) {
            if (!currentPaths.has(indexedPath))
                this.index.removeByPath(indexedPath);
        }
        let indexed = 0;
        let complete = true;
        for (const mdPath of files) {
            if (await this.indexPath(mdPath))
                indexed++;
            let stat;
            try {
                stat = await fs.stat(mdPath);
            }
            catch {
                complete = false;
                continue;
            }
            if (!this.index.isEntryCurrent(mdPath, stat.mtimeMs, index_db_1.INDEX_EMBEDDING_REVISION))
                complete = false;
        }
        if (complete)
            this.index.markComplete();
        return indexed;
    }
    async backfillPaths(mdPaths) {
        let indexed = 0;
        for (const mdPath of mdPaths) {
            const absolute = this.resolveInsideDataPath(mdPath);
            if (!absolute)
                continue;
            if (await fs.access(absolute).then(() => true).catch(() => false)) {
                if (await this.indexPath(absolute))
                    indexed++;
            }
            else {
                await this.removePath(absolute);
            }
        }
        return indexed;
    }
    close() {
        this.index.close();
    }
}
exports.SearchService = SearchService;
