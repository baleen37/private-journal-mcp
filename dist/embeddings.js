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
exports.EmbeddingService = void 0;
const fs = __importStar(require("fs/promises"));
const paths_1 = require("./paths");
const MODEL = 'Xenova/multilingual-e5-small';
const LOAD_TIMEOUT_MS = 30_000;
class EmbeddingService {
    static instance;
    extractor = null;
    loading = null;
    static getInstance() {
        if (!EmbeddingService.instance)
            EmbeddingService.instance = new EmbeddingService();
        return EmbeddingService.instance;
    }
    cosineSimilarity(a, b) {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (na === 0 || nb === 0)
            return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
    extractSearchableText(md) {
        const withoutFm = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
        return withoutFm.replace(/^##\s+/gm, '').trim();
    }
    embeddingPathFor(mdPath) {
        return mdPath.replace(/\.md$/, '.embedding');
    }
    async saveEmbedding(mdPath, data) {
        await fs.writeFile(this.embeddingPathFor(mdPath), JSON.stringify(data), 'utf8');
    }
    async loadEmbedding(mdPath) {
        try {
            const raw = await fs.readFile(this.embeddingPathFor(mdPath), 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async getExtractor() {
        if (this.extractor)
            return this.extractor;
        if (!this.loading) {
            this.loading = (async () => {
                try {
                    const { pipeline, env } = await Promise.resolve().then(() => __importStar(require('@huggingface/transformers')));
                    env.cacheDir = (0, paths_1.resolveModelCachePath)();
                    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('embedding model load timed out')), LOAD_TIMEOUT_MS));
                    this.extractor = await Promise.race([
                        pipeline('feature-extraction', MODEL),
                        timeout,
                    ]);
                    return this.extractor;
                }
                catch (e) {
                    this.loading = null;
                    throw e;
                }
            })();
        }
        return this.loading;
    }
    async generateEmbedding(text, kind) {
        const extractor = await this.getExtractor();
        const prefixed = `${kind}: ${text}`;
        const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }
}
exports.EmbeddingService = EmbeddingService;
