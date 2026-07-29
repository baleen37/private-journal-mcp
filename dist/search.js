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
const journal_1 = require("./journal");
exports.MAX_SEARCH_LIMIT = 50;
const DEFAULT_LIMIT = 10;
// 음수/0/과대 limit이 slice로 새는 것을 막는다. slice(0, -1)은 "마지막 하나만
// 제외한 전부"라서, 검증 없이 넘기면 코퍼스 전체가 응답으로 나간다.
function clampLimit(limit) {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
        return DEFAULT_LIMIT;
    return Math.min(Math.floor(limit), exports.MAX_SEARCH_LIMIT);
}
// 엔트리 경로는 `YYYY-MM-DD/HH-MM-SS-micro.md`라 문자열 정렬이 곧 시간순이다.
// 파일을 열지 않고도 날짜 컷오프와 최신순 정렬을 할 수 있다.
function dayFromEntryPath(mdPath) {
    const day = path.basename(path.dirname(mdPath));
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}
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
        const limit = clampLimit(opts.limit);
        const minScore = opts.minScore;
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
            if (minScore !== undefined && score < minScore)
                continue;
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
        const limit = clampLimit(opts.limit);
        const days = opts.days ?? 30;
        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const files = await this.listEntryFiles();
        // 날짜 디렉토리 기준으로 먼저 걸러낸다. 로컬/UTC 경계 때문에 하루 여유를
        // 두고, 정확한 컷오프는 frontmatter timestamp로 아래에서 확정한다.
        const cutoffDay = new Date(cutoffMs - 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);
        const candidates = files.filter((mdPath) => {
            const day = dayFromEntryPath(mdPath);
            return day === undefined || day >= cutoffDay;
        });
        // 경로 정렬이 곧 시간순이므로, 최신부터 필요한 개수만 읽는다.
        candidates.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        const entries = [];
        for (const mdPath of candidates) {
            if (entries.length >= limit)
                break;
            let md;
            try {
                md = await fs.readFile(mdPath, 'utf8');
            }
            catch {
                continue;
            }
            const fm = (0, journal_1.parseFrontmatter)(md);
            if (fm.timestamp < cutoffMs)
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
        return entries;
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
